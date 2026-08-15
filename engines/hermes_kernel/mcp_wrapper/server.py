"""TORQCLAW Hermes Engine — Streamable HTTP MCP server (NOT legacy SSE;
HTTP+SSE was deprecated in protocol rev 2025-03-26).

Binds 127.0.0.1 by default. When splitting onto a separate GPU box, front it
with Tailscale or set HERMES_ENGINE_TOKEN and a reverse proxy — never bare
0.0.0.0 (the OpenClaw exposed-default-port incident class)."""
import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import skill_queue, skill_rollback, task_store
from .contracts import validate_gateway_request
from . import failover_runtime
from . import governed_skills, skill_sources

@asynccontextmanager
async def _resilience_lifespan(_server):
    """Checkpoint only after FastMCP has stopped accepting requests."""
    try:
        yield {}
    finally:
        await asyncio.to_thread(failover_runtime.shutdown_for_tests)


mcp = FastMCP(
    "torqclaw-hermes-engine",
    host=os.environ.get("HERMES_BIND_HOST", "127.0.0.1"),
    port=int(os.environ.get("HERMES_PORT", "8000")),
    lifespan=_resilience_lifespan,
)


def _resilience_task(payload: dict) -> bool:
    inner = payload.get("payload", {})
    active = (payload.get("activeTuple") or payload.get("resilienceActiveTuple")
              or payload.get("active") or inner.get("activeTuple")
              or inner.get("resilienceActiveTuple"))
    return active is not None and failover_runtime.frontier_active(payload)


def _finish_internal_observation(task_id: str, observation: dict, *, result: str = "",
                                 telemetry: dict | None = None) -> None:
    """Persist only normalized internal status; the ledger never receives rich data."""
    task_store.finish_observation(
        task_id,
        {"kind": "result", **observation},
        result=result,
        telemetry={
            "resilience": True,
            "normalizedFailure": observation if observation.get("failureClass") else None,
            **(telemetry or {}),
        },
    )
def _get_hermes_available() -> bool:
    try:
        from .hermes_runner import hermes_available

        hermes_available_now, _reason = hermes_available()
        return hermes_available_now
    except Exception:  # pragma: no cover - defensive import boundary
        return False


def _health_payload() -> dict[str, object]:
    """Return the fixed, secret-free engine readiness contract."""
    model_configured = bool(os.environ.get("HERMES_MODEL", "").strip())
    hermes_available_now = _get_hermes_available()
    live = model_configured and hermes_available_now
    return {
        "service": "torqclaw-hermes-engine",
        "status": "ready",
        "mode": "live" if live else "stub",
        "modelConfigured": model_configured,
        "hermesAvailable": hermes_available_now,
    }


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse(_health_payload())


