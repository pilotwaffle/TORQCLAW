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
from pathlib import Path
from typing import Any

from . import skill_publisher
from .runtime_quiescence import ActivationCoordinator, _MUTATION_LOCK
from .verified_skill_store import SkillStoreError, VerifiedSkillStore, file_digest


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
    is digest-bound, audited, rollback-capable, and -- critically -- verified
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
