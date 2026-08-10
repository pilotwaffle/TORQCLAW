"""Publish an installed, digest-verified skill so the REAL Hermes prompt
builder can actually load it.

Scope (P2-1a): publication only. This module does not call
``VerifiedSkillStore.activate()``, does not invalidate the Hermes skills
system-prompt cache, and has no ``ActivationCoordinator`` caller. A future
ticket (P2-1g's ``ActivationCoordinator``, see ``runtime_quiescence.py``)
sequences ``publish``/``restore`` from this module as its callbacks, inside
one lock hold, together with cache invalidation and the store's governed
commit. Wiring that up is explicitly out of scope here.

The problem this closes
------------------------
``VerifiedSkillStore.activate()`` (``verified_skill_store.py``) installs a
package into the store's OWN ``versions_dir / skill_id / digest`` tree. Hermes
never reads that tree. An "activated" governed skill was, before this module,
a skill Hermes would never load -- the control loop reached "Activate" and
stopped one hop short of Hermes.

The unlock
----------
Hermes' real skill loader (vendored ``agent/prompt_builder.py``) scans TWO
classes of directory every time it builds the skills system prompt:
``get_skills_dir()`` (Hermes' own, operator/local skills) and
``get_all_skills_dirs()[1:]`` (external directories configured by the
operator via ``skills.external_dirs`` in their ``config.yaml``, resolved by
the vendored ``agent/skill_utils.py``). Publishing into a TORQCLAW-owned
external directory -- rather than into Hermes' own ``skills/`` tree -- means:

- External dirs are scanned directly with no snapshot caching, so the prompt
  snapshot can never hold a stale governed skill.
- ``.usage.json`` is local-dir-only, so publication never touches it.
- Local (Hermes-native) skills take precedence on a name collision, so a
  governed skill cannot silently shadow the operator's own same-named skill.
- TORQCLAW only ever writes inside a directory it owns.

Target directory
-----------------
``$TORQCLAW_DATA_DIR/published_skills`` (default ``~/.torqclaw/published_skills``),
matching the existing ``TORQCLAW_DATA_DIR`` convention already used by
``task_store.py``, ``skill_queue.py``, and ``failover_runtime.py`` for every
other TORQCLAW-owned directory. This directory is never Hermes' own skills
directory (``get_skills_dir()`` / ``HERMES_SKILLS_DIR``) -- it must be listed
purely as one of the *external* dirs in the operator's ``config.yaml`` for
Hermes to ever look at it, which is exactly what the fail-closed membership
check below verifies before any bytes are written.

The fail-closed membership check (the single most important requirement)
--------------------------------------------------------------------------
``skills.external_dirs`` lives in operator-owned ``config.yaml``, outside
this repo. If an operator removes or mistypes the entry, the vendored
``get_external_skills_dirs()`` just silently returns fewer paths (it logs at
debug only) -- Hermes stops loading governed skills with no error anywhere.
Without an explicit check here, TORQCLAW would report "published" for a
skill Hermes will never load: the exact P2-1 defect, reproduced one layer
lower. So every publish (and every unpublish-verification) re-derives
membership from the REAL upstream ``get_all_skills_dirs()`` -- never a config
file re-parse of our own, never a cached assumption -- and fails closed with
a typed error if the resolved target is not a member.

The cache trap (verified against the real vendored source; do not remove)
----------------------------------------------------------------------------
``agent.skill_utils.get_external_skills_dirs()`` caches its result in a
module-level ``_EXTERNAL_DIRS_CACHE`` keyed on ``(config.yaml path,
st_mtime_ns)`` (``skill_utils.py:333, 359-369``), and its directory filter is
``if p.is_dir()`` (``skill_utils.py:419``) -- a *configured* external dir
that does not exist on disk YET is silently dropped from the result, and
that negative is cached against the config file's current mtime. Publication
only ever creates/populates the skill directory; it never touches
``config.yaml``, so the config mtime never changes and a negative cached
before the target directory existed would never naturally expire for the
life of the process. Concretely: if anything (including a prior failed
publish attempt, or an unrelated caller) ever called ``get_all_skills_dirs()``
while our target directory was still absent, the membership check below
would see a permanently stale "not configured" verdict even after the
directory is created and genuinely listed in ``config.yaml`` -- fail-closed
forever despite correct operator config. Two structural fixes close this:

1. The target directory is created BEFORE the first membership check of a
   given publish/verify call -- never check-then-mkdir.
2. A negative verdict is not trusted on its own: on a negative, the upstream
   cache is invalidated exactly once (see
   :func:`_invalidate_upstream_external_dirs_cache`) and the check is
   retried before failing closed. Only a negative verdict that survives a
   fresh, uncached read is treated as authoritative.

``_invalidate_upstream_external_dirs_cache`` calls the underscore-private
``agent.skill_utils._external_dirs_cache_clear()`` (``skill_utils.py:336``,
docstringed upstream as a "Test hook"). This is a deliberate, flagged
coupling to a private upstream symbol that could rename or disappear across
a submodule bump -- it is isolated behind this one wrapper, called from
exactly one place (:func:`_resolve_and_verify_external_dir`), specifically
so that coupling is visible in one spot for an operator/maintainer to
re-evaluate, rather than scattered across call sites.

Path comparison uses ``Path.resolve()`` on both sides (never a raw string
compare): ``get_all_skills_dirs()`` itself resolves and skips-if-equal
against the local skills dir, and a string compare of an unresolved
configured value against our target would produce false negatives on
Windows (drive letter case, 8.3 short names, symlinks).

Package format: single file only
----------------------------------
A publishable package is a directory containing exactly ``skill.json`` and
``SKILL.md`` -- the same two-file contract ``VerifiedSkillStore`` enforces at
stage time (``verified_skill_store._read_package``). Any subdirectory
(``references/``, ``scripts/``, etc.) makes the package a directory package,
which the store itself cannot even stage, let alone this publisher install.
Publishing must fail loudly and specifically, naming the offending
subdirectory, and must never silently flatten -- flattening would publish an
artifact that differs from what the operator's digest-bound approval
actually covers.
"""