async def run_hermes_loop(task_id: str, payload: dict) -> None:
    """Real Hermes execution via mcp_wrapper.hermes_runner (callbacks ->
    cursor events). Falls back to a labeled stub when the vendored agent
    or its provider config isn't available, so the pipeline stays testable.

    Explicit live configuration must never silently degrade into a fabricated
    success. Stub mode remains available only when no live model is configured
    (used by deterministic contract tests)."""
    from .hermes_runner import hermes_available, normalize_provider_failure, run_hermes_sync
    resilience_task = _resilience_task(payload)
    provider_ref = payload.get("providerRef")
    resilience_live_configured = (
        resilience_task and isinstance(provider_ref, dict) and
        bool(provider_ref.get("modelId"))
    )
    live_configured = bool(os.environ.get("HERMES_MODEL")) or resilience_live_configured

    try:
        prompt = payload["payload"]["prompt"]
        task_type = payload["payload"]["taskType"]
        available, why = hermes_available()

        if available and live_configured:
            task_store.emit(
                task_id, "SYSTEM", f"Hermes agent booted for {task_type}",
                {"audience": "operator"},
            )
            # run_conversation is synchronous — never block the event loop.
            out = await asyncio.to_thread(run_hermes_sync, task_id, payload)
            tele = out.get("telemetry", {})
            # Per-tool approval block (FRONTIER): a write-capable tool was hit
            # without a grant. End as 'blocked' so the gateway emits the single
            # terminal PENDING_APPROVAL and the operator can Allow once (re-run).
            blocked_on = tele.get("blockedOn")
            if blocked_on:
                task_store.emit(
                    task_id, "PENDING_APPROVAL",
                    f"Tool {blocked_on} requires approval",
                    {"toolName": blocked_on, "args": tele.get("blockedArgs", {})},
                )
                if resilience_task:
                    task_store.fail(task_id, "normalized_failure", {
                        "failureClass": "side_effect_uncertainty",
                        "code": "approval_blocked", "retryable": False,
                    })
                else:
                    task_store.complete(task_id, "", {"blockedOn": blocked_on})
                return
            # null cost = breaker is blind; say so once, never report 0.00.
            if tele.get("costUsd") is None:
                task_store.emit(
                    task_id, "SYSTEM",
                    "Spend reporting unavailable for this provider — budget "
                    "cannot be enforced; the iteration cap "
                    "(HERMES_MAX_ITERATIONS) is the only guard.",
                    {"audience": "operator"},
                )
            if resilience_task:
                _finish_internal_observation(
                    task_id,
                    {"failureClass": "terminal", "code": "completed", "retryable": False},
                    result=out.get("result", ""),
                    telemetry=out.get("telemetry", {}),
                )
            else:
                task_store.complete(task_id, out["result"], out["telemetry"])
            return

        reason = why or "HERMES_MODEL unset"
        if live_configured:
            if resilience_task:
                failure = {"failureClass": "terminal", "code": "engine_failure", "retryable": False}
                task_store.emit(task_id, "ERROR", "Hermes provider is unavailable")
                task_store.fail(task_id, "normalized_failure", {"normalizedFailure": failure})
            else:
                error = f"Hermes unavailable; refusing stub response: {reason}"
                task_store.emit(task_id, "ERROR", error)
                task_store.fail(task_id, error)
            return

        task_store.emit(task_id, "SYSTEM", f"STUB MODE ({reason}) for {task_type}")

        # E2E seam: simulate the FRONTIER per-tool approval block deterministically
        # (no live model). Mirrors the LOCAL_EDGE force-gate; honors the grant so
        # the APPROVE re-run proceeds. Inert unless the env var is set.
        forced = os.environ.get("TORQCLAW_E2E_FORCE_GATED_TOOL")
        if forced:
            granted = payload["payload"].get("grantedTools", []) or []
            if forced not in granted:
                task_store.emit(
                    task_id, "PENDING_APPROVAL", f"Tool {forced} requires approval",
                    {"toolName": forced, "args": {"e2e": True}},
                )
                task_store.complete(task_id, "", {"blockedOn": forced})
                return
            task_store.emit(task_id, "TOOL_CALL", f"Executing {forced}", {"granted": True})
            task_store.complete(
                task_id, f"[e2e] executed {forced} under grant",
                {"engineUsed": "hermes-stub", "costUsd": 0.0},
            )
            return

        from .hermes_runner import get_spend_usd

        cost, _src = get_spend_usd(None, task_id)  # stub: HERMES_STUB_COST_* flags
        if cost is None:
            task_store.emit(
                task_id, "SYSTEM",
                "Spend reporting unavailable for this provider — budget cannot "
                "be enforced; the iteration cap (HERMES_MAX_ITERATIONS) is the "
                "only guard.",
                {"audience": "operator"},
            )
        # Configurable so e2e-budget can hold the task open across a poll.
        await asyncio.sleep(float(os.environ.get("HERMES_STUB_DELAY_S", "1")))
        if task_store.state_of(task_id) != "running":
            return  # cancelled mid-sleep (budget breaker or user cancel)
        forced = os.environ.get("TORQCLAW_E2E_STUB_FAILURE", "")
        provider_id = str(payload.get("providerRef", {}).get("providerId", ""))
        if forced.startswith(provider_id + ":"):
            raise RuntimeError(forced.split(":", 1)[1])
        task_store.complete(
            task_id,
            f"[stub] Hermes processed: {prompt[:120]}",
            {"engineUsed": "hermes-stub", "costUsd": cost, "costSource": _src,
             "dispatchAttempted": False},
        )
    except Exception as exc:  # noqa: BLE001
        if resilience_task:
            forced = os.environ.get("TORQCLAW_E2E_STUB_FAILURE", "")
            provider_id = str(payload.get("providerRef", {}).get("providerId", ""))
            if forced.startswith(provider_id + ":"):
                failure_code = forced.split(":", 1)[1].strip().lower()
                failure = (
                    {"failureClass": "retryable", "code": failure_code, "retryable": True}
                    if failure_code in failover_runtime._FAILURE_CODES else
                    {"failureClass": "terminal", "code": "unknown", "retryable": False}
                )
            else:
                failure = normalize_provider_failure(exc)
            task_store.fail(task_id, "normalized_failure", {
                "normalizedFailure": failure,
            })
        else:
            task_store.fail(task_id, str(exc))


