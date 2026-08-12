"""Governed skill installation -- the wiring between the live approval path
and the verified skill lifecycle.

WHY THIS MODULE EXISTS
----------------------
``skill_queue.decide()`` on APPROVE wrote the skill straight to disk::

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content)

No digest, no manifest, no approval binding, no audit trail, no rollback, and
no validation of the operator-supplied name (so ``../escape`` was a valid
"skill id"). Meanwhile ``VerifiedSkillStore`` (998 lines) and
``skill_publisher`` (557 lines) provided exactly those properties and were
reachable from no running program -- the repo's recurring defect: strong code
wired to nothing, passing its own unit tests the whole time.

This module is the missing seam. It bridges the impedance mismatch between
what the approval surface has (a name and raw markdown) and what the governed
store requires (a two-file package with a manifest), then runs the real
lifecycle through :class:`~mcp_wrapper.runtime_quiescence.ActivationCoordinator`
(GS-COORD): stage -> approve -> [LOCK -> quiescence -> retain prior
projection -> publish new -> invalidate cache -> governed commit -> verify
-> finalize/restore -> UNLOCK].

FLAG DEFAULT IS OFF, DELIBERATELY
---------------------------------
``TORQCLAW_GOVERNED_SKILLS`` defaults to disabled. Turning a new write path on
for every existing deployment without opt-in would be a behaviour change
smuggled in as a refactor. With the flag off, ``skill_queue`` keeps its
current behaviour byte for byte.

GS-COORD: ORDERING AND LOCKING
-------------------------------
Nine defects were verified in the pre-GS-COORD version of this module and its
collaborators (coordinator bypassed entirely; activate() before publish();
publication irreversible after success; a stale ``.torqclaw-doomed-*`` scan
winner; the store's own reconcile() replaying an uncommitted journal;
skill_queue flipping approved before install; and more). The fix threads the
whole install through one ``ActivationCoordinator`` transaction:

- The store handle is constructed EAGERLY INSIDE the coordinator's lock
  acquisition, not before it and not lazily on first store-method call from
  outside the lock. ``VerifiedSkillStore.__init__`` runs ``reconcile()``,
  which can itself commit or discard a retained journal -- that must not
  race a concurrent activation attempt, hence: lock order is always
  ``_MUTATION_LOCK -> store._lock``, one direction only. No store method may
  ever acquire ``_MUTATION_LOCK`` (that would invert the order and risk
  deadlock); ``VerifiedSkillStore`` remains completely unaware this module
  or ``runtime_quiescence`` exist.
- ``publish()`` runs BEFORE the governed commit (``store.activate()``), not
  after -- the inverted ordering was defect #2: a routine publish failure
  used to leave governance claiming ACTIVE with the approval already
  consumed while Hermes never saw the skill.
- The previously published version of this exact skill id (if any) is
  retained OUTSIDE the loadable ``published_skills`` tree for the duration
  of the transaction (see ``skill_publisher.publish_skill``'s
  ``retain_replaced_into``), so a restore never depends on a
  ``.torqclaw-doomed-*`` directory the real Hermes loader could scan and
  accidentally prefer (defect #4).
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from . import skill_publisher
from .runtime_quiescence import ActivationCoordinator, _MUTATION_LOCK
from .verified_skill_store import (
    SkillApprovalError,
    SkillStoreError,
    VerifiedSkillStore,
    _normalize_digest,
    file_digest,
)


class GovernedSkillError(Exception):
    """A skill could not be installed through the governed pipeline."""


class GovernanceRevertedProjectionUnprovenError(GovernedSkillError):
    """The coordinator's ``restore`` callback reverted governed-active state
    back to the prior digest, but restoring the prior PUBLISHED projection
    then also failed, so TORQCLAW cannot prove what is actually on disk for
    this skill id.

    This is deliberately distinct from a bare ``RuntimeError``/``OSError``:
    ``skill_queue.decide()`` must never fold this into its ordinary
    ``{retryable: true, status: "pending"}`` activation-failure result --
    that shape implicitly promises "nothing partial is left published or
    governed-active" (see ``skill_queue.py``'s docstring), which is exactly
    the claim that does NOT hold here. Governance is conservative (points at
    the prior digest again, approval reusable), but the published bytes are
    in an unknown state -- possibly still the new, un-governed version. An
    operator must be told plainly rather than have this reported as a
    routine retryable failure.
    """


#: A skill id must be a single safe path segment. The legacy path did
#: ``SKILLS_DIR / name`` with no validation, so "../escape" wrote outside the
#: skills tree entirely.
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_TRUTHY = {"1", "true", "yes", "on"}

_STORE: VerifiedSkillStore | None = None

#: Guards ONLY the lazy construction of the module-level `_STORE` singleton
#: itself (the assignment in `_store()`), never a governed mutation. This is
#: deliberately a *different* lock from `_MUTATION_LOCK`, and is always
#: acquired strictly INSIDE an already-held `_MUTATION_LOCK` (see `_store()`
#: below) -- never the other way around -- so the full acquisition order is
#: always `_MUTATION_LOCK -> _STORE_SINGLETON_LOCK -> (released) ->
#: store._lock`, which never conflicts with a bare `store._lock` acquisition
#: made later by the caller on its own.
_STORE_SINGLETON_LOCK = threading.Lock()


def enabled() -> bool:
    """Whether the governed pipeline handles skill approval.

    Defaults to False so existing deployments keep their current behaviour
    until an operator opts in.
    """
    return os.environ.get("TORQCLAW_GOVERNED_SKILLS", "").strip().lower() in _TRUTHY


def _data_dir() -> Path:
    """TORQCLAW's data root, created eagerly (import-order independence,
    matching ``skill_queue.py``'s existing ``DATA_DIR.mkdir(...)`` precedent):
    a caller that reaches this module without ``skill_queue`` having been
    imported first (e.g. a direct ``governed_skills.install_approved_skill``
    call, as several GS-COORD tests do to exercise the coordinator in
    isolation) must not fail on a missing directory that every other
    TORQCLAW-owned data path assumes exists.
    """
    data_dir = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _store() -> VerifiedSkillStore:
    """Process-wide store handle, resolved lazily, construction ALWAYS
    performed under ``_MUTATION_LOCK``.

    Resolved on first use rather than at import so tests (and an operator
    changing TORQCLAW_DATA_DIR) are not captured by import order -- the same
    trap that made the external-dirs cache bite in P2-1a.

    Lock-ordering contract (frozen, do not relitigate): ``VerifiedSkillStore
    .__init__`` runs ``reconcile()``, which mutates and ``_save_state``s --
    that must not race a concurrent activation attempt, so first
    construction happens with ``_MUTATION_LOCK`` held. ``_MUTATION_LOCK`` is
    an ``RLock``, so a caller already inside an ``ActivationCoordinator``
    transaction (which holds ``_MUTATION_LOCK`` for its entire ``run()``)
    re-enters here safely on the same thread; a caller with no lock held
    (tests, diagnostics, ``install_approved_skill``'s own stage/approve
    calls) simply acquires it uncontended. Either way, construction is never
    observable outside the lock. Once ``_STORE`` is set, every subsequent
    call returns the cached handle without re-acquiring ``_MUTATION_LOCK``
    at all -- only ``store._lock`` (acquired later, by the caller's own
    method calls) applies from then on, so this function never holds
    ``_MUTATION_LOCK`` across a full store method call, only across the
    one-time construction.
    """
    global _STORE
    if _STORE is not None:
        return _STORE
    with _MUTATION_LOCK:
        with _STORE_SINGLETON_LOCK:
            if _STORE is None:
                _STORE = VerifiedSkillStore(_data_dir() / "verified_skills")
            return _STORE


def _store_locked() -> VerifiedSkillStore:
    """Return the store handle from inside an already-held ``_MUTATION_LOCK``.

    Docstring contract (lock order): callers of this function MUST already
    hold ``_MUTATION_LOCK`` (e.g. be running inside
    ``ActivationCoordinator.run()``). Enforced for real, not merely
    documented: an unheld lock raises ``RuntimeError`` immediately rather
    than silently constructing the store outside the lock (an ``assert`` is
    stripped under ``python -O`` and would let this guard evaporate in an
    optimized run). ``_store()`` itself acquires ``_MUTATION_LOCK`` for
    first construction, so calling it here from inside an already-held
    ``RLock`` re-enters on the same thread without blocking.
    """
    if not _MUTATION_LOCK._is_owned():
        raise RuntimeError(
            "_store_locked() called without _MUTATION_LOCK held -- this "
            "would construct VerifiedSkillStore (and run its reconcile()) "
            "outside the coordinator's lock, which is the exact race this "
            "module's lock-ordering contract exists to prevent"
        )
    return _store()


def _reset_for_test() -> None:
    """Drop the cached store handle. Test-only."""
    global _STORE
    with _STORE_SINGLETON_LOCK:
        _STORE = None


def _validate_id(skill_id: str) -> str:
    candidate = (skill_id or "").strip()
    if not _SAFE_ID.match(candidate):
        raise GovernedSkillError(
            f"invalid skill id {skill_id!r}: must be a single path segment of "
            "letters, digits, dot, underscore or hyphen (max 128 chars)"
        )
    if candidate in {".", ".."}:
        raise GovernedSkillError(f"invalid skill id {skill_id!r}")
    return candidate


def _build_package(root: Path, skill_id: str, markdown: str) -> Path:
    """Materialise the two-file package shape the store requires.

    The approval surface has a name and markdown; the store needs a manifest
    with a content digest. Building it here keeps that translation in one
    place instead of spreading manifest knowledge across callers.

    Deterministic by construction (GS-COORD idempotency precondition): no
    timestamp, uuid, or other randomness anywhere in the manifest -- version
    is the fixed literal ``"1.0.0"``, id/name/description are derived purely
    from ``skill_id``, and the only content-derived field
    (``files["SKILL.md"]``) is a pure hash of ``markdown``. So
    ``(skill_id, markdown) -> package_digest(...)`` is a pure function: the
    exact same markdown approved twice for the same id always produces the
    exact same digest, which is what makes the success-side-crash
    reconciliation in :func:`install_approved_skill` sound.
    """
    package = root / "package"
    package.mkdir(parents=True)
    skill_bytes = markdown.encode("utf-8")
    manifest = {
        "schemaVersion": 1,
        "id": skill_id,
        "version": "1.0.0",
        "name": skill_id,
        "description": f"Operator-approved skill {skill_id}",
        "source": "torqclaw:operator-approval",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    import json

    (package / "skill.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (package / "SKILL.md").write_bytes(skill_bytes)
    return package


def _already_active_and_published(skill_id: str, digest: str) -> bool:
    """GS-COORD idempotency check: is this EXACT digest already both the
    governed-active version AND the currently published one?

    Used to make a retry after a success-side crash (activation fully
    committed, process died before ``skill_queue`` recorded ``approved``) a
    safe no-op instead of a second, divergent activation attempt. Chosen
    over a queue-identity sidecar approach (also viable -- ``skill_publisher``
    already writes a provenance sidecar that could carry a ``queueId``)
    because it needs no schema change anywhere and ``_build_package``'s
    determinism (see its docstring) makes digest equality a sufficient
    proxy for "this is the same approval being retried", without having to
    thread the queue's row id through the store/publisher at all.

    The provenance sidecar's ``"digest"`` field is a CLAIM, not proof -- it
    is plain JSON sitting next to the published bytes, so anything that can
    write into ``published_skills`` (including an operator's own manual
    edit) can make it lie. G1R round-2 fix: after the sidecar claims a
    match, the published ``skill.json``/``SKILL.md`` bytes are re-hashed via
    the same digest-verification path ``publish_skill`` itself uses
    post-write (:func:`skill_publisher._verify_published_digest`) before
    this function reports "already done". Without this, a tampered
    published directory (bytes overwritten out-of-band, sidecar left
    stale/matching) would report ``reconciledFromPriorSuccess: True`` while
    serving corrupted content.
    """
    try:
        store = _store()
        active = store.get_active(skill_id)
    except SkillStoreError:
        return False
    if active is None or active.get("digest") != digest:
        return False
    if not skill_publisher.is_published(skill_id):
        return False
    provenance_path = (
        skill_publisher.published_skills_dir() / skill_id / skill_publisher.PROVENANCE_FILENAME
    )
    try:
        import json

        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if provenance.get("digest") != digest:
        return False
    try:
        skill_publisher._verify_published_digest(
            skill_publisher.published_skills_dir() / skill_id,
            expected_digest=digest,
            skill_id=skill_id,
        )
    except SkillStoreError:
        # The sidecar claimed a match but the actual bytes on disk do not
        # hash to it -- fail closed and let the caller fall through to a
        # real (re-)activation attempt rather than reconcile against
        # corrupted content.
        return False
    return True


def install_approved_skill(skill_id: str, markdown: str) -> dict[str, Any]:
    """Install an operator-approved skill through the governed lifecycle.

    stage -> approve -> [``ActivationCoordinator``: retain prior published
    projection -> publish new -> invalidate cache -> activate (governed
    commit) -> verify -> finalize/restore]. Each step is the real
    ``VerifiedSkillStore`` / ``skill_publisher`` implementation, so the result
    is digest-bound, audited, rollback-capable (through
    :func:`rollback_governed_skill`, the production rollback path GS-ACCEPT
    F-1 found missing), disable-capable (through
    :func:`disable_governed_skill`, GS-DISABLE), and -- critically -- verified
    discoverable by the actual Hermes loader rather than merely written to a
    directory we hope is the right one.

    Idempotent on the exact ``(skill_id, markdown)`` pair: if this precise
    digest is already both governed-active and published (the success-side
    crash case -- activation fully landed but the caller never got to record
    it), this returns success immediately without a second activation
    attempt. See ``_already_active_and_published``.

    Raises ``GovernedSkillError`` on an invalid id. Propagates
    ``runtime_quiescence.SkillRuntimeBusyError`` when a live Hermes run
    blocks activation (nothing was changed; the caller should treat this as
    retryable). Propagates the store's/coordinator's own typed errors
    otherwise. Nothing is durably published or governed-active if any step
    fails.
    """
    sid = _validate_id(skill_id)

    workspace = Path(tempfile.mkdtemp(prefix=".torqclaw-governed-", dir=_data_dir()))
    try:
        package = _build_package(workspace, sid, markdown)

        # Stage + approve happen OUTSIDE the coordinator's lock: neither
        # touches governed active state or the external projection, so they
        # carry no quiescence requirement of their own (staging only writes
        # to the store's private staging_dir; approval only records a
        # one-use token). `_store()` itself still only ever CONSTRUCTS the
        # singleton under `_MUTATION_LOCK` (see its docstring) -- this call
        # either returns the already-built handle with no locking at all, or
        # (first call in the process) acquires `_MUTATION_LOCK` just long
        # enough to build it, then releases it before `stage()` below ever
        # touches `store._lock`.
        store = _store()
        staged = store.stage(package)
        digest = staged["digest"]

        if _already_active_and_published(sid, digest):
            return {
                "ok": True,
                "skillId": sid,
                "digest": digest,
                "publishedPath": str(skill_publisher.published_skills_dir() / sid),
                "reconciledFromPriorSuccess": True,
            }

        # confirm_permission_delta: the operator already approved this skill on
        # the console. The capability set is fixed at ["read"] by _build_package,
        # so there is no hidden escalation being waved through here.
        approval = store.approve(staged, confirm_permission_delta=True)

        retain_root = skill_publisher.published_skills_retained_root() / staged["stageId"]

        # ActivationCoordinator.run() returns only the `commit()` result, but
        # `install_approved_skill`'s own return value (and the post-success
        # retained-projection cleanup) needs the *publish* result too --
        # specifically its `retainedPath` and final `path`. Captured via this
        # holder rather than a nonlocal digest juggle, since `publish()` runs
        # exactly once per `.run()` call and its result is needed by both
        # `restore()` (on failure) and the code after `.run()` (on success).
        publish_holder: dict[str, Any] = {}

        def _publish() -> dict[str, Any]:
            result = skill_publisher.publish_skill(
                staged["path"],
                digest=digest,
                source="torqclaw:operator-approval",
                retain_replaced_into=retain_root,
            )
            publish_holder["result"] = result
            return result

        # Populated by `_commit()` ONLY after `locked_store.activate(...)`
        # itself has returned successfully, so `_restore` can tell "commit
        # never landed" (nothing governed to revert -- e.g. `activate()`
        # itself raised, meaning `state["active"]` was never actually
        # flipped to the new digest) apart from "commit landed and must be
        # reverted" (a later step, `verify`, is what failed).
        #
        # GS-COORD round-3 fix: round 2 wrote `commit_holder["previous"]`
        # BEFORE calling `activate()`, so the key was present even when
        # `activate()` itself raised (a commit FAILURE, not a verify
        # failure) -- `revert_activation` would then read fresh state showing
        # the digest was never actually flipped and silently no-op
        # (`reverted: False`), making any assertion of the form
        # `active["digest"] == first["digest"]` pass VACUOUSLY: governance
        # was simply never moved, not genuinely reverted. Recording
        # `"previous"` only once `activate()` returns makes this dict a
        # faithful proxy for "did the governed commit actually land",
        # matching what `_restore`'s branching already assumes.
        commit_holder: dict[str, Any] = {}

        def _restore(publish_result: dict[str, Any]) -> None:
            # Governance is reverted FIRST, unconditionally relative to the
            # publisher restore below (GS-COORD round-2 fix: the reverse
            # order let a `restore_retained_projection` failure abandon the
            # governed revert entirely, leaving governance AND publication
            # both claiming the new, failed version -- the ticket's own
            # core failure mode restated one layer up). Reverting governance
            # first means a subsequent publisher-restore failure leaves
            # governance CONSERVATIVE (pointing at the old digest) instead
            # of optimistically claiming the new one, which is the safer
            # failure direction: an operator retry re-approving the same
            # content is always safe, whereas a stale "new version active"
            # claim over unproven bytes is not.
            if "previous" in commit_holder:
                # The governed commit (store.activate) landed before the
                # failure that triggered this restore (necessarily a
                # `verify()` failure, since `commit()` itself raising would
                # never populate `commit_holder` -- see `_commit` below).
                # Revert it using the exact snapshot captured just before
                # `activate()` ran, so governance and the just-restored
                # published bytes agree again. See
                # `VerifiedSkillStore.revert_activation`'s docstring for why
                # this is a distinct primitive from `rollback()`.
                locked_store = _store_locked()
                locked_store.revert_activation(
                    sid, digest, approval["token"], commit_holder["previous"]
                )

            try:
                skill_publisher.restore_retained_projection(
                    skill_id=sid, retained_path=publish_result.get("retainedPath")
                )
            except Exception as exc:
                if "previous" in commit_holder:
                    # Governance was already reverted above -- that part
                    # succeeded. The publisher restore failing here means
                    # TORQCLAW cannot prove what is actually published for
                    # this skill id (still the new bytes? partially
                    # written? gone entirely?), even though governance now
                    # points at the prior digest again. Raise a DISTINCT
                    # error so `skill_queue.decide()` cannot launder this
                    # into its ordinary `{retryable: true, status:
                    # "pending"}` shape, which explicitly promises nothing
                    # partial is left published or governed-active -- a
                    # promise this path does not keep.
                    raise GovernanceRevertedProjectionUnprovenError(
                        f"skill {sid!r}: governed-active state was reverted "
                        f"to digest {commit_holder['previous'].get('digest') if commit_holder['previous'] else None!r}, "
                        "but restoring the prior published projection then "
                        "failed; TORQCLAW cannot prove what is currently "
                        "published on disk for this skill id"
                    ) from exc
                # Nothing was governed-active to revert (this restore was
                # triggered by a failure at or before `commit()`, e.g. a
                # cache-invalidation failure) -- the projection restore
                # failure is the only problem, so let it propagate as-is;
                # ActivationCoordinator.run() itself decides how to report
                # a bare `restore()` failure (see its docstring: NOT
                # swallowed or wrapped, propagated so the lock is held
                # until the caller has an unambiguous signal).
                raise

            # restore_retained_projection() moves the leaf retained digest
            # directory back into place, but the per-transaction parent
            # (`retain_root`, named after this call's stageId) is left
            # behind, now empty. Clean it up here rather than in
            # skill_publisher: this module owns `retain_root`'s naming
            # scheme (keyed on stageId), so it owns removing it once the
            # transaction concludes on either path (success -- see the
            # `discard_retained_projection` call below -- or failure, here).
            shutil.rmtree(retain_root, ignore_errors=True)

        def _commit() -> dict[str, Any]:
            # Constructed/acquired here, INSIDE the coordinator's
            # `_MUTATION_LOCK` hold -- see `_store_locked`'s docstring for
            # the full lock-ordering contract this satisfies.
            locked_store = _store_locked()
            # Read the RAW internal `state["active"][sid]` shape (not
            # get_active()'s public shape, which adds `skillId`/`version`
            # keys that don't belong in the internal record) so
            # `revert_activation` writes back byte-exact what was there
            # before, if `verify` fails after this commit lands. Held in a
            # local, NOT written into `commit_holder` yet: `commit_holder`
            # must only ever reflect a commit that actually landed (see its
            # declaration above) -- if `activate()` below raises, this local
            # value is simply discarded along with the rest of this frame.
            previous = locked_store._load_state()["active"].get(sid)
            result = locked_store.activate(staged, approval)
            # Only recorded once `activate()` has returned without raising:
            # the governed commit genuinely landed, so there is now
            # something for `_restore` to revert if a later step (verify)
            # fails.
            commit_holder["previous"] = previous
            return result

        def _verify(commit_result: dict[str, Any]) -> None:
            locked_store = _store_locked()
            active = locked_store.get_active(sid)
            if active is None or active.get("digest") != digest:
                raise GovernedSkillError(
                    f"post-commit verification failed: {sid} is not "
                    f"governed-active at digest {digest}"
                )
            if not skill_publisher.is_published(sid):
                raise GovernedSkillError(
                    f"post-commit verification failed: {sid} is governed-"
                    "active but not published"
                )

        ActivationCoordinator(
            publish=_publish, restore=_restore, commit=_commit, verify=_verify
        ).run()

        # Success: the retained prior projection (if any) is no longer
        # needed. Deleting it here, OUTSIDE the coordinator's lock, is safe
        # because verify() already proved the new projection is both
        # governed-active and published -- nothing depends on the retained
        # copy surviving past this point. Also remove the (now-empty, or
        # entirely never-populated for a first-time publish) per-transaction
        # `retain_root` parent directory -- see the matching cleanup in
        # `_restore` for why this module owns that removal.
        published_result = publish_holder["result"]
        skill_publisher.discard_retained_projection(published_result.get("retainedPath"))
        shutil.rmtree(retain_root, ignore_errors=True)

        return {
            "ok": True,
            "skillId": sid,
            "digest": digest,
            "publishedPath": published_result["path"],
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def rollback_governed_skill(skill_id: str, digest: str) -> dict[str, Any]:
    """Roll a governed skill back to an exact previously installed digest,
    end to end (GS-ROLLBACK; closes GS-ACCEPT finding F-1).

    ``VerifiedSkillStore.rollback()`` alone moves GOVERNANCE to the prior
    digest but leaves the published projection -- the bytes the real Hermes
    prompt builder renders -- untouched, so the operator sees "rolled back"
    while the model keeps serving the reverted content. This function runs
    the same four-callback ``ActivationCoordinator`` transaction the install
    path uses, so the projection, the prompt cache, and governance move
    together or not at all:

        retain current published projection -> publish the target installed
        digest -> invalidate cache -> governed rollback commit -> verify
        governed AND published state -> finalize (or restore on failure).

    Notes an operator surface must relay (see ``skill_rollback.py``):

    - Rolling back a ``disable()``d skill re-enables it --
      ``store.rollback()`` unconditionally writes ``enabled: True``.
    - A skill that is installed but has NO active-state entry (reachable:
      a first-time install whose verify failed was reverted with
      ``previous=None``, deleting the entry while the installed record
      survives) cannot be rolled back: ``_current_permissions`` returns
      ``()`` for it, so the store would demand a fresh approval even for
      the baseline ``["read"]`` capability. That is detected here BEFORE
      the coordinator runs and raised as ``SkillApprovalError`` -- the
      remedy is a normal re-approval through the install path, so no
      approval parameter exists on this function by design.

    Idempotent on the exact ``(skill_id, digest)`` pair via the same
    byte-verifying check the install path uses: if the target digest is
    already both governed-active and published, returns success with
    ``reconciledFromPriorSuccess`` and runs no transaction. A crash between
    publish and commit leaves published=target vs governed=prior with no
    reconciler -- a retry of this call heals it (the fast path correctly
    refuses, the full run re-publishes and commits); this is the same
    exposure the install path has.

    Raises ``GovernedSkillError`` on an invalid id or a digest that is not
    an installed version of this skill. Propagates
    ``runtime_quiescence.SkillRuntimeBusyError`` (retryable, nothing
    changed), the coordinator's typed errors, and ``SkillApprovalError`` as
    above. Nothing durably moves if any step fails.
    """
    sid = _validate_id(skill_id)
    try:
        target_digest = _normalize_digest(digest)
    except SkillStoreError as exc:
        raise GovernedSkillError(f"invalid rollback digest {digest!r}: {exc}") from exc

    store = _store()
    target_dir = store.versions_dir / sid / target_digest
    if not target_dir.is_dir():
        # Cheap, mutation-free refusal BEFORE the coordinator's lock and
        # quiescence gate. store.rollback() re-checks the state record under
        # its own lock either way; this just keeps "unknown digest" from
        # costing a publish/restore round-trip.
        raise GovernedSkillError(
            f"rollback target is not an installed version: {sid}@{target_digest}; "
            "call list_skill_versions to see the installed digests"
        )

    if _already_active_and_published(sid, target_digest):
        return {
            "ok": True,
            "skillId": sid,
            "digest": target_digest,
            "publishedPath": str(skill_publisher.published_skills_dir() / sid),
            "reconciledFromPriorSuccess": True,
        }

    if not store.has_active_entry(sid):
        # See the docstring: fail fast with an accurate error instead of
        # letting store.rollback()'s capability-delta check produce a
        # misleading "adds capabilities" approval demand mid-transaction
        # (after a publish that would then have to be restored).
        raise SkillApprovalError(
            f"rollback target skill {sid!r} has never been governed-active; "
            "re-approve it through the normal install path instead"
        )

    # No stageId exists for a rollback (nothing is staged -- the source is
    # the immutable installed version directory), so the per-transaction
    # retained-projection parent is keyed on a fresh transaction id instead.
    retain_root = (
        skill_publisher.published_skills_retained_root() / f"rollback-{uuid.uuid4().hex}"
    )

    # Same holder discipline as install_approved_skill -- see the comments
    # there (governed_skills.py, install path) for why publish_holder exists
    # and why commit_holder["previous"] is only ever written AFTER the
    # governed flip returns.
    publish_holder: dict[str, Any] = {}
    commit_holder: dict[str, Any] = {}

    def _publish() -> dict[str, Any]:
        result = skill_publisher.publish_skill(
            target_dir,
            digest=target_digest,
            source="torqclaw:operator-rollback",
            retain_replaced_into=retain_root,
        )
        publish_holder["result"] = result
        return result

    def _restore(publish_result: dict[str, Any]) -> None:
        # Governance first, unconditionally relative to the publisher
        # restore -- the ordering ruling from GS-COORD round 2 (see
        # install_approved_skill._restore): a publisher-restore failure must
        # leave governance CONSERVATIVE, pointing at the pre-rollback
        # digest, never optimistically at the target.
        if "previous" in commit_holder:
            locked_store = _store_locked()
            # No approval was consumed by the rollback commit, so there is
            # none to un-consume: approval_token is None by design (typed
            # `str | None`; a fake token would corrupt the approvals table).
            locked_store.revert_activation(
                sid, target_digest, None, commit_holder["previous"]
            )

        try:
            skill_publisher.restore_retained_projection(
                skill_id=sid, retained_path=publish_result.get("retainedPath")
            )
        except Exception as exc:
            if "previous" in commit_holder:
                raise GovernanceRevertedProjectionUnprovenError(
                    f"skill {sid!r}: governed-active state was reverted to "
                    f"digest {commit_holder['previous'].get('digest') if commit_holder['previous'] else None!r} "
                    "after a failed rollback, but restoring the prior "
                    "published projection then failed; TORQCLAW cannot prove "
                    "what is currently published on disk for this skill id; "
                    "inspect with list_skill_versions (publishedDigest / "
                    "publishedVerified) before deciding again"
                ) from exc
            raise

        shutil.rmtree(retain_root, ignore_errors=True)

    def _commit() -> dict[str, Any]:
        locked_store = _store_locked()
        # Raw internal shape, captured in a local first -- commit_holder must
        # only ever reflect a commit that actually landed (the GS-COORD
        # round-3 vacuous-revert lesson; see install_approved_skill._commit).
        previous = locked_store._load_state()["active"].get(sid)
        result = locked_store.rollback(sid, target_digest)
        commit_holder["previous"] = previous
        return result

    def _verify(commit_result: dict[str, Any]) -> None:
        locked_store = _store_locked()
        active = locked_store.get_active(sid)
        if active is None or active.get("digest") != target_digest:
            raise GovernedSkillError(
                f"post-rollback verification failed: {sid} is not "
                f"governed-active at digest {target_digest}"
            )
        if not skill_publisher.is_published(sid):
            raise GovernedSkillError(
                f"post-rollback verification failed: {sid} is governed-"
                "active but not published"
            )
        # The check that closes F-1's failure shape: the PUBLISHED BYTES
        # must hash to the rollback target. `is_published` alone would pass
        # vacuously with the superseded bytes still on disk if the publish
        # step were ever skipped or subverted -- this is the deletion-probe
        # tripwire for exactly that sabotage.
        skill_publisher._verify_published_digest(
            skill_publisher.published_skills_dir() / sid,
            expected_digest=target_digest,
            skill_id=sid,
        )

    ActivationCoordinator(
        publish=_publish, restore=_restore, commit=_commit, verify=_verify
    ).run()

    published_result = publish_holder["result"]
    skill_publisher.discard_retained_projection(published_result.get("retainedPath"))
    shutil.rmtree(retain_root, ignore_errors=True)

    return {
        "ok": True,
        "skillId": sid,
        "digest": target_digest,
        "publishedPath": published_result["path"],
        "rolledBack": True,
    }


def disable_governed_skill(skill_id: str) -> dict[str, Any]:
    """Disable a governed skill end to end (GS-DISABLE): after success the
    skill is NOT governed-active-enabled and NOT published, so the real
    Hermes prompt builder stops rendering it.

    ``VerifiedSkillStore.disable()`` alone flips ``enabled: False`` in
    governed state and leaves the published projection exactly where it is
    -- the same defect shape GS-ROLLBACK closed for ``rollback()``: the
    operator is told the skill is off while the model keeps receiving it in
    every rendered system prompt. Governance-only disable is worse than
    rollback's version of the bug, because there is no "newer version" to
    mask it: the skill simply keeps working.

    This runs the same four-callback ``ActivationCoordinator`` transaction
    install and rollback use, with the callbacks pointed at removal instead
    of replacement::

        retain the current published projection (unpublish semantics)
          -> invalidate cache -> governed disable commit
          -> verify (governed disabled AND not published)
          -> finalize (discard retained) / restore on failure

    Note the ``publish`` callback here *un*-publishes. That reads odd but is
    exactly the coordinator's contract: ``publish`` means "make the desired
    projection state live and return what ``restore`` needs to undo it". The
    desired state for a disable is "absent", and what restore needs is the
    retained directory. See ``skill_publisher.retain_unpublish_skill``.

    THE INVERSE OF DISABLE IS ROLLBACK, DELIBERATELY. There is no
    ``enable_governed_skill``: ``rollback_governed_skill(skill_id, digest)``
    already re-enables (``store.rollback()`` writes ``enabled: True``
    unconditionally) AND re-publishes the exact target digest through this
    same transaction. A second enable path would either duplicate that
    function or -- worse -- re-enable governance while guessing at which
    digest to republish. An operator re-enables by rolling back to the
    digest they want, which is also the only shape that stays digest-bound.

    Idempotent: disabling a skill that is already both governed-disabled and
    unpublished is a reconciled no-op that runs no transaction. A skill that
    is disabled-but-still-published (or enabled-but-unpublished) is NOT
    reconciled -- that is a divergence, and the full transaction runs to
    heal it, mirroring ``rollback_governed_skill``'s treatment of the same
    split state.

    Raises ``GovernedSkillError`` on an invalid id or a skill with no
    governed-active entry at all (mutation-free, before the coordinator's
    lock). Propagates ``runtime_quiescence.SkillRuntimeBusyError`` (nothing
    changed, retryable), the coordinator's typed errors, and
    ``GovernanceRevertedProjectionUnprovenError`` when the projection
    restore fails after a landed commit -- identical taxonomy to install and
    rollback, mapped for operators by ``map_activation_failure``.
    """
    sid = _validate_id(skill_id)

    store = _store()
    if not store.has_active_entry(sid):
        # Cheap, mutation-free refusal BEFORE the coordinator's lock and
        # quiescence gate. store.disable() raises a bare SkillStoreError
        # ("skill is not active") for this, which the surface cannot
        # distinguish from a genuine transaction failure -- refusing here
        # with a typed GovernedSkillError keeps "you never installed this"
        # separate from "the disable transaction failed", and costs no
        # unpublish/restore round-trip.
        raise GovernedSkillError(
            f"cannot disable {sid!r}: it has no governed-active entry "
            "(never installed through the governed path, or already removed)"
        )

    raw_active = store._load_state()["active"].get(sid) or {}
    already_disabled = not raw_active.get("enabled", False)
    if already_disabled and not skill_publisher.is_published(sid):
        # Reconciled no-op: governance already says disabled and nothing is
        # published, so there is no divergence to heal and no projection to
        # move. Deliberately requires BOTH halves -- a disabled skill that is
        # still published is exactly the state this lane exists to fix, and
        # must fall through to the full transaction.
        return {
            "ok": True,
            "skillId": sid,
            "digest": raw_active.get("digest"),
            "disabled": True,
            "published": False,
            "reconciledFromPriorSuccess": True,
        }

    # No stageId exists for a disable (nothing is staged -- the projection
    # being retained is whatever is currently published), so the
    # per-transaction retained-projection parent is keyed on a fresh
    # transaction id, exactly as rollback does.
    retain_root = (
        skill_publisher.published_skills_retained_root() / f"disable-{uuid.uuid4().hex}"
    )

    # Same holder discipline as install_approved_skill and
    # rollback_governed_skill -- see install's comments for why
    # commit_holder["previous"] is only ever written AFTER the governed flip
    # returns (the GS-COORD round-3 vacuous-revert lesson).
    publish_holder: dict[str, Any] = {}
    commit_holder: dict[str, Any] = {}

    def _publish() -> dict[str, Any]:
        # "publish" == make the DESIRED projection state live. For a disable
        # that is: not published, with the removed directory retained
        # outside the loadable tree so `_restore` can put it back byte for
        # byte.
        result = skill_publisher.retain_unpublish_skill(sid, retain_into=retain_root)
        publish_holder["result"] = result
        return result

    def _restore(publish_result: dict[str, Any]) -> None:
        # Governance FIRST, unconditionally relative to the projection
        # restore -- the frozen GS-COORD round-2 ordering ruling. A
        # projection-restore failure must leave governance CONSERVATIVE. For
        # a disable, "conservative" means governance still says ENABLED at
        # the prior digest: if the bytes turn out to still be published,
        # enabled-and-published is a coherent (pre-call) state, whereas
        # disabled-but-published would be the silent "it says off but the
        # model still gets it" divergence this lane closes.
        if "previous" in commit_holder:
            locked_store = _store_locked()
            # A disable consumes no approval, so there is none to
            # un-consume: approval_token is None by design (a fake token
            # would corrupt the approvals table). revert_activation keys off
            # the digest that is currently active -- disable() does not
            # change the digest, only the enabled flag, so the digest here
            # is the unchanged one from the snapshot.
            #
            # `previous` is never None on this branch: commit_holder is
            # only populated after `store.disable()` RETURNED, and
            # disable() raises unless an active entry exists -- so the
            # snapshot taken immediately before it necessarily found one.
            previous = commit_holder["previous"]
            locked_store.revert_activation(sid, previous["digest"], None, previous)

        try:
            skill_publisher.restore_retained_projection(
                skill_id=sid, retained_path=publish_result.get("retainedPath")
            )
        except Exception as exc:
            if "previous" in commit_holder:
                raise GovernanceRevertedProjectionUnprovenError(
                    f"skill {sid!r}: governed-active state was reverted to "
                    f"enabled at digest {commit_holder['previous'].get('digest') if commit_holder['previous'] else None!r} "
                    "after a failed disable, but restoring the retained "
                    "published projection then failed; TORQCLAW cannot prove "
                    "what is currently published on disk for this skill id; "
                    "inspect with list_skill_versions (publishedDigest / "
                    "publishedVerified) before deciding again"
                ) from exc
            raise

        shutil.rmtree(retain_root, ignore_errors=True)

    def _commit() -> dict[str, Any]:
        locked_store = _store_locked()
        # Raw internal shape, captured in a local first -- commit_holder must
        # only ever reflect a commit that actually landed.
        previous = locked_store._load_state()["active"].get(sid)
        result = locked_store.disable(sid)
        commit_holder["previous"] = previous
        return result

    def _verify(commit_result: dict[str, Any]) -> None:
        locked_store = _store_locked()
        # get_active() returns None for a DISABLED entry (it filters on the
        # enabled flag), so None here is the success condition -- but None
        # is also what a missing entry returns, hence the raw-state check
        # below rather than trusting None alone.
        if locked_store.get_active(sid) is not None:
            raise GovernedSkillError(
                f"post-disable verification failed: {sid} is still "
                "governed-active"
            )
        raw = locked_store._load_state()["active"].get(sid)
        if raw is None or raw.get("enabled", False):
            raise GovernedSkillError(
                f"post-disable verification failed: {sid} has no disabled "
                "governed entry (installed history must be preserved)"
            )
        # THE check that closes this lane's failure shape, and the deletion-
        # probe tripwire for a no-op unpublish: the bytes must be GONE from
        # the loadable tree. Governance alone reporting disabled is exactly
        # the divergence -- a skill whose directory is still published keeps
        # rendering into every system prompt no matter what state.json says.
        if skill_publisher.is_published(sid):
            raise GovernedSkillError(
                f"post-disable verification failed: {sid} is governed-"
                "disabled but STILL PUBLISHED; the real Hermes prompt "
                "builder would keep rendering it"
            )

    ActivationCoordinator(
        publish=_publish, restore=_restore, commit=_commit, verify=_verify
    ).run()

    published_result = publish_holder["result"]
    skill_publisher.discard_retained_projection(published_result.get("retainedPath"))
    shutil.rmtree(retain_root, ignore_errors=True)

    return {
        "ok": True,
        "skillId": sid,
        "digest": (commit_holder.get("previous") or {}).get("digest"),
        "disabled": True,
        "published": False,
    }


def list_governed_versions(skill_id: str) -> dict[str, Any]:
    """Everything an operator needs to pick a rollback target: every
    installed version with ``installedAt`` (tamper-tolerant -- a corrupt
    version directory is flagged, not fatal, which matters precisely when
    rollback is the remedy), plus the current governed-active digest and
    the published digest so governed/published divergence is visible.

    GS-DISABLE adds ``disabled``/``disabledDigest``. ``get_active()``
    filters on the enabled flag, so without them a DISABLED skill and a
    never-active one are indistinguishable (both ``activeDigest: None``) --
    and their remedies differ completely: roll back to the disabled digest
    to re-enable, versus re-approve through the install path.

    Read-only: no quiescence requirement, no lock beyond the store's own.
    ``publishedDigest`` is the provenance sidecar's CLAIM;
    ``publishedVerified`` reports whether the on-disk bytes actually hash
    to it (the sidecar is plain JSON and can lie -- same reasoning as
    ``_already_active_and_published``).
    """
    sid = _validate_id(skill_id)
    store = _store()
    versions = store.list_versions(sid)

    active_digest: str | None = None
    active_state_error: str | None = None
    try:
        active = store.get_active(sid)
        active_digest = active["digest"] if active else None
    except SkillStoreError as exc:
        # An active entry exists but its package no longer validates --
        # exactly the state an operator lists versions to escape from.
        active_state_error = str(exc)

    # GS-DISABLE: get_active() filters on the enabled flag, so a DISABLED
    # skill and a never-active one both surface as activeDigest=None --
    # indistinguishable to an operator deciding what to do next, and after
    # this lane those two states have completely different remedies (roll
    # back to re-enable, versus re-approve through install). Read the raw
    # entry so disabled state is visible rather than inferred from an
    # absence.
    raw_active = store._load_state()["active"].get(sid)
    disabled = raw_active is not None and not raw_active.get("enabled", False)
    disabled_digest = raw_active.get("digest") if disabled else None

    published_digest: str | None = None
    published_verified = False
    published_dir = skill_publisher.published_skills_dir() / sid
    provenance_path = published_dir / skill_publisher.PROVENANCE_FILENAME
    try:
        import json

        claimed = json.loads(provenance_path.read_text(encoding="utf-8")).get("digest")
        published_digest = claimed if isinstance(claimed, str) else None
    except (OSError, ValueError):
        published_digest = None
    if published_digest is not None:
        try:
            skill_publisher._verify_published_digest(
                published_dir, expected_digest=published_digest, skill_id=sid
            )
            published_verified = True
        except SkillStoreError:
            published_verified = False

    result: dict[str, Any] = {
        "ok": True,
        "skillId": sid,
        "versions": versions,
        "activeDigest": active_digest,
        # True only when an entry EXISTS and is flipped off -- never for a
        # skill that was never governed-active.
        "disabled": disabled,
        # The digest the disabled entry still points at, so an operator can
        # roll straight back to it to re-enable. None unless disabled.
        "disabledDigest": disabled_digest,
        "publishedDigest": published_digest,
        "publishedVerified": published_verified,
        "governedSkillsEnabled": enabled(),
    }
    if active_state_error is not None:
        result["activeStateError"] = active_state_error
    return result


def map_activation_failure(exc: Exception, *, queue_status: str | None) -> dict[str, Any]:
    """The ONE operator-facing failure taxonomy for governed activation
    transactions (install and rollback share the coordinator, so they share
    the failure shapes -- two copies of this mapping would drift).

    Extracted from ``skill_queue.decide()``'s except arms verbatim;
    ``decide()`` passes ``queue_status="pending"`` and its results stay
    byte-identical (pinned by test). Surfaces with no queue row (the
    rollback tool) pass ``None`` and the ``status`` key is omitted --
    ``"status": "pending"`` is a queue-row claim and must not be emitted
    where no row exists.

    Arm semantics (the full rationale lives on each exception class and on
    ``decide()``'s docstring):

    - ``SkillRuntimeBusyError``: retryable; nothing changed; the caller
      should retry once live Hermes runs finish. ``activeTasks`` is a
      kernel fact and is reported for every surface.
    - ``GovernanceRevertedProjectionUnprovenError``: NOT retryable --
      governance was reverted (conservative) but the published bytes are
      unproven; an operator must look before any blind retry.
    - ``SkillActivationRestoredButCacheUnprovenError``: NOT retryable --
      the projection was changed twice and the mandatory post-restore cache
      invalidation could not be proven; a live agent may be serving a stale
      prompt.
    - anything else: retryable ``SKILL_ACTIVATION_FAILED`` -- the
      coordinator's restore path guarantees nothing partial is left
      published or governed-active, so a retry starts from a clean slate.
    """
    from .runtime_quiescence import (
        SkillActivationRestoredButCacheUnprovenError,
        SkillRuntimeBusyError,
    )

    if isinstance(exc, SkillRuntimeBusyError):
        from .hermes_runner import RUNNING

        active_tasks = len(RUNNING)
        result: dict[str, Any] = {
            "ok": False,
            "code": "SKILL_RUNTIME_BUSY",
            "retryable": True,
        }
        if queue_status is not None:
            result["status"] = queue_status
        result["activeTasks"] = active_tasks
        result["error"] = (
            f"Skill activation is blocked while {active_tasks} "
            "Hermes task(s) are running. No skill state changed. "
            "Retry when those tasks finish."
        )
        return result

    if isinstance(exc, GovernanceRevertedProjectionUnprovenError):
        code, retryable = "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT", False
    elif isinstance(exc, SkillActivationRestoredButCacheUnprovenError):
        code, retryable = "SKILL_ACTIVATION_CACHE_UNPROVEN", False
    else:
        code, retryable = "SKILL_ACTIVATION_FAILED", True

    result = {"ok": False, "code": code, "retryable": retryable}
    if queue_status is not None:
        result["status"] = queue_status
    result["error"] = str(exc)
    return result