from __future__ import annotations

import json
import os
import stat
import time
import uuid
from pathlib import Path
from typing import Any

from .verified_skill_store import (
    SkillStoreError,
    file_digest,
    package_digest,
)

__all__ = [
    "SkillPublicationError",
    "SkillNotExternallyLoadableError",
    "SkillPackageShapeError",
    "SkillPublicationIntegrityError",
    "PROVENANCE_FILENAME",
    "published_skills_dir",
    "published_skills_retained_root",
    "publish_skill",
    "unpublish_skill",
    "is_published",
    "discard_retained_projection",
    "restore_retained_projection",
]


PROVENANCE_FILENAME = ".torqclaw-provenance.json"

_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_SKILL_BYTES = 512 * 1024


class SkillPublicationError(SkillStoreError):
    """Base class for all fail-closed publication/unpublication errors.

    Deliberately NOT a subclass of ``SkillValidationError``,
    ``SkillRecoveryError``, or ``ValueError`` -- following the
    ``SkillAuditCapacityError`` precedent in ``verified_skill_store.py`` --
    so that no broad ``except (SkillRecoveryError, ValueError)``-style
    handler elsewhere in the codebase can launder a publication failure into
    a merely-advisory warning.
    """


class SkillNotExternallyLoadableError(SkillPublicationError):
    """The publish target is not a member of the real upstream
    ``get_all_skills_dirs()`` result, even after one cache-invalidation
    retry. Nothing was written. This is the fail-closed gate that prevents
    TORQCLAW from ever reporting "published" for a skill Hermes cannot load.
    """


class SkillPackageShapeError(SkillPublicationError):
    """The source package is not the required single-file
    ``{skill.json, SKILL.md}`` shape (e.g. it contains a subdirectory such as
    ``references/`` or ``scripts/``). Naming the offending entry is
    mandatory; silently flattening a directory package is never acceptable
    because it would publish bytes the operator's approval was never bound
    to.
    """


class SkillPublicationIntegrityError(SkillPublicationError):
    """Published bytes did not verify against the expected digest after
    writing, or the source package itself does not match its own manifest
    digest. Raised instead of silently leaving mismatched bytes in place.
    """