@mcp.tool()
async def submit_task(payload: dict) -> dict:
    """Validate -> persist -> spawn -> return immediately. A deep loop runs
    minutes-to-hours; an awaited MCP call would hold the stream hostage."""
    validate_gateway_request(payload)  # raises -> MCP isError, never a success string
    task_id = task_store.create(payload)
    asyncio.get_event_loop().create_task(run_hermes_loop(task_id, payload))
    return {"task_id": task_id, "state": "running"}


@mcp.tool()
async def resilience_admit_frontier(request_id: str, immutable_plan: dict,
                                    deadline_at: int, provider_order: list[str]) -> dict:
    """Admit one immutable two-provider FRONTIER plan."""
    with failover_runtime.request_scope():
        return failover_runtime.admit_frontier(request_id, immutable_plan, deadline_at, provider_order)


@mcp.tool()
async def resilience_submit_attempt(payload: dict, immutable_plan: dict, active: dict,
                                   provider_ref: dict, attempt_deadline_ms: int,
                                   idempotency_key: str) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.submit_attempt(
            payload, immutable_plan, active, provider_ref, attempt_deadline_ms, idempotency_key,
        )


@mcp.tool()
async def resilience_poll_observations(active: dict, cursor: int,
                                      attempt_deadline_ms: int) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.poll_observations(active, cursor, attempt_deadline_ms)


@mcp.tool()
async def resilience_record_observation(active: dict, normalized_observation: dict,
                                       idempotency_key: str) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.record_observation(active, normalized_observation, idempotency_key)


@mcp.tool()
async def resilience_finalize_attempt(active: dict, normalized_failure: dict,
                                      failure_source: str, terminal_outcome: str,
                                      idempotency_key: str) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.finalize_attempt(
            active, normalized_failure, failure_source, terminal_outcome,
            idempotency_key,
        )


@mcp.tool()
async def resilience_transition_once(active: dict, successor_provider_id: str,
                                     normalized_failure: dict, jitter_ms: int,
                                     plan_hash: str | None = None,
                                     idempotency_key: str | None = None,
                                     failure_source: str | None = None,
                                     observation_idempotency_key: str | None = None) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.transition_once(
            active, successor_provider_id, normalized_failure, jitter_ms, plan_hash, idempotency_key,
            failure_source, observation_idempotency_key,
        )


@mcp.tool()
async def resilience_request_cancel(active: dict, cancel_id: str) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.request_cancel(active, cancel_id)


@mcp.tool()
async def resilience_recover_and_transition_once(active: dict, recovery_id: str,
                                                  jitter_ms: int,
                                                  normalized_failure: dict) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.recover_and_transition_once(active, recovery_id, jitter_ms, normalized_failure)


