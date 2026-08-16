# Operator Runbook — Signed Remote Skill Sources (Phase 4)

Ships with P4-9. Normative spec: `docs/PRD-TCLAW-REMOTE-SKILL-SOURCES-005.md`
§13 (key management, signing CLI) and §14 (recovery runbook — this document
operationalizes it with copy-pasteable commands; where the two disagree, the
PRD wins).

Flag: `TORQCLAW_REMOTE_SKILL_SOURCES` (default OFF). Also requires
`TORQCLAW_GOVERNED_SKILLS=1`.

---

## 1. Bootstrapping the first pilot publisher (§13)

```bash
# 1. Generate two key pairs: one authority (trust root), one publisher.
#    NEVER inside the repo or $TORQCLAW_DATA_DIR — the CLI refuses both.
python scripts/skill_signing.py keygen --key ~/.torqclaw-signing/authority.pem
python scripts/skill_signing.py keygen --key ~/.torqclaw-signing/publisher.pem
# Each prints its public SPKI (unpadded base64url) — copy it.

# 2. Write $TORQCLAW_DATA_DIR/skill_sources.json with the authority's
#    PUBLIC key only (§5.5). Example:
cat > "$TORQCLAW_DATA_DIR/skill_sources.json" <<'JSON'
{
  "schemaVersion": 1,
  "sources": {
    "my-source": {
      "origin": "https://skills.example.com",
      "baseUrl": "https://skills.example.com/torqclaw",
      "authorities": [{"keyId": "auth-1", "publicKey": "<authority public key>"}]
    }
  }
}
JSON

# 3. Sign trust-bundle sequence 1, trusting the publisher key.
echo '[{"origin":"https://skills.example.com","keyId":"pub-1","publicKey":"<publisher public key>"}]' \
  > trusted_keys.json
python scripts/skill_signing.py sign-bundle \
  --key ~/.torqclaw-signing/authority.pem \
  --origin https://skills.example.com --signing-key-id auth-1 \
  --sequence 1 --trusted-keys trusted_keys.json \
  --output trust-bundle.json

# 4. Sign a skill package.
python scripts/skill_signing.py sign-skill \
  --key ~/.torqclaw-signing/publisher.pem --key-id pub-1 \
  --origin https://skills.example.com \
  --manifest skill.json --skill-md SKILL.md \
  --output envelope.json --write-manifest

# 5. Host trust-bundle.json at <baseUrl>/trust-bundle.json and
#    envelope.json at <baseUrl>/skills/<skillId>.json on ANY static HTTPS
#    host (OQ-1: which host is the operator's own choice; the loopback
#    fixture in tests/test_p4_9_signing_cli.py::test_ac15_full_pilot_dry_run
#    proves the whole chain works end to end without a real host).

# 6. From the operator surface, run:
#    refresh_skill_trust("my-source")
#    install_remote_skill("my-source", "<skillId>")
#    decide_skill(queue_id, "APPROVE")
```

Re-signing a subsequent bundle: pass `--previous <last-accepted-bundle.json>`
to `sign-bundle` so the CLI enforces monotonic `sequence`/`issuedAt` itself
before you ever try to publish a bundle the engine would refuse.

---

## 2. Recovery scenarios (§14)

### 2.1 Clock-rollback quarantine
**Symptom:** `SKILL_TRUST_CLOCK_ROLLBACK` on every remote operation.
**Meaning:** persisted wall time regressed more than 5 minutes, or trust
persistence failed.
**Recovery:** fix the clock, obtain a *strictly newer* signed bundle
(`sequence` AND `issuedAt` both strictly higher — use `--previous` on
`sign-bundle`), then call `refresh_skill_trust`. Replaying the old bundle is
refused by design.

### 2.2 Corrupt trust persistence (bundles only)
**Symptom:** quarantine immediately after kernel start; `skill_trust/
events.log` shows a load-time verification failure.
**Recovery:** delete `$TORQCLAW_DATA_DIR/skill_trust/bundles/<sourceId>.json`
(a cache of signed data, never the root of trust — the roots are the public
keys in `skill_sources.json`), then `refresh_skill_trust`. **Applies ONLY to
`bundles/`** — never to `artifacts/` (§2.3 below) or the whole `skill_trust/`
tree. Deleting `clock.json` is NOT a recovery path.

### 2.3 `artifacts/` is durable evidence — back it up
`skill_trust/artifacts/` holds the only copy of the signature evidence for
each installed remote digest. Loss makes that version permanently
rollback/re-activation-ineligible (`artifact-record-missing`) unless the
publisher still serves the identical digest — re-running
`install_remote_skill` re-persists it iff the digest matches. **Back this
directory up together with `state.json`.**

### 2.4 Stale bundle
**Symptom:** `SKILL_TRUST_STALE` (retryable).
**Recovery:** `refresh_skill_trust(source_id)`, then retry. There is no
background refresher (a deliberate deferral, §16 D-1) — schedule
`refresh_skill_trust` externally (cron, systemd timer) if you need tighter
than "discovered at the next governed operation."

### 2.5 Governed audit at capacity
- A **remote** transaction refuses with `SkillAuditCapacityError` BEFORE any
  mutation (the R-9 headroom pre-check).
- A **local** revert/restore at capacity now fails closed (previously
  silently dropped the audit record).
- If a remote result ever carries `auditOverflow: true`, that is a red flag
  the headroom check was bypassed — file a defect. The diverted record is at
  `$TORQCLAW_DATA_DIR/skill_audit_overflow.log`.

Either way: the governed audit log is genuinely full at 1,000 entries — the
existing capacity-exhaustion operator action applies.

### 2.6 Revocation hits an ACTIVE version
**Symptom:** `refresh_skill_trust` returns `revocationsAffectingInstalled`
with an `active: true` entry (also logged to `events.log`).
**Meaning:** a currently active skill's key or digest is now revoked. It
**stays active and prompt-rendered until you act** — refresh only reports,
never auto-disables.
**Action:** run `disable_skill(skill_id)`, or `rollback_skill` to an
unaffected installed digest.

---

## 3. Operational notes

- **Windows key storage:** default `~/.torqclaw-signing/`, a sibling of
  `~/.torqclaw`, deliberately outside `$TORQCLAW_DATA_DIR` so data-dir
  backups/exports never sweep private key material. Harden with `icacls`
  (guidance, not enforcement) — e.g.
  `icacls %USERPROFILE%\.torqclaw-signing /inheritance:r /grant:r %USERNAME%:F`.
- **One hosting path per signature:** a package's signature binds it to
  the exact fetch URL in its manifest `source` field. Moving a source to a
  new URL requires re-signing every package.
- **TTL defaults** (24h max bundle window, 72h hard expiry, 2min skew, 5min
  restart clock-regression tolerance) are the pilot values, binding until
  re-ratified by the operator (OQ-2). Not currently CLI-configurable.
- **Capability pilot bound (R-7):** a remote skill declaring any capability
  beyond `["read"]` is refused outright (`SKILL_TRUST_CAPABILITY_
  UNSUPPORTED`). Lifted only by a future capability-delta approval UX
  phase — not something an operator can override today.
- **`doctor` preflight:** with the flag on, `pnpm doctor` (or
  `python -m mcp_wrapper.remote_preflight` directly) checks
  `skill_sources.json` parses, every authority key is a valid Ed25519 SPKI
  key, and `skill_trust/` is writable, before you try anything live.