def published_skills_dir() -> Path:
    """The single TORQCLAW-owned directory this module ever publishes into.

    Derived from ``TORQCLAW_DATA_DIR`` (default ``~/.torqclaw``), the same
    environment variable ``task_store.py``, ``skill_queue.py``, and
    ``failover_runtime.py`` already use for every other TORQCLAW-owned data
    directory -- so operators configure one variable, not several, and a
    test harness that already isolates ``TORQCLAW_DATA_DIR`` automatically
    isolates this directory too. This is intentionally independent of any
    particular ``VerifiedSkillStore`` instance's ``root``: the store is
    always constructed by its caller with an arbitrary root (including a
    fresh ``tmp_path`` in tests), so tying publication to "the" store root
    would make the publish target ambiguous across multiple store instances.

    This is never Hermes' own skills directory. It only becomes loadable by
    Hermes at all once the operator lists it under ``skills.external_dirs``
    in their ``config.yaml`` -- which :func:`publish_skill` verifies via the
    real upstream loader before writing anything.
    """
    data_dir = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
    return data_dir / "published_skills"


def published_skills_retained_root() -> Path:
    """The TORQCLAW-owned directory an :class:`ActivationCoordinator` retains
    a replaced skill projection under during a transaction (GS-COORD).

    A SIBLING of :func:`published_skills_dir`, never a child of it and never
    a dotfile sibling INSIDE it -- see ``publish_skill``'s
    ``retain_replaced_into`` docstring for why a retained projection must
    live entirely outside any directory the real Hermes loader scans. Same
    volume as ``published_skills_dir()`` (both derive from the same
    ``TORQCLAW_DATA_DIR``), so moving a projection in or out is always one
    ``os.replace``, matching the existing ``dir=_data_dir()`` precedent in
    ``governed_skills.py``.
    """
    data_dir = Path(os.environ.get("TORQCLAW_DATA_DIR") or Path.home() / ".torqclaw")
    return data_dir / "published_skills_retained"


def _invalidate_upstream_external_dirs_cache() -> None:
    """Force the next ``get_external_skills_dirs()`` call to re-read
    ``config.yaml`` from disk instead of reusing a cached result.

    COUPLING WARNING: this calls the underscore-private
    ``agent.skill_utils._external_dirs_cache_clear()``, which upstream's own
    docstring labels a "Test hook", not a public API. It is called from
    exactly this one wrapper, exactly one call site
    (:func:`_resolve_and_verify_external_dir`), so that this coupling stays
    visible in a single place for an operator/maintainer to re-evaluate on
    every vendor submodule bump, rather than being scattered across the
    module. If a future upstream version renames or removes this function,
    this wrapper is the one place that needs updating -- and its failure
    mode is safe: see the caller, which treats invalidation as best-effort
    and still falls through to a real fail-closed error if the retried
    membership check is also negative.

    Why this is necessary at all (not just a nice-to-have): upstream caches
    ``get_external_skills_dirs()`` keyed on ``(config path, config mtime)``
    and silently drops any configured directory that does not yet exist on
    disk (``is_dir()`` filter). Publication creates that directory itself
    and never touches ``config.yaml``, so a negative cached before the
    directory existed would otherwise never expire. See the module
    docstring's "cache trap" section for the full mechanism.
    """
    try:
        from agent.skill_utils import _external_dirs_cache_clear  # type: ignore
    except Exception:
        # Best-effort only: if upstream no longer exposes this hook, the
        # caller's retried membership check simply re-observes the same
        # (possibly stale) cache and, if still negative, fails closed for
        # real. We never treat "could not invalidate" itself as fatal here
        # -- only a membership check that is STILL negative after this
        # best-effort attempt is fatal.
        return
    try:
        _external_dirs_cache_clear()
    except Exception:
        return