@mcp.tool()
async def resilience_get_status(task_id: str) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.get_status(task_id)


@mcp.tool()
async def resilience_page_outbox(after_cursor: int = 0, limit: int = 100) -> dict:
    with failover_runtime.request_scope():
        return failover_runtime.page_outbox(after_cursor, limit)


@mcp.tool()
async def attempt_timeout(active: dict, timeout_ms: int = 2_000) -> dict:
    """Attempt-level stop acknowledgement; never operator cancellation.

    The gateway owns the subsequent transition. This handler only supplies a
    bounded, exact-tuple/fence-checked acknowledgement or closes uncertainty.
    """
    timeout_id = None
    if isinstance(active, dict) and {"taskId", "attemptId", "epoch"}.issubset(active):
        timeout_id = f"{active['taskId']}:{active['attemptId']}:{active['epoch']}:attempt-timeout"
    with failover_runtime.request_scope():
        return failover_runtime.attempt_timeout(active, timeout_id=timeout_id, timeout_ms=timeout_ms)


@mcp.tool()
async def get_task_status(task_id: str, since: int = 0) -> dict:
    """Incremental events after cursor `since` — the gateway relay pump.
    For a still-running task, injects live cost so the bridge's circuit
    breaker can act between polls (costUsd: null = unenforceable, never 0)."""
    from .hermes_runner import RUNNING, get_spend_usd

    status = task_store.status(task_id, since)
    if status.get("state") == "running":
        agent = RUNNING.get(task_id)
        # agent is None in stub mode → get_spend_usd reads HERMES_STUB_* flags.
        cost, src = get_spend_usd(agent, task_id)
        tele = status.setdefault("telemetry", {})
        tele["costUsd"] = cost
        tele["costSource"] = src
    return status


@mcp.tool()
async def cancel_task(task_id: str, reason: str = "cancelled") -> dict:
    """Interrupt a running task's agent loop and mark it failed. Idempotent on
    unknown or already-finished tasks. The single cancellation entry point."""
    from .hermes_runner import RUNNING

    state = task_store.state_of(task_id)
    if state is None:
        return {"status": "unknown", "task_id": task_id}
    if state != "running":
        return {"status": "noop", "state": state, "task_id": task_id}

    agent = RUNNING.get(task_id)
    if agent is not None:
        try:
            agent.interrupt(reason)
        except Exception as exc:  # noqa: BLE001
            task_store.emit(task_id, "SYSTEM", f"interrupt() raised: {exc}")
    task_store.emit(task_id, "SYSTEM", f"Task cancelled: {reason}")
    task_store.fail(task_id, "normalized_failure", {
        "normalizedFailure": {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False},
        "cancelled": True,
    })
    return {"status": "cancelled", "task_id": task_id}


@mcp.tool()
async def draft_and_queue_skill(proposed_name: str, skill_markdown: str,
                                source_task_id: str | None = None) -> dict:
    """Operator/console-invoked skill drafting: queues a proposed skill for
    human review (skill_queue), and only an explicit decide_skill APPROVE
    writes it to the skills directory.

    This does NOT override or intercept any autonomous Hermes skill-creation
    path — there is no autonomous caller of this tool. Hermes's own
    skill-creation/nudge loop (vendor/hermes-agent tools/skill_manager_tool.py
    + agent/turn_finalizer.py) is a separate mechanism, kept unreachable by
    TORQCLAW's toolset allowlist and the agent._skill_nudge_interval=0
    suppression in mcp_wrapper.hermes_runner (P2-0). TORQCLAW does not yet
    wire a governed replacement into the Hermes-loadable skill tree that
    upstream's autonomous loop would consult — that is tracked as P2-1 and is
    explicitly out of scope here."""
    queue_id = skill_queue.queue_skill(proposed_name, skill_markdown, source_task_id)
    if source_task_id:
        # Surfaces in the console as an approval row with allow/deny buttons.
        # P4: ride the draft markdown along when small (<=8KB) so the editor can
        # prefill without a round trip; larger drafts fetch via GET_SKILL_DRAFT.
        meta = {"queueId": queue_id, "skillName": proposed_name}
        if len(skill_markdown) <= 8192:
            meta["skillMarkdown"] = skill_markdown
        task_store.emit(
            source_task_id, "PENDING_APPROVAL",
            f"New skill drafted: {proposed_name}", meta,
        )
    return {"status": "pending_approval", "queue_id": queue_id}


