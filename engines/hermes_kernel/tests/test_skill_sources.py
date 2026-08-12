"""P4-3/P4-4: remote source config parser, per-call flag, bounded HTTPS fetch.

Gates: AC-7 (flag off), AC-8 (doctor preflight), AC-13 (redirect/bounds),
SP-3 socket-guard target, DP-12/DP-14.
"""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from mcp_wrapper import skill_sources as s
from mcp_wrapper import skill_trust as t


def _spki():
    return t.public_key_spki_b64url(Ed25519PrivateKey.generate().public_key())


def _write_config(data_dir, sources):
    (data_dir / "skill_sources.json").write_text(
        json.dumps({"schemaVersion": 1, "sources": sources}), encoding="utf-8"
    )


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQCLAW_DATA_DIR", str(tmp_path))
    return tmp_path


def _valid_source():
    return {
        "origin": "https://skills.example.com",
        "baseUrl": "https://skills.example.com/tc",
        "authorities": [{"keyId": "a1", "publicKey": _spki()}],
    }


def test_flag_off_by_default(monkeypatch):
    monkeypatch.delenv("TORQCLAW_REMOTE_SKILL_SOURCES", raising=False)
    assert s.remote_flag_on() is False
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "1")
    assert s.remote_flag_on() is True
    monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", "0")
    assert s.remote_flag_on() is False


def test_dp14_unset_is_not_truthy(monkeypatch):
    for val in ["", "  ", "no", "false", "off"]:
        monkeypatch.setenv("TORQCLAW_REMOTE_SKILL_SOURCES", val)
        assert s.remote_flag_on() is False


def test_config_absent(data_dir):
    with pytest.raises(s.SkillRemoteConfigError):
        s.load_config()


def test_config_valid(data_dir):
    _write_config(data_dir, {"src": _valid_source()})
    config = s.load_config()
    assert "src" in config["sources"]
    auth = s.authorities_map(config)
    assert "https://skills.example.com" in auth


def test_config_rejects_unknown_key(data_dir):
    src = _valid_source()
    src["extra"] = 1
    _write_config(data_dir, {"src": src})
    with pytest.raises(s.SkillRemoteConfigError):
        s.load_config()


def test_config_rejects_http_origin(data_dir):
    src = _valid_source()
    src["origin"] = "http://skills.example.com"
    src["baseUrl"] = "http://skills.example.com/tc"
    _write_config(data_dir, {"src": src})
    with pytest.raises(s.SkillRemoteConfigError):
        s.load_config()


def test_config_rejects_baseurl_outside_origin(data_dir):
    src = _valid_source()
    src["baseUrl"] = "https://evil.example.com/tc"
    _write_config(data_dir, {"src": src})
    with pytest.raises(s.SkillRemoteConfigError):
        s.load_config()


def test_config_rejects_private_key(data_dir):
    src = _valid_source()
    src["authorities"][0]["publicKey"] = "-----BEGIN PRIVATE KEY-----abc"
    _write_config(data_dir, {"src": src})
    with pytest.raises(s.SkillRemoteConfigError):
        s.load_config()


def test_resolve_unknown_source(data_dir):
    _write_config(data_dir, {"src": _valid_source()})
    config = s.load_config()
    with pytest.raises(s.SkillRemoteSourceUnknown):
        s.resolve_source(config, "nope")


# ---------------------------------------------------------------------------
# Fetch bounds / redirect refusal (AC-13)
# ---------------------------------------------------------------------------


def test_fetch_refuses_http():
    with pytest.raises(s.SkillRemoteFetchError):
        s._fetch_bounded("http://x/y", 1024, 1000, 1000)


class _FakeResp:
    def __init__(self, body, status=200):
        self._body = body
        self.status = status

    def read(self, n):
        return self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_bound_over_cap(monkeypatch):
    big = b"x" * 2000

    def fake_open(req, timeout=None):
        return _FakeResp(big)

    monkeypatch.setattr(s.urllib.request, "build_opener", lambda *a: type("O", (), {"open": staticmethod(fake_open)})())
    with pytest.raises(s.SkillRemoteFetchError):
        s._fetch_bounded("https://x/y", 1024, 1000, 1000)


def test_fetch_non_2xx(monkeypatch):
    def fake_open(req, timeout=None):
        return _FakeResp(b"{}", status=301)

    monkeypatch.setattr(s.urllib.request, "build_opener", lambda *a: type("O", (), {"open": staticmethod(fake_open)})())
    with pytest.raises(s.SkillRemoteFetchError):
        s._fetch_bounded("https://x/y", 1024, 1000, 1000)


def test_fetch_success(monkeypatch):
    def fake_open(req, timeout=None):
        return _FakeResp(b'{"ok":true}')

    monkeypatch.setattr(s.urllib.request, "build_opener", lambda *a: type("O", (), {"open": staticmethod(fake_open)})())
    data = s._fetch_bounded("https://x/y", 1024, 1000, 1000)
    assert json.loads(data) == {"ok": True}