def _resolve_and_verify_external_dir(target: Path) -> Path:
    """Return ``target.resolve()`` iff it is a member of the REAL upstream
    ``get_all_skills_dirs()`` result, checked fresh (with one
    cache-invalidation retry on a negative), never assumed.

    Ordering is load-bearing: ``target`` is created on disk (if absent)
    BEFORE the first membership check, because upstream's external-dirs
    resolution silently filters out configured-but-nonexistent directories
    and then caches that negative. Checking before creating (or trusting a
    single negative without invalidating) can produce a permanent
    fail-closed even when the operator's ``config.yaml`` is correctly
    configured -- see the module docstring's "cache trap" section, verified
    against the real vendored ``agent/skill_utils.py`` source.
    """
    target.mkdir(parents=True, exist_ok=True)
    resolved_target = target.resolve()

    try:
        from agent.skill_utils import get_all_skills_dirs  # type: ignore
    except Exception as exc:
        raise SkillNotExternallyLoadableError(
            "could not import agent.skill_utils.get_all_skills_dirs from "
            "the vendored Hermes agent; refusing to publish without proof "
            "the target directory is externally loadable"
        ) from exc

    def _member() -> bool:
        try:
            dirs = get_all_skills_dirs()
        except Exception as exc:
            raise SkillNotExternallyLoadableError(
                "agent.skill_utils.get_all_skills_dirs raised; refusing to "
                "publish without proof the target directory is externally "
                "loadable"
            ) from exc
        resolved = set()
        for entry in dirs:
            try:
                resolved.add(Path(entry).resolve())
            except OSError:
                continue
        return resolved_target in resolved

    if _member():
        return resolved_target

    # Single retry after an explicit, flagged cache invalidation -- see
    # _invalidate_upstream_external_dirs_cache. A membership check that is
    # STILL negative after this is treated as authoritative and fails
    # closed for real; this function never retries more than once so a
    # genuinely misconfigured operator config fails fast rather than
    # spinning.
    _invalidate_upstream_external_dirs_cache()
    if _member():
        return resolved_target

    raise SkillNotExternallyLoadableError(
        f"target directory {resolved_target} is not present in "
        "agent.skill_utils.get_all_skills_dirs(); it must be listed under "
        "skills.external_dirs in the operator's config.yaml before "
        "TORQCLAW will publish into it. Nothing was written."
    )


def _read_source_package(package_dir: Path) -> dict[str, Any]:
    """Validate a source package's single-file shape and return its raw
    bytes plus computed digest. Mirrors ``VerifiedSkillStore._read_package``'s
    shape contract exactly (this module intentionally does not import that
    private helper, to stay decoupled from the store's internal layout
    rules, but the contract -- exactly ``skill.json`` and ``SKILL.md``, no
    subdirectories -- must match, since a package this rejects is a package
    the store could never have installed in the first place).
    """
    package_dir = Path(package_dir)
    if not package_dir.is_dir():
        raise SkillPackageShapeError(f"package is not a directory: {package_dir}")

    entries = sorted(package_dir.iterdir(), key=lambda p: p.name)
    subdirs = [entry.name for entry in entries if entry.is_dir()]
    if subdirs:
        offending = subdirs[0]
        raise SkillPackageShapeError(
            f"this package contains '{offending}/'; directory packages are "
            "not yet governed — tracked as P2-2. Publication of a "
            "multi-file skill package was refused rather than silently "
            "flattened."
        )

    names = sorted(entry.name for entry in entries if entry.is_file())
    if names != ["SKILL.md", "skill.json"]:
        raise SkillPackageShapeError(
            f"package must contain exactly skill.json and SKILL.md, found: {names}"
        )

    manifest_path = package_dir / "skill.json"
    skill_path = package_dir / "SKILL.md"
    manifest_bytes = manifest_path.read_bytes()
    skill_bytes = skill_path.read_bytes()
    if len(manifest_bytes) > _MAX_MANIFEST_BYTES:
        raise SkillPackageShapeError("skill.json exceeds byte limit")
    if len(skill_bytes) > _MAX_SKILL_BYTES:
        raise SkillPackageShapeError("SKILL.md exceeds byte limit")

    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SkillPackageShapeError("skill.json is not valid UTF-8 JSON") from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get("id"), str):
        raise SkillPackageShapeError("skill.json is missing a string 'id'")

    digest = package_digest(manifest_bytes, skill_bytes)
    return {
        "manifest": manifest,
        "manifest_bytes": manifest_bytes,
        "skill_bytes": skill_bytes,
        "digest": digest,
        "skill_id": manifest["id"],
    }