@mcp.tool()
async def decide_skill(queue_id: str, decision: str,
                       edited_markdown: str | None = None) -> dict:
    """Called by the gateway when the console operator approves/rejects.
    P4: edited_markdown (APPROVE only) writes the operator's edits instead of
    the draft."""
    return skill_queue.decide(queue_id, decision, edited_markdown)


@mcp.tool()
async def get_skill_draft(queue_id: str) -> dict:
    """P4: return a draft's full markdown for the console editor (large drafts)."""
    return skill_queue.get_draft(queue_id)


@mcp.tool()
async def rollback_skill(skill_id: str, digest: str) -> dict:
    """GS-ROLLBACK: roll a governed skill back to an exact previously
    installed digest, end to end -- published projection, prompt cache, and
    governance move together (the store-only rollback GS-ACCEPT F-1 caught
    moved governance while the model kept being served the reverted
    content). Governed-only: refuses when TORQCLAW_GOVERNED_SKILLS is off.
    NOTE: rolling back a disabled skill re-enables it."""
    return skill_rollback.rollback(skill_id, digest)


@mcp.tool()
async def disable_skill(skill_id: str) -> dict:
    """GS-DISABLE: disable a governed skill end to end -- the published
    projection is removed, the prompt cache is invalidated, and governance
    is marked disabled in ONE transaction, so a fresh agent boot no longer
    renders it (the store-only disable had the same governance/projection
    divergence GS-ACCEPT F-1 found in rollback). Installed digest history is
    preserved. Governed-only: refuses when TORQCLAW_GOVERNED_SKILLS is off.
    NOTE: to re-enable, use rollback_skill with the digest you want back --
    that re-enables AND re-publishes in one digest-bound step."""
    return skill_rollback.disable(skill_id)


@mcp.tool()
async def list_skill_versions(skill_id: str) -> dict:
    """GS-ROLLBACK: list a governed skill's installed versions (with
    installedAt and tamper flags) plus its governed-active and published
    digests, so an operator can pick an exact rollback target and see
    governed/published divergence. GS-DISABLE adds `disabled` and
    `disabledDigest` so a disabled skill is distinguishable from a
    never-active one (opposite remedies: rollback vs re-approval)."""
    return skill_rollback.list_versions(skill_id)


