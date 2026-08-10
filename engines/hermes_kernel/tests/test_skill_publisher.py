"""P2-1a: publication only. Makes an installed, digest-verified skill
package actually discoverable by the REAL Hermes skill loader by writing it
into a TORQCLAW-owned external skills directory, verified against the real
upstream ``agent.skill_utils.get_all_skills_dirs()`` before anything is
written.

This ticket adds no ``ActivationCoordinator`` caller and does not touch
``VerifiedSkillStore.activate()``/``rollback()``/``disable()``/``approve()``.
Every discoverability assertion in this file goes through the REAL vendored
loader (``agent.skill_utils.get_all_skills_dirs()`` and/or the real
``agent.prompt_builder`` index scan) -- never a file-existence check alone,
per the ticket's required-tests list.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Importing hermes_runner performs the vendor sys.path.insert(0, VENDOR) at
# its own module scope (see mcp_wrapper/hermes_runner.py), which is what
# makes `import agent.skill_utils` resolve to the REAL vendored module below.
from mcp_wrapper import hermes_runner  # noqa: E402,F401
from mcp_wrapper.verified_skill_store import (  # noqa: E402
    VerifiedSkillStore,
    file_digest,
)
from mcp_wrapper import skill_publisher  # noqa: E402
from mcp_wrapper.skill_publisher import (  # noqa: E402
    PROVENANCE_FILENAME,
    SkillNotExternallyLoadableError,
    SkillPackageShapeError,
    SkillPublicationError,
    SkillPublicationIntegrityError,
    _assert_retention_root_outside_loadable_tree,
    is_published,
    publish_skill,
    published_skills_dir,
    unpublish_skill,
)

vendored_available, vendor_import_error = hermes_runner.hermes_available()
pytestmark = pytest.mark.skipif(
    not vendored_available,
    reason=f"vendored hermes-agent unavailable: {vendor_import_error}",
)


def write_package(
    root: Path,
    *,
    skill_id: str = "pub.demo",
    version: str = "1.0.0",
    text: str = "Use the approved workflow.\n",
    extra_dir: str | None = None,
) -> Path:
    package = root / f"pkg-{skill_id.replace('.', '-')}-{version}-{os.urandom(4).hex()}"
    package.mkdir()
    skill_bytes = text.encode("utf-8")
    manifest = {
        "schemaVersion": 1,
        "id": skill_id,
        "version": version,
        "name": "Demo publishable skill",
        "description": "A bounded test skill for publication",
        "source": "local:test",
        "files": {"SKILL.md": file_digest(skill_bytes)},
        "requiredCapabilities": ["read"],
        "compatibleProfiles": ["default"],
    }
    (package / "skill.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (package / "SKILL.md").write_bytes(skill_bytes)
    if extra_dir:
        (package / extra_dir).mkdir()
        (package / extra_dir / "placeholder.txt").write_text("x", encoding="utf-8")
    return package


def install_via_store(tmp_path: Path, store: VerifiedSkillStore, package: Path) -> dict:
    """Stage + approve + activate through the real store so the resulting
    installed digest directory is exactly what a publisher would be handed
    in production -- ``versions_dir/<skill_id>/<digest>``."""
    staged = store.stage(package)
    approval = store.approve(staged, confirm_permission_delta=True)
    store.activate(staged, approval)
    skill_id = staged["skillId"]
    digest = staged["digest"]
    installed_dir = store.versions_dir / skill_id / digest
    return {"skill_id": skill_id, "digest": digest, "path": installed_dir}


def _configure_external_dir(monkeypatch, tmp_path: Path, external_dir: Path) -> None:
    """Point the REAL vendored config resolution at an isolated HERMES_HOME
    whose config.yaml lists ``external_dir`` under skills.external_dirs, so
    ``agent.skill_utils.get_all_skills_dirs()`` genuinely includes it -- no
    monkeypatching of skill_utils itself, so the test exercises the real
    upstream resolution path end to end.
    """
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir(parents=True, exist_ok=True)
    config_path = hermes_home / "config.yaml"
    config_path.write_text(
        "skills:\n"
        f"  external_dirs:\n    - {external_dir.as_posix()!s}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    # Any process-level cache keyed on config path/mtime must not leak
    # between tests that each set up their own isolated HERMES_HOME.
    skill_publisher._invalidate_upstream_external_dirs_cache()


@pytest.fixture(autouse=True)
def _isolated_torqclaw_and_hermes_dirs(tmp_path, monkeypatch):
    """Never let a test publish into (or assert against) the operator's real
    ~/.torqclaw or ~/.hermes."""
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path / "torqclaw_data"))
    yield
    skill_publisher._invalidate_upstream_external_dirs_cache()


# ---------------------------------------------------------------------------
# Test 1: publishing makes the skill actually discoverable by the REAL
# upstream loader.
# ---------------------------------------------------------------------------

def test_publish_makes_skill_discoverable_by_real_loader(tmp_path, monkeypatch):
    from agent.skill_utils import get_all_skills_dirs

    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="discoverable.skill")
    installed = install_via_store(tmp_path, store, package)

    result = publish_skill(installed["path"], digest=installed["digest"])
    assert result["ok"] is True

    resolved_dirs = {Path(d).resolve() for d in get_all_skills_dirs()}
    assert target.resolve() in resolved_dirs

    published_dir = Path(result["path"])
    assert (published_dir / "SKILL.md").is_file()
    assert (published_dir / "skill.json").is_file()

    # Discoverable via the real prompt-builder index walk, not just directory
    # existence: reproduce exactly what prompt_builder.py's skill scan does
    # (walk every dir in get_all_skills_dirs() for a SKILL.md/DESCRIPTION.md
    # index file) and confirm our skill_id surfaces.
    found_ids = set()
    for skills_dir in get_all_skills_dirs():
        skills_dir = Path(skills_dir)
        if not skills_dir.is_dir():
            continue
        for entry in skills_dir.iterdir():
            if (entry / "SKILL.md").is_file() or (entry / "DESCRIPTION.md").is_file():
                found_ids.add(entry.name)
    assert "discoverable.skill" in found_ids


# ---------------------------------------------------------------------------
# Test 2: target dir absent from get_all_skills_dirs() -> typed fail-closed
# error, nothing written.
# ---------------------------------------------------------------------------

def test_publish_fails_closed_when_target_not_externally_configured(tmp_path, monkeypatch):
    # Deliberately do NOT configure skills.external_dirs to include our
    # target -- point HERMES_HOME at an isolated config that lists some
    # unrelated directory instead, so get_all_skills_dirs() is genuinely
    # exercised and genuinely does not contain our target.
    hermes_home = tmp_path / "hermes_home_unconfigured"
    hermes_home.mkdir(parents=True, exist_ok=True)
    unrelated = tmp_path / "unrelated_external_dir"
    unrelated.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text(
        f"skills:\n  external_dirs:\n    - {unrelated.as_posix()!s}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    skill_publisher._invalidate_upstream_external_dirs_cache()

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="unconfigured.skill")
    installed = install_via_store(tmp_path, store, package)

    with pytest.raises(SkillNotExternallyLoadableError):
        publish_skill(installed["path"], digest=installed["digest"])

    assert not is_published("unconfigured.skill")
    assert not list(published_skills_dir().glob("*"))


# ---------------------------------------------------------------------------
# Test 3: directory package -> loud, specific error naming the offending
# subdirectory; nothing published.
# ---------------------------------------------------------------------------

def test_publish_rejects_directory_package_by_name(tmp_path, monkeypatch):
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    package = write_package(tmp_path, skill_id="dir.pkg", extra_dir="scripts")
    manifest = json.loads((package / "skill.json").read_text(encoding="utf-8"))
    manifest_bytes = (package / "skill.json").read_bytes()
    skill_bytes = (package / "SKILL.md").read_bytes()
    from mcp_wrapper.verified_skill_store import package_digest
    digest = package_digest(manifest_bytes, skill_bytes)

    with pytest.raises(SkillPackageShapeError, match="scripts"):
        publish_skill(package, digest=digest)

    assert not is_published("dir.pkg")
    assert not list(published_skills_dir().glob("*"))


# ---------------------------------------------------------------------------
# Test 4: provenance sidecar written, and inert to Hermes' index.
# ---------------------------------------------------------------------------

def test_provenance_sidecar_written_and_inert_to_index(tmp_path, monkeypatch):
    from agent.skill_utils import get_all_skills_dirs

    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="provenance.skill")
    installed = install_via_store(tmp_path, store, package)
    result = publish_skill(installed["path"], digest=installed["digest"], source="test-source")

    published_dir = Path(result["path"])
    provenance_path = published_dir / PROVENANCE_FILENAME
    assert provenance_path.is_file()
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    assert provenance["skillId"] == "provenance.skill"
    assert provenance["digest"] == installed["digest"]
    assert provenance["source"] == "test-source"
    assert isinstance(provenance["publishedAt"], int)

    # Inert to Hermes' index. Verified against the real upstream signature:
    # iter_skill_index_files(skills_dir, filename) -- skill_utils.py:632, two
    # positional args. It yields only files matching `filename`, so the dotfile
    # sidecar must never appear in a SKILL.md scan of the published tree.
    from agent.skill_utils import iter_skill_index_files

    indexed = list(iter_skill_index_files(published_dir.parent, "SKILL.md"))
    index_names = {Path(p).name for p in indexed}
    assert PROVENANCE_FILENAME not in index_names
    # ...and the real skill IS indexed, so the assertion above is not vacuous.
    assert any(Path(p).parent.name == "provenance.skill" for p in indexed)


# ---------------------------------------------------------------------------
# Test 5: published bytes match expected digest; corruption detected.
# ---------------------------------------------------------------------------

def test_published_bytes_match_digest_and_corruption_is_detected(tmp_path, monkeypatch):
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="digest.skill")
    installed = install_via_store(tmp_path, store, package)

    # Wrong digest supplied by the caller must be rejected before anything
    # is written.
    with pytest.raises(SkillPublicationIntegrityError):
        publish_skill(installed["path"], digest="0" * 64)
    assert not is_published("digest.skill")

    # publish_skill() itself must call the post-write verification -- not
    # merely have a _verify_published_digest helper that a test can call
    # independently. Spy on it via monkeypatch so a publish_skill that stops
    # calling it (e.g. the post-write check is deleted from the publish
    # sequence) fails this test even though _verify_published_digest still
    # works correctly in isolation.
    calls = []
    original_verify = skill_publisher._verify_published_digest

    def spy_verify(*args, **kwargs):
        calls.append((args, kwargs))
        return original_verify(*args, **kwargs)

    monkeypatch.setattr(skill_publisher, "_verify_published_digest", spy_verify)
    result = publish_skill(installed["path"], digest=installed["digest"])
    assert len(calls) == 1, (
        "publish_skill() must call _verify_published_digest exactly once "
        "per publish -- it did not call it at all, or called it more than "
        "once"
    )
    published_dir = Path(result["path"])
    monkeypatch.undo()

    # Now corrupt the on-disk published bytes directly and confirm a
    # dedicated post-write-style re-verification catches it. We simulate
    # "corruption discovered after write" by re-running the same digest
    # check the publisher itself performs post-write.
    (published_dir / "SKILL.md").write_bytes(b"corrupted")
    from mcp_wrapper.skill_publisher import _verify_published_digest

    with pytest.raises(SkillPublicationIntegrityError):
        _verify_published_digest(
            published_dir, expected_digest=installed["digest"], skill_id="digest.skill"
        )


# ---------------------------------------------------------------------------
# Test 6: unpublish removes the package; idempotent on repeat.
# ---------------------------------------------------------------------------

def test_unpublish_removes_package_and_is_idempotent(tmp_path, monkeypatch):
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="unpub.skill")
    installed = install_via_store(tmp_path, store, package)
    publish_skill(installed["path"], digest=installed["digest"])
    assert is_published("unpub.skill")

    first = unpublish_skill("unpub.skill")
    assert first == {"ok": True, "skillId": "unpub.skill", "removed": True}
    assert not is_published("unpub.skill")

    second = unpublish_skill("unpub.skill")
    assert second == {"ok": True, "skillId": "unpub.skill", "removed": False}
    assert not is_published("unpub.skill")

    # Unpublishing a skill that was never published at all must also be a
    # successful no-op.
    never_published = unpublish_skill("never.existed")
    assert never_published == {"ok": True, "skillId": "never.existed", "removed": False}


# ---------------------------------------------------------------------------
# Test 7: publish -> unpublish -> no longer discoverable by the real loader.
# ---------------------------------------------------------------------------

def test_publish_then_unpublish_removes_real_discoverability(tmp_path, monkeypatch):
    from agent.skill_utils import get_all_skills_dirs

    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="cycle.skill")
    installed = install_via_store(tmp_path, store, package)
    publish_skill(installed["path"], digest=installed["digest"])

    def discoverable() -> bool:
        for skills_dir in get_all_skills_dirs():
            skills_dir = Path(skills_dir)
            if not skills_dir.is_dir():
                continue
            candidate = skills_dir / "cycle.skill"
            if (candidate / "SKILL.md").is_file():
                return True
        return False

    assert discoverable()
    unpublish_skill("cycle.skill")
    assert not discoverable()


# ---------------------------------------------------------------------------
# Test 8: failure mid-publish leaves nothing partially published.
# ---------------------------------------------------------------------------

def test_mid_publish_failure_leaves_no_partial_package(tmp_path, monkeypatch):
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="partial.skill")
    installed = install_via_store(tmp_path, store, package)

    original_write = skill_publisher._write_bytes_exclusive
    calls = {"n": 0}

    def flaky_write(path, value):
        calls["n"] += 1
        if calls["n"] == 2:  # fail while writing SKILL.md, after skill.json
            raise OSError("simulated mid-publish disk failure")
        return original_write(path, value)

    monkeypatch.setattr(skill_publisher, "_write_bytes_exclusive", flaky_write)
    with pytest.raises(OSError):
        publish_skill(installed["path"], digest=installed["digest"])
    monkeypatch.undo()

    assert not is_published("partial.skill")
    # No stray .torqclaw-publish-* temp directories left behind either.
    leftovers = list(target.glob(".torqclaw-publish-*"))
    assert leftovers == []
    leftovers_doomed = list(target.glob(".torqclaw-doomed-*"))
    assert leftovers_doomed == []


# ---------------------------------------------------------------------------
# Test 9: a governed skill does NOT shadow a same-named local skill.
# ---------------------------------------------------------------------------

def test_governed_skill_does_not_shadow_local_skill(tmp_path, monkeypatch):
    """Local (Hermes-native) skills must take precedence over an externally
    published governed skill with the same id -- proven via the real
    get_all_skills_dirs() ordering (local dir first, external dirs after)
    plus the actual local-first resolution semantics the real loader uses."""
    from agent.skill_utils import get_all_skills_dirs, get_skills_dir

    # NOTE: there is no HERMES_SKILLS_DIR env var anywhere in upstream (verified
    # by grep across the vendored tree). The local dir is *derived*:
    # get_skills_dir() == get_hermes_home() / "skills" (hermes_constants.py:406-408).
    # Writing to a guessed env-var path put the "local" skill somewhere the
    # loader never scans, so nothing could shadow and the test failed for the
    # wrong reason. Use the real accessor.
    shadow_id = "shadow.skill"

    # ORDER IS LOAD-BEARING: _configure_external_dir() repoints HERMES_HOME at an
    # isolated tmp dir, and get_skills_dir() derives from it. Resolving the local
    # dir BEFORE that call writes "LOCAL VERSION" under the *previous* home --
    # a directory the loader then never scans -- so the governed copy wins and
    # the test fails while reporting a shadowing bug that does not exist.
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    local_skills_dir = Path(get_skills_dir())
    local_skill_dir = local_skills_dir / shadow_id
    local_skill_dir.mkdir(parents=True, exist_ok=True)
    (local_skill_dir / "SKILL.md").write_text("LOCAL VERSION\n", encoding="utf-8")

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id=shadow_id, text="GOVERNED VERSION\n")
    installed = install_via_store(tmp_path, store, package)
    publish_skill(installed["path"], digest=installed["digest"])

    dirs = [Path(d) for d in get_all_skills_dirs()]
    assert dirs[0].resolve() == Path(get_skills_dir()).resolve()
    assert target.resolve() in {d.resolve() for d in dirs[1:]}

    # Local-first resolution: the first directory in get_all_skills_dirs()
    # whose entry has this skill id wins.
    resolved_content = None
    for skills_dir in dirs:
        candidate = skills_dir / shadow_id / "SKILL.md"
        if candidate.is_file():
            resolved_content = candidate.read_text(encoding="utf-8")
            break
    assert resolved_content == "LOCAL VERSION\n"


# ---------------------------------------------------------------------------
# Test 10: the publisher never touches .usage.json or the prompt snapshot.
# ---------------------------------------------------------------------------

def test_publisher_never_touches_usage_json_or_prompt_snapshot(tmp_path, monkeypatch):
    from agent.skill_utils import get_skills_dir

    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    # NOTE: there is no HERMES_SKILLS_DIR env var upstream -- see test 9's
    # comment. The local dir is derived via get_skills_dir(), which is
    # get_hermes_home() / "skills", and HERMES_HOME is already set by
    # _configure_external_dir() above.
    local_skills_dir = Path(get_skills_dir())
    usage_path = local_skills_dir / ".usage.json"
    usage_before = None
    if usage_path.exists():
        usage_before = usage_path.read_bytes()

    def _fail_if_called(*args, **kwargs):
        raise AssertionError(
            "skill_publisher must never call clear_skills_system_prompt_cache "
            "-- cache invalidation belongs to the P2-1g ActivationCoordinator"
        )

    try:
        import agent.prompt_builder as prompt_builder

        monkeypatch.setattr(
            prompt_builder, "clear_skills_system_prompt_cache", _fail_if_called
        )
    except ImportError:
        prompt_builder = None

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="quiet.skill")
    installed = install_via_store(tmp_path, store, package)
    publish_skill(installed["path"], digest=installed["digest"])
    unpublish_skill("quiet.skill")

    if usage_path.exists():
        assert usage_before is not None and usage_path.read_bytes() == usage_before
    else:
        assert usage_before is None

    # Confirm the publisher module itself never imports/calls the cache
    # invalidation entry point at all -- static assertion on the module
    # source, independent of the monkeypatch above.
    import inspect

    source = inspect.getsource(skill_publisher)
    assert "clear_skills_system_prompt_cache" not in source


# ---------------------------------------------------------------------------
# Coordinator-flagged regression test: the fail-closed membership check must
# be proven against a POISONED cache, not merely a clean one. Without the
# invalidate-and-retry fix in _resolve_and_verify_external_dir, this test
# fails because get_all_skills_dirs() would permanently return a stale
# negative for our target directory (cached at a time it did not exist).
# ---------------------------------------------------------------------------

def test_publish_recovers_from_poisoned_external_dirs_cache(tmp_path, monkeypatch):
    from agent.skill_utils import get_all_skills_dirs

    target = published_skills_dir()
    # Configure the real HERMES_HOME/config.yaml to list our target BEFORE
    # the target directory exists on disk, then force a cache read while it
    # is still absent -- this is exactly the poisoning scenario: upstream's
    # is_dir() filter silently drops it and caches the negative keyed on
    # this config file's current mtime.
    assert not target.exists()
    hermes_home = tmp_path / "hermes_home_poison"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text(
        f"skills:\n  external_dirs:\n    - {target.as_posix()!s}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    skill_publisher._invalidate_upstream_external_dirs_cache()

    # Poison the cache: call the real upstream resolver now, while the
    # directory is still absent, exactly like an unrelated earlier caller
    # would have.
    poisoned = {Path(d).resolve() for d in get_all_skills_dirs()}
    assert target.resolve() not in poisoned, (
        "test setup invariant violated: target must be absent from the "
        "upstream result at poisoning time for this regression test to be "
        "meaningful"
    )

    store = VerifiedSkillStore(tmp_path / "store")
    package = write_package(tmp_path, skill_id="poisoned.cache.skill")
    installed = install_via_store(tmp_path, store, package)

    # This must succeed DESPITE the poisoned cache above: publish_skill is
    # required to create the target dir before checking, and to invalidate
    # and retry once on a negative, per the module's documented cache-trap
    # fix. Without that fix this call raises SkillNotExternallyLoadableError
    # even though the operator's config.yaml is, and always was, correct.
    result = publish_skill(installed["path"], digest=installed["digest"])
    assert result["ok"] is True

    resolved_after = {Path(d).resolve() for d in get_all_skills_dirs()}
    assert target.resolve() in resolved_after

    found = False
    for skills_dir in get_all_skills_dirs():
        skills_dir = Path(skills_dir)
        if not skills_dir.is_dir():
            continue
        if (skills_dir / "poisoned.cache.skill" / "SKILL.md").is_file():
            found = True
            break
    assert found, "skill must be discoverable through the real loader after cache recovery"


# ---------------------------------------------------------------------------
# Test 12: pin the private upstream symbol this module deliberately couples to.
# ---------------------------------------------------------------------------

def test_private_upstream_cache_clear_hook_still_exists(tmp_path, monkeypatch):
    """`skill_publisher` couples to `agent.skill_utils._external_dirs_cache_clear`,
    an underscore-private symbol upstream docstrings as a "Test hook"
    (skill_utils.py:336). `_invalidate_upstream_external_dirs_cache()`
    swallows ImportError best-effort, which is the right *runtime* behaviour
    (a failed invalidation must not itself be fatal -- the caller still fails
    closed if the retried membership check is negative).

    But that same swallow makes an upstream rename SILENT: the retry quietly
    degrades to a no-op re-reading the poisoned cache, and publication then
    fails closed blaming the operator's config.yaml -- which is correct but
    actively misleading, since the config was never the problem.

    This test converts that silent field failure into a loud CI failure on
    the vendor submodule bump that causes it. If it fails, do NOT delete it:
    find upstream's replacement invalidation hook and update the single
    wrapper at skill_publisher.py:_invalidate_upstream_external_dirs_cache.
    """
    from agent import skill_utils

    hook = getattr(skill_utils, "_external_dirs_cache_clear", None)
    assert hook is not None, (
        "agent.skill_utils._external_dirs_cache_clear no longer exists. "
        "The publisher's cache-trap fix has silently degraded to a no-op. "
        "See this test's docstring."
    )
    assert callable(hook)

    # Prove the hook actually clears the cache rather than merely existing --
    # a renamed-but-still-present no-op stub would otherwise pass.
    # A real config.yaml is required: get_external_skills_dirs() returns early
    # WITHOUT caching when the config file is absent (skill_utils.py:354-355),
    # so an unconfigured HERMES_HOME would leave the cache empty and make the
    # assertion below vacuous.
    hermes_home = tmp_path / "pin_check_home"
    (hermes_home / "skills").mkdir(parents=True, exist_ok=True)
    external = tmp_path / "pin_check_external"
    external.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text(
        "skills:\n  external_dirs:\n    - " + external.as_posix() + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    hook()  # start from a known-empty cache
    assert skill_utils.get_external_skills_dirs(), (
        "expected the configured external dir to resolve; test setup is wrong"
    )
    assert skill_utils._EXTERNAL_DIRS_CACHE, (
        "expected get_external_skills_dirs() to populate _EXTERNAL_DIRS_CACHE; "
        "upstream's caching shape changed -- re-verify the cache-trap fix."
    )
    hook()
    assert not skill_utils._EXTERNAL_DIRS_CACHE, (
        "_external_dirs_cache_clear() did not empty _EXTERNAL_DIRS_CACHE; "
        "the publisher's invalidate-and-retry can no longer recover a "
        "poisoned negative."
    )


# ---------------------------------------------------------------------------
# Test 13 (GS-COORD round 2, defect closure): the retention-root assertion
# has real coverage in both directions. G1R found this deletable with a
# green suite -- it is the sole structural defence against the ticket's
# defect #4 (a stale `.torqclaw-doomed-*`/retained copy inside a loadable
# tree silently winning the real loader's first-wins dedup).
# ---------------------------------------------------------------------------

def test_retention_root_outside_loadable_tree_is_accepted(tmp_path, monkeypatch):
    """A true sibling of the published-skills tree (not a member of, and not
    nested under, any real loadable skills directory) must be accepted."""
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    sibling_retain_root = target.parent / "published_skills_retained"
    # Must not raise.
    _assert_retention_root_outside_loadable_tree(sibling_retain_root)


def test_retention_root_inside_loadable_tree_is_rejected(tmp_path, monkeypatch):
    """A retention root nested inside the loadable `published_skills` tree
    (the exact `.torqclaw-doomed-*`-inside-a-loadable-dir trap defect #4
    describes) must be refused, not silently accepted."""
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)
    target.mkdir(parents=True, exist_ok=True)

    dotfile_inside_published = target / ".torqclaw-retained-inside"
    with pytest.raises(SkillPublicationError):
        _assert_retention_root_outside_loadable_tree(dotfile_inside_published)


def test_retention_root_that_IS_a_loadable_dir_is_rejected(tmp_path, monkeypatch):
    """A retention root that resolves to exactly a loadable skills directory
    itself (not merely nested under one) must also be refused."""
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)
    target.mkdir(parents=True, exist_ok=True)

    with pytest.raises(SkillPublicationError):
        _assert_retention_root_outside_loadable_tree(target)


# ---------------------------------------------------------------------------
# Test 14 (GS-COORD round 3, item C): the retention-root assertion must be
# reached through the REAL publish_skill() call site, not merely invoked
# standalone. G2A independently reproduced that deleting the call at
# skill_publisher.py:497 (`_assert_retention_root_outside_loadable_tree(retain_root)`
# inside publish_skill) leaves the full suite green -- the three tests above
# only ever call the helper directly, so they cannot detect its invocation
# being removed. This test drives publish_skill(..., retain_replaced_into=...)
# itself with a retain root INSIDE the loadable published_skills tree (the
# defect #4 trap) and must fail if the call site is deleted.
# ---------------------------------------------------------------------------

def test_publish_skill_rejects_retain_root_inside_loadable_tree_via_real_call(
    tmp_path, monkeypatch
):
    """Drive the real publish_skill() entry point (not the standalone helper)
    with a `retain_replaced_into` path that sits INSIDE the loadable
    `published_skills` tree. This must raise SkillPublicationError and must
    write nothing -- proving the assertion at the publish_skill call site is
    load-bearing, not merely present as dead code the standalone-helper tests
    could not catch being removed.

    Verified by deletion: removing the
    `_assert_retention_root_outside_loadable_tree(retain_root)` call at
    skill_publisher.py:497 makes this test fail (publish_skill would instead
    succeed, or fail later for an unrelated reason), which is the whole point
    -- see the round-3 deletion-probe table in the builder's report.
    """
    target = published_skills_dir()
    _configure_external_dir(monkeypatch, tmp_path, target)

    package = write_package(tmp_path, skill_id="doomed-trap.skill")
    installed = install_via_store(
        tmp_path,
        VerifiedSkillStore(tmp_path / "store_root"),
        package,
    )

    # retain_replaced_into points INSIDE the loadable published_skills tree
    # -- exactly the defect #4 trap (a dot-prefixed retained dir that the
    # real loader's EXCLUDED_SKILL_DIRS does NOT exclude, and which sorts
    # before alphanumeric names in iter_skill_index_files's first-wins dedup).
    bad_retain_root = target / ".torqclaw-retained-inside-real-call"

    with pytest.raises(SkillPublicationError):
        publish_skill(
            installed["path"],
            digest=installed["digest"],
            source="test:round3-item-c",
            retain_replaced_into=bad_retain_root,
        )

    # Nothing must have been written: neither the final published directory
    # nor the rejected retention root nor any temp/doomed artifact.
    assert not (target / "doomed-trap.skill").exists()
    assert not bad_retain_root.exists()
    assert list(target.glob(".torqclaw-publish-*")) == []
    assert list(target.glob(".torqclaw-doomed-*")) == []