def _write_bytes_exclusive(path: Path, value: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return
    if path.is_dir():
        for child in list(path.iterdir()):
            _remove_tree(child)
        path.rmdir()
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def publish_skill(
    package_dir: str | os.PathLike[str],
    *,
    digest: str,
    source: str = "verified_skill_store",
    retain_replaced_into: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Publish an installed single-file skill package into TORQCLAW's
    external skills directory, verified loadable by the REAL Hermes loader.

    ``package_dir`` is expected to be an installed digest directory from
    ``VerifiedSkillStore.versions_dir`` (``versions/<skill_id>/<digest>``),
    but this function does not import or depend on ``VerifiedSkillStore`` --
    it only requires the two-file package shape and re-derives the digest
    itself, so ``digest`` is always independently verified rather than
    trusted from the caller.

    Sequencing (all-or-nothing; nothing partial survives a failure):

    1. Validate the source package shape (fails loudly on a directory
       package -- see :func:`_read_source_package`).
    2. Verify the computed digest matches the caller-supplied ``digest``.
    3. Resolve and verify the target external directory is a member of the
       REAL ``get_all_skills_dirs()`` (fail-closed gate; see module
       docstring). Nothing is written before this passes.
    4. Write the package into a fresh temp directory, then atomically
       ``os.replace`` it into place -- so a mid-publish failure never
       leaves a half-written package where Hermes' index scan (which reads
       directory contents whenever it is invoked -- there is no snapshot
       caching for external dirs) could observe it.
    5. Write the ``.torqclaw-provenance.json`` sidecar (inert to Hermes:
       ``iter_skill_index_files`` only looks for ``SKILL.md``/
       ``DESCRIPTION.md``).
    6. Re-read the published bytes and verify the digest again post-write.

    ``retain_replaced_into`` (GS-COORD): by default (``None``), any prior
    published version of this exact ``skill_id`` is retired to a
    ``.torqclaw-doomed-*`` name and deleted immediately on success -- the
    original P2-1a behaviour, preserved byte-for-byte for every caller that
    does not pass this argument. Passing a directory instead moves the
    retired prior version (if any existed) into
    ``<retain_replaced_into>/<uuid>/`` -- OUTSIDE the loadable
    ``published_skills`` tree entirely, never merely renamed in place --
    and returns its path as ``result["retainedPath"]`` (``None`` if there
    was nothing to retain, i.e. a first-time publish). This exists because a
    ``.torqclaw-doomed-*`` directory left inside ``published_skills`` IS
    still scanned by the real Hermes loader (``EXCLUDED_SKILL_DIRS`` is a
    fixed-name frozenset with no dot-prefix rule -- see
    ``agent/skill_utils.py``): a coordinator that needs to actually restore
    the exact prior version on a later failure cannot leave it (even
    temporarily) anywhere under a member of ``get_all_skills_dirs()``, or a
    concurrent loader scan mid-transaction could observe it and, because
    ``.`` sorts before alphanumerics in the sorted-match order
    ``iter_skill_index_files`` yields, has it silently WIN over the new
    version via prompt_builder's first-wins dedup. The caller is responsible
    for actually deleting a no-longer-needed retained directory once it is
    sure it will never restore it (see ``discard_retained_projection``).

    Returns a dict describing what was published. Raises a typed
    :class:`SkillPublicationError` subclass on any failure, with nothing
    left behind on disk beyond what existed before the call.
    """
    source_artifact = _read_source_package(Path(package_dir))
    if source_artifact["digest"] != digest:
        raise SkillPublicationIntegrityError(
            "source package bytes do not match the expected digest; "
            f"expected {digest}, computed {source_artifact['digest']}"
        )

    skill_id = source_artifact["skill_id"]
    target_root = _resolve_and_verify_external_dir(published_skills_dir())
    final_dir = target_root / skill_id

    retain_root: Path | None = None
    if retain_replaced_into is not None:
        retain_root = Path(retain_replaced_into)
        _assert_retention_root_outside_loadable_tree(retain_root)
        retain_root.mkdir(parents=True, exist_ok=True)

    temp_dir = target_root / f".torqclaw-publish-{uuid.uuid4().hex}"
    temp_dir.mkdir()
    retained_path: Path | None = None
    try:
        _write_bytes_exclusive(temp_dir / "skill.json", source_artifact["manifest_bytes"])
        _write_bytes_exclusive(temp_dir / "SKILL.md", source_artifact["skill_bytes"])

        provenance = {
            "schemaVersion": 1,
            "skillId": skill_id,
            "digest": digest,
            "publishedAt": time.time_ns(),
            "source": source,
        }
        provenance_bytes = json.dumps(
            provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        _write_bytes_exclusive(temp_dir / PROVENANCE_FILENAME, provenance_bytes)

        # Replace any previously published version of this exact skill_id
        # atomically: remove the old directory only after the new one is
        # fully staged in temp_dir, and only via one os.replace of the new
        # tree into final_dir's path. If final_dir already exists we cannot
        # os.replace a directory onto another non-empty directory on every
        # platform, so retire the old one to a doomed temp name first and
        # remove it only after the new tree is safely in place.
        doomed_dir = None
        if final_dir.exists():
            doomed_dir = target_root / f".torqclaw-doomed-{uuid.uuid4().hex}"
            os.replace(final_dir, doomed_dir)
        try:
            os.replace(temp_dir, final_dir)
        except Exception:
            # Roll the previous version back into place; publication must
            # not leave the skill unpublished on a failed republish.
            if doomed_dir is not None and doomed_dir.exists():
                os.replace(doomed_dir, final_dir)
            raise
        if doomed_dir is not None:
            if retain_root is not None:
                # Move OUT of the loadable tree entirely -- never leave it
                # renamed in place, even under a dot-prefixed name, because
                # the real loader does not honour dot-prefix exclusion (see
                # docstring above). One os.replace, same-volume-safe because
                # the caller is expected to pass a sibling under the same
                # TORQCLAW_DATA_DIR (mirroring governed_skills.py's existing
                # `dir=_data_dir()` precedent for tempfile placement).
                retained_path = retain_root / uuid.uuid4().hex
                os.replace(doomed_dir, retained_path)
            else:
                _remove_tree(doomed_dir)
    except Exception:
        _remove_tree(temp_dir)
        raise

    _verify_published_digest(final_dir, expected_digest=digest, skill_id=skill_id)

    return {
        "ok": True,
        "skillId": skill_id,
        "digest": digest,
        "path": str(final_dir),
        "externalDir": str(target_root),
        "retainedPath": str(retained_path) if retained_path is not None else None,
    }


def _assert_retention_root_outside_loadable_tree(retain_root: Path) -> None:
    """Fail closed if ``retain_root`` resolves to, or sits under, any member
    of the REAL upstream ``get_all_skills_dirs()`` result.

    This is the inverse of :func:`_resolve_and_verify_external_dir`'s
    membership check: that function proves a publish target IS loadable;
    this one proves a retention target is NOT. Both matter for the same
    reason -- a directory the real Hermes loader can scan must never
    silently hold a stale governed skill (see the module docstring's "cache
    trap" section and ``skill_publisher.py``'s ``retain_replaced_into``
    docstring for the concrete mechanism: dot-prefixed dirs are NOT excluded
    by ``EXCLUDED_SKILL_DIRS`` and can win a first-wins dedup against the
    real skill).
    """
    resolved_retain = retain_root.resolve() if retain_root.exists() else Path(os.path.abspath(retain_root))

    try:
        from agent.skill_utils import get_all_skills_dirs  # type: ignore
    except Exception as exc:
        raise SkillNotExternallyLoadableError(
            "could not import agent.skill_utils.get_all_skills_dirs from the "
            "vendored Hermes agent; refusing to use a retention root without "
            "proof it is NOT inside a loadable skills directory"
        ) from exc

    try:
        loadable_dirs = get_all_skills_dirs()
    except Exception as exc:
        raise SkillNotExternallyLoadableError(
            "agent.skill_utils.get_all_skills_dirs raised; refusing to use a "
            "retention root without proof it is NOT inside a loadable "
            "skills directory"
        ) from exc

    for entry in loadable_dirs:
        try:
            resolved_member = Path(entry).resolve()
        except OSError:
            continue
        if resolved_retain == resolved_member:
            raise SkillPublicationError(
                f"retention root {resolved_retain} IS a loadable skills "
                "directory; refusing to retain a replaced skill projection "
                "there -- it would remain scanned by the real Hermes loader"
            )
        try:
            resolved_retain.relative_to(resolved_member)
        except ValueError:
            continue
        raise SkillPublicationError(
            f"retention root {resolved_retain} is INSIDE the loadable "
            f"skills directory {resolved_member}; refusing -- a retained "
            "projection must be a sibling of published_skills, never a "
            "child of it or of any other loadable directory"
        )


def discard_retained_projection(retained_path: str | os.PathLike[str] | None) -> None:
    """Permanently delete a retained projection produced by
    ``publish_skill(..., retain_replaced_into=...)``. Idempotent: a ``None``
    or already-missing path is a successful no-op, so a coordinator's
    "finalize" step can call this unconditionally after a verified success.
    """
    if retained_path is None:
        return
    _remove_tree(Path(retained_path))


def restore_retained_projection(
    *, skill_id: str, retained_path: str | os.PathLike[str] | None
) -> dict[str, Any]:
    """Restore a retained prior projection back into ``published_skills`` as
    the current published version of ``skill_id``, undoing exactly what the
    ``retain_replaced_into`` branch of ``publish_skill`` moved out.

    If ``retained_path`` is ``None`` (the publish that is being undone was a
    first-time publish with nothing previously published), this instead
    removes whatever ``publish_skill`` just wrote for ``skill_id`` -- i.e.
    restoring to "nothing published", the correct prior state.

    Uses the same atomic doomed-then-replace two-step ``publish_skill``
    itself uses, so a failure partway through never leaves ``published_skills``
    without a directory for ``skill_id`` when one should exist, or with two.
    """
    target_root = published_skills_dir()
    final_dir = target_root / skill_id

    if retained_path is None:
        # Nothing was previously published: restoring means removing what
        # the failed publish attempt just wrote.
        return unpublish_skill(skill_id)

    retained = Path(retained_path)
    if not retained.is_dir():
        raise SkillPublicationIntegrityError(
            f"cannot restore {skill_id}: retained projection {retained} is "
            "missing or not a directory -- TORQCLAW cannot prove which "
            "projection is live"
        )

    doomed_dir = None
    if final_dir.exists():
        doomed_dir = target_root / f".torqclaw-doomed-{uuid.uuid4().hex}"
        os.replace(final_dir, doomed_dir)
    try:
        os.replace(retained, final_dir)
    except Exception:
        if doomed_dir is not None and doomed_dir.exists():
            os.replace(doomed_dir, final_dir)
        raise
    if doomed_dir is not None:
        _remove_tree(doomed_dir)

    return {"ok": True, "skillId": skill_id, "path": str(final_dir)}


def _verify_published_digest(final_dir: Path, *, expected_digest: str, skill_id: str) -> None:
    """Re-read the just-written package bytes from disk and confirm they
    hash to exactly the expected digest. Raised failures here mean the
    on-disk bytes are provably wrong -- never assumed correct because the
    write call returned without an OS error.
    """
    try:
        manifest_bytes = (final_dir / "skill.json").read_bytes()
        skill_bytes = (final_dir / "SKILL.md").read_bytes()
    except OSError as exc:
        raise SkillPublicationIntegrityError(
            f"could not re-read published package for {skill_id} to verify "
            "its digest"
        ) from exc
    actual = package_digest(manifest_bytes, skill_bytes)
    if actual != expected_digest:
        raise SkillPublicationIntegrityError(
            f"published bytes for {skill_id} do not match expected digest "
            f"after write; expected {expected_digest}, found {actual} -- "
            "the on-disk package is corrupted"
        )


def unpublish_skill(skill_id: str) -> dict[str, Any]:
    """Remove a published skill's directory from TORQCLAW's external skills
    directory. Total and idempotent: calling this when the skill is not
    published (or already removed) is a successful no-op, never an error,
    so an ``ActivationCoordinator.restore`` callback can call this
    unconditionally without first checking whether publication happened.
    """
    target_root = published_skills_dir()
    final_dir = target_root / skill_id
    if not final_dir.exists():
        return {"ok": True, "skillId": skill_id, "removed": False}

    # Retire-then-delete: rename first so a failure partway through the
    # recursive delete cannot leave a half-deleted directory sitting under
    # the skill's real name where Hermes' index scan could still see a
    # partial/corrupt package.
    doomed_dir = target_root / f".torqclaw-doomed-{uuid.uuid4().hex}"
    os.replace(final_dir, doomed_dir)
    _remove_tree(doomed_dir)
    return {"ok": True, "skillId": skill_id, "removed": True}


def is_published(skill_id: str) -> bool:
    """Cheap existence check used by tests/callers that only need to know
    whether a publish/unpublish left a directory behind. This is NOT a
    substitute for verifying discoverability through the real Hermes
    loader -- see the test suite, which asserts discoverability via
    ``agent.skill_utils.get_all_skills_dirs()`` / the real prompt-builder
    scan, never via this existence check alone.
    """
    return (published_skills_dir() / skill_id).is_dir()