@mcp.tool()
async def install_remote_skill(source_id: str, skill_id: str,
                               source_task_id: str | None = None) -> dict:
    """P4-5 (§6.1): fetch, verify, and stage a signed remote skill, then
    queue it `pending` for operator review -- the SAME queue/decide surface
    as draft_and_queue_skill, never a bypass. Refuses (never partially
    stages or queues) when TORQCLAW_REMOTE_SKILL_SOURCES is off, the source
    is unknown, the config is invalid, or ANY step of trust verification
    fails (bad signature, wrong digest, revoked key/skill, stale bundle,
    unsupported capability) -- see PRD-TCLAW-REMOTE-SKILL-SOURCES-005 §5.8
    for the full typed-reason registry. This is the AC-1 seam: a
    bad-signature package is refused HERE with an operator-visible reason,
    proven at this tool call, not by calling the trust engine directly.
    NOTE (O-19): this tool is operator-invoked; the kernel MCP surface does
    not distinguish callers on this codebase, matching rollback_skill /
    disable_skill's existing reachability boundary."""
    from . import remote_skills

    try:
        return remote_skills.install_remote_skill(source_id, skill_id, source_task_id)
    except remote_skills.SkillRemoteSourcesDisabled:
        return {"ok": False, "code": "SKILL_REMOTE_SOURCES_DISABLED", "retryable": False,
                "error": "remote skill sources are disabled"}
    except skill_sources.SkillRemoteSourceUnknown as exc:
        return {"ok": False, "code": "SKILL_REMOTE_SOURCE_UNKNOWN", "retryable": False,
                "error": f"unknown source: {exc}"}
    except skill_sources.SkillRemoteConfigError as exc:
        return {"ok": False, "code": "SKILL_REMOTE_CONFIG_INVALID", "retryable": False,
                "error": str(exc)}
    except skill_sources.SkillRemoteFetchError as exc:
        return {"ok": False, "code": "SKILL_REMOTE_FETCH_FAILED", "retryable": True,
                "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - trust/store errors mapped uniformly
        return governed_skills.map_activation_failure(exc, queue_status=None)


@mcp.tool()
async def refresh_skill_trust(source_id: str) -> dict:
    """P4-5 (§6.5): fetch and accept the origin's current signed trust
    bundle on demand. The retry remedy for SKILL_TRUST_STALE and the
    recovery vehicle for clock-rollback quarantine. Reporting only (O-2):
    if the newly accepted bundle revokes the key or digest of an installed,
    ACTIVE skill, the result's `revocationsAffectingInstalled` names it --
    this call never auto-disables or mutates governed state; the operator
    must run disable_skill (or rollback_skill) themselves."""
    from . import remote_skills

    try:
        return remote_skills.refresh_skill_trust(source_id)
    except remote_skills.SkillRemoteSourcesDisabled:
        return {"ok": False, "code": "SKILL_REMOTE_SOURCES_DISABLED", "retryable": False,
                "error": "remote skill sources are disabled"}
    except skill_sources.SkillRemoteSourceUnknown as exc:
        return {"ok": False, "code": "SKILL_REMOTE_SOURCE_UNKNOWN", "retryable": False,
                "error": f"unknown source: {exc}"}
    except skill_sources.SkillRemoteConfigError as exc:
        return {"ok": False, "code": "SKILL_REMOTE_CONFIG_INVALID", "retryable": False,
                "error": str(exc)}
    except skill_sources.SkillRemoteFetchError as exc:
        return {"ok": False, "code": "SKILL_REMOTE_FETCH_FAILED", "retryable": True,
                "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - trust/store errors mapped uniformly
        return governed_skills.map_activation_failure(exc, queue_status=None)


def apply_workspace_root() -> None:
    """Anchor the process cwd to $TORQCLAW_WORKSPACE_ROOT (fail-soft).

    The vendored Hermes file tools resolve relative paths against the process
    cwd. Without this, a model asked to "create demo.txt in the workspace"
    writes into the engine checkout (engines/hermes_kernel/) instead of the
    workspace the operator can see. Engine-owned state is unaffected: task
    store, skill stores, and the attempt ledger all resolve via
    $TORQCLAW_DATA_DIR / ~/.torqclaw (absolute), and skip_context_files=True
    keeps the agent from reading project context out of the new cwd.
    Unset or unusable root -> warn and keep the current cwd (existing
    behavior); never fail startup over it."""
    root = os.environ.get("TORQCLAW_WORKSPACE_ROOT", "").strip()
    if not root:
        return
    path = Path(root).expanduser()
    try:
        path.mkdir(parents=True, exist_ok=True)
        os.chdir(path)
    except OSError as exc:
        print(
            f"[engine] TORQCLAW_WORKSPACE_ROOT unusable ({exc}); "
            f"file tools stay relative to {os.getcwd()}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    # NEVER add uvicorn workers>1: the cancellation registry (hermes_runner.
    # RUNNING) and task SQLite assume one process. FastMCP runs single-process
    # uvicorn by default — keep it.
    apply_workspace_root()
    mcp.run(transport="streamable-http")  # serves at /mcp
