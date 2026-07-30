"""Durable, isolated provider-attempt ledger for the resilience P0.

Importing this module performs no filesystem or database I/O. AttemptLedger
receives an injected SQLite path and authorizes every provider mutation against
the exact active (task_id, attempt_id, epoch) tuple inside BEGIN IMMEDIATE.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

LEDGER_SCHEMA_VERSION = 2
IMMUTABLE_PLAN_SCHEMA_VERSION = 1
# Kept as a compatibility alias for callers that imported the old name.  It
# is deliberately the plan version, never the ledger version.
SCHEMA_VERSION = IMMUTABLE_PLAN_SCHEMA_VERSION
_HASH = re.compile(r"^[a-f0-9]{64}$")
_SAFE_TOKEN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PROVIDER_STATE_VERSION = 1
PROVIDER_STATES = frozenset({
    "provider_ready", "provider_started", "queued", "starting",
    "connecting", "thinking", "processing", "streaming", "receiving",
    "waiting", "progress",
})
_LEDGER_MUTABLE_STATES = PROVIDER_STATES | frozenset(("active",))
_PROVIDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_VISIBLE_ASCII = re.compile(r"^[!-~]+$")
_SAFE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_SAFE_INTEGER_MAX = (1 << 53) - 1
_FAILURES = {"retryable", "configuration", "authentication", "budget",
             "side_effect_uncertainty", "timeout", "cancelled", "terminal"}
_NONTERMINAL_STATE_SQL = "state IN (" + ",".join(
    f"'{state}'" for state in sorted(_LEDGER_MUTABLE_STATES)
) + ")"
_FORBIDDEN = ("credential", "secret", "password", "token", "cookie",
              "authorization", "apikey", "rawerror", "errorbody",
              "providererror", "headers", "error")
_FORBIDDEN_PROVIDER_PARTS = ("credential", "secret", "password", "token",
                              "cookie", "authorization", "apikey",
                              "providererror", "headers")
_OUTBOX_KINDS = {
    "attempt_created", "provider_event", "dispatch_attempted", "cost_recorded",
    "state_mutated", "cancel_requested", "attempt_completed", "transitioned",
    "pre_dispatch_recovered",
}
_RETRYABLE_CODES = frozenset({
    "connection", "dns", "http_408", "http_429", "http_5xx",
    "pre_dispatch_timeout", "deterministic_timeout", "crash",
})


class LedgerError(Exception):
    pass


class InvalidPlanError(LedgerError):
    pass


class AdmissionRejected(LedgerError):
    pass


class TaskAlreadyExists(LedgerError):
    pass


class UnsupportedSchemaVersion(LedgerError):
    pass


class CorruptLedger(LedgerError):
    pass


@dataclass(frozen=True)
class ActiveTuple:
    task_id: str
    attempt_id: str
    epoch: int

    def as_dict(self) -> dict[str, Any]:
        return {"taskId": self.task_id, "attemptId": self.attempt_id, "epoch": self.epoch}


class AttemptLedger:
    def __init__(self, db_path: str | Path, *, now_ms: Callable[[], int] | None = None):
        self.db_path = str(db_path)
        self._now = now_ms or (lambda: int(time.time() * 1000))
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def _initialize(self) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("CREATE TABLE IF NOT EXISTS ledger_meta "
                         "(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            row = conn.execute("SELECT value FROM ledger_meta "
                               "WHERE key='schema_version'").fetchone()
            created = row is None
            if row is None:
                if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                                "AND name<>'ledger_meta'").fetchone():
                    raise UnsupportedSchemaVersion("unversioned ledger")
                self._create_schema(conn)
                conn.execute("INSERT INTO ledger_meta VALUES('schema_version', ?)",
                             (str(LEDGER_SCHEMA_VERSION),))
                self._assert_schema(conn)
            else:
                version = int(row["value"])
                if version == 1:
                    self._migrate_v1_to_v2(conn)
                    conn.execute("UPDATE ledger_meta SET value=? WHERE key='schema_version'",
                                 (str(LEDGER_SCHEMA_VERSION),))
                elif version != LEDGER_SCHEMA_VERSION:
                    raise UnsupportedSchemaVersion(
                        f"unsupported ledger schema {version}; supported {LEDGER_SCHEMA_VERSION}")
                self._assert_schema(conn)
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def _create_schema(conn: sqlite3.Connection) -> None:
        statements = [
        """CREATE TABLE tasks(
          task_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, plan_hash TEXT NOT NULL,
          status TEXT NOT NULL, transitions_used INTEGER NOT NULL CHECK(transitions_used>=0),
          transition_limit INTEGER NOT NULL CHECK(transition_limit>=0),
          deadline_ms INTEGER NOT NULL CHECK(deadline_ms>0),
          budget_micro_usd INTEGER CHECK(budget_micro_usd IS NULL OR budget_micro_usd>=0),
          reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
          created_at_ms INTEGER NOT NULL)""",
        """CREATE TABLE attempts(
          task_id TEXT NOT NULL REFERENCES tasks(task_id), epoch INTEGER NOT NULL CHECK(epoch>=0),
          attempt_id TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL, state TEXT NOT NULL,
          dispatch_attempted INTEGER NOT NULL CHECK(dispatch_attempted IN(0,1)),
          cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN(0,1)),
          reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
          actual_cost_known INTEGER NOT NULL CHECK(actual_cost_known IN(0,1)),
          actual_cost_micro_usd INTEGER CHECK(actual_cost_micro_usd IS NULL OR actual_cost_micro_usd>=0),
          failure_json TEXT, created_at_ms INTEGER NOT NULL, closed_at_ms INTEGER,
          PRIMARY KEY(task_id,epoch), UNIQUE(task_id,attempt_id))""",
        """CREATE TABLE active_control(
          task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), attempt_id TEXT NOT NULL UNIQUE,
          epoch INTEGER NOT NULL, status TEXT NOT NULL,
          FOREIGN KEY(task_id,epoch) REFERENCES attempts(task_id,epoch))""",
        """CREATE TABLE provider_events(
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL, epoch INTEGER NOT NULL, event_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          FOREIGN KEY(task_id,epoch) REFERENCES attempts(task_id,epoch))""",
        """CREATE TABLE outbox(
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL, epoch INTEGER NOT NULL, kind TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          FOREIGN KEY(task_id,epoch) REFERENCES attempts(task_id,epoch))""",
        """CREATE TABLE projection_dedupe(
          outbox_id INTEGER PRIMARY KEY REFERENCES outbox(outbox_id),
          projected_at_ms INTEGER NOT NULL)""",
        """CREATE TABLE circuit_failures(
          failure_id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL,
          failed_at_ms INTEGER NOT NULL)""",
        """CREATE INDEX circuit_failures_lookup
          ON circuit_failures(provider_id,failed_at_ms)""",
        """CREATE TABLE circuit_transition_authority(
          transition_outbox_id INTEGER PRIMARY KEY REFERENCES outbox(outbox_id),
          predecessor_task_id TEXT NOT NULL,
          predecessor_attempt_id TEXT NOT NULL,
          predecessor_epoch INTEGER NOT NULL,
          predecessor_provider_id TEXT NOT NULL,
          successor_task_id TEXT NOT NULL,
          successor_attempt_id TEXT NOT NULL,
          successor_epoch INTEGER NOT NULL,
          successor_provider_id TEXT NOT NULL,
          witness_created_at_ms INTEGER NOT NULL,
          witness_digest TEXT NOT NULL)""",
        """CREATE INDEX circuit_transition_authority_lookup
          ON circuit_transition_authority(predecessor_provider_id,
             witness_created_at_ms, transition_outbox_id)""",
        """CREATE TABLE mutation_idempotency(
          operation TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          task_id TEXT,
          attempt_id TEXT,
          epoch INTEGER,
          result_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY(operation,idempotency_key))""",
        """CREATE TABLE tool_fences(
          task_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_digest TEXT NOT NULL,
          fenced_at_ms INTEGER NOT NULL,
          PRIMARY KEY(task_id,attempt_id,epoch,tool_call_id),
          FOREIGN KEY(task_id,epoch) REFERENCES attempts(task_id,epoch))""",
        ]
        for statement in statements:
            conn.execute(statement)

    @staticmethod
    def _authority_digest(payload: Mapping[str, Any]) -> str:
        return hashlib.sha256(
            AttemptLedger._json(payload).encode("utf-8")
        ).hexdigest()

    @classmethod
    def _witness_payload(cls, transition_id: int, predecessor: ActiveTuple,
                         predecessor_provider: str, successor: ActiveTuple,
                         successor_provider: str, witness_created_at_ms: int) -> dict[str, Any]:
        return {
            "transitionOutboxId": transition_id,
            "predecessor": predecessor.as_dict(),
            "predecessorProviderId": predecessor_provider,
            "successor": successor.as_dict(),
            "successorProviderId": successor_provider,
            "witnessCreatedAtMs": witness_created_at_ms,
        }

    @classmethod
    def _witness_digest(cls, transition_id: int, predecessor: ActiveTuple,
                        predecessor_provider: str, successor: ActiveTuple,
                        successor_provider: str, witness_created_at_ms: int) -> str:
        return cls._authority_digest(cls._witness_payload(
            transition_id, predecessor, predecessor_provider, successor,
            successor_provider, witness_created_at_ms))

    @classmethod
    def _insert_witness(cls, conn: sqlite3.Connection, transition_id: int,
                        predecessor: ActiveTuple, predecessor_provider: str,
                        successor: ActiveTuple, successor_provider: str,
                        witness_created_at_ms: int) -> None:
        digest = cls._witness_digest(
            transition_id, predecessor, predecessor_provider, successor,
            successor_provider, witness_created_at_ms)
        conn.execute(
            "INSERT INTO circuit_transition_authority VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (transition_id, predecessor.task_id, predecessor.attempt_id,
             predecessor.epoch, predecessor_provider, successor.task_id,
             successor.attempt_id, successor.epoch, successor_provider,
            witness_created_at_ms, digest),
        )

    @staticmethod
    def _record_diagnostic_failure(conn: sqlite3.Connection, provider_id: str,
                                   failed_at_ms: int) -> None:
        # Diagnostic data must never be required for authorization or even for
        # a successful transition. Operators may delete or rebuild this table.
        try:
            conn.execute(
                "INSERT INTO circuit_failures(provider_id,failed_at_ms) VALUES(?,?)",
                (provider_id, failed_at_ms),
            )
        except sqlite3.Error:
            pass

    @classmethod
    def _migrate_v1_to_v2(cls, conn: sqlite3.Connection) -> None:
        """Rebuild the bounded authority index without guessing facts."""
        cls._assert_v1_schema(conn)
        had_authority = bool(conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='circuit_transition_authority'"
        ).fetchone())
        if not had_authority:
            conn.execute("""CREATE TABLE circuit_transition_authority(
              transition_outbox_id INTEGER PRIMARY KEY REFERENCES outbox(outbox_id),
              predecessor_task_id TEXT NOT NULL, predecessor_attempt_id TEXT NOT NULL,
              predecessor_epoch INTEGER NOT NULL, predecessor_provider_id TEXT NOT NULL,
              successor_task_id TEXT NOT NULL, successor_attempt_id TEXT NOT NULL,
              successor_epoch INTEGER NOT NULL, successor_provider_id TEXT NOT NULL,
              witness_created_at_ms INTEGER NOT NULL, witness_digest TEXT NOT NULL)""")
        conn.execute("""CREATE INDEX IF NOT EXISTS circuit_transition_authority_lookup
          ON circuit_transition_authority(predecessor_provider_id,
             witness_created_at_ms, transition_outbox_id)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS mutation_idempotency(
          operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          task_id TEXT, attempt_id TEXT, epoch INTEGER, result_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY(operation,idempotency_key))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS tool_fences(
          task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, epoch INTEGER NOT NULL,
          tool_call_id TEXT NOT NULL, tool_digest TEXT NOT NULL, fenced_at_ms INTEGER NOT NULL,
          PRIMARY KEY(task_id,attempt_id,epoch,tool_call_id),
          FOREIGN KEY(task_id,epoch) REFERENCES attempts(task_id,epoch))""")
        transition_rows = conn.execute(
            "SELECT outbox_id,task_id,attempt_id,epoch,payload_json,created_at_ms "
            "FROM outbox WHERE kind='transitioned' ORDER BY outbox_id"
        ).fetchall()
        seen_predecessors: set[tuple[str, str, int]] = set()
        for fact in transition_rows:
            successor = cls._tuple({"taskId": fact["task_id"],
                                    "attemptId": fact["attempt_id"],
                                    "epoch": fact["epoch"]})
            predecessor, predecessor_provider, successor_provider, _ = (
                cls._transition_fact_payload(cls._strict_fact_payload(fact["payload_json"]))
            )
            if (predecessor.task_id != successor.task_id or
                    predecessor.epoch + 1 != successor.epoch or
                    predecessor.epoch < 0):
                raise CorruptLedger("migration transition tuple is invalid")
            predecessor_key = predecessor.as_dict()
            predecessor_identity, predecessor_fact_id, _ = cls._authoritative_identity(
                conn, predecessor)
            successor_identity, successor_fact_id, successor_created = cls._authoritative_identity(
                conn, successor)
            if (predecessor_identity != predecessor_provider or
                    successor_identity != successor_provider or
                    predecessor_fact_id >= fact["outbox_id"] or
                    successor_fact_id != fact["outbox_id"] or
                    successor_created != cls._time_ms(fact["created_at_ms"])):
                raise CorruptLedger("migration transition identity mismatch")
            if tuple(predecessor_key.values()) in seen_predecessors:
                raise CorruptLedger("migration has duplicate predecessor witness")
            seen_predecessors.add(tuple(predecessor_key.values()))
            existing = conn.execute(
                "SELECT * FROM circuit_transition_authority "
                "WHERE transition_outbox_id=?", (fact["outbox_id"],)
            ).fetchall()
            if had_authority and len(existing) != 1:
                raise CorruptLedger("migration witness is missing or duplicated")
            if not existing:
                cls._insert_witness(
                    conn, fact["outbox_id"], predecessor, predecessor_provider,
                    successor, successor_provider, successor_created,
                )
            else:
                row = existing[0]
                expected_digest = cls._witness_digest(
                    fact["outbox_id"], predecessor, predecessor_provider,
                    successor, successor_provider, successor_created,
                )
                if (row["predecessor_task_id"] != predecessor.task_id or
                        row["predecessor_attempt_id"] != predecessor.attempt_id or
                        row["predecessor_epoch"] != predecessor.epoch or
                        row["predecessor_provider_id"] != predecessor_provider or
                        row["successor_task_id"] != successor.task_id or
                        row["successor_attempt_id"] != successor.attempt_id or
                        row["successor_epoch"] != successor.epoch or
                        row["successor_provider_id"] != successor_provider or
                        row["witness_created_at_ms"] != successor_created or
                        row["witness_digest"] != expected_digest):
                    raise CorruptLedger("migration witness does not reconcile")
        if had_authority:
            count = conn.execute(
                "SELECT COUNT(*) FROM circuit_transition_authority"
            ).fetchone()[0]
            if count != len(transition_rows):
                raise CorruptLedger("migration has an extra authority witness")

    @staticmethod
    def _assert_v1_schema(conn: sqlite3.Connection) -> None:
        required = {"tasks", "attempts", "active_control", "provider_events", "outbox"}
        found = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if required - found:
            raise CorruptLedger(f"missing tables: {sorted(required - found)}")

    @staticmethod
    def _assert_schema(conn: sqlite3.Connection) -> None:
        required = {"tasks", "attempts", "active_control", "provider_events", "outbox",
                    "circuit_transition_authority", "mutation_idempotency", "tool_fences"}
        found = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if required - found:
            raise CorruptLedger(f"missing tables: {sorted(required - found)}")
        columns = {r["name"] for r in conn.execute(
            "PRAGMA table_info(circuit_transition_authority)")}
        expected = {
            "transition_outbox_id", "predecessor_task_id", "predecessor_attempt_id",
            "predecessor_epoch", "predecessor_provider_id", "successor_task_id",
            "successor_attempt_id", "successor_epoch", "successor_provider_id",
            "witness_created_at_ms", "witness_digest",
        }
        if columns != expected:
            raise CorruptLedger("circuit authority schema is invalid")
        index = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name='circuit_transition_authority_lookup'")}
        if not index:
            raise CorruptLedger("circuit authority index is missing")

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    @staticmethod
    def _strict_fact_payload(encoded: Any) -> dict[str, Any]:
        if not isinstance(encoded, str):
            raise CorruptLedger("outbox fact payload is not encoded JSON")

        def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate key: {key}")
                result[key] = value
            return result

        try:
            payload = json.loads(encoded, object_pairs_hook=unique_object)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CorruptLedger("outbox fact payload is malformed") from exc
        if not isinstance(payload, dict):
            raise CorruptLedger("outbox fact payload must be an object")
        return payload

    @staticmethod
    def _js_length(value: str) -> int:
        """Match JavaScript String.length for cross-language schema bounds."""
        return len(value.encode("utf-16-le")) // 2

    @classmethod
    def _plan_hash(cls, plan: Mapping[str, Any]) -> str:
        return hashlib.sha256(cls._json(plan).encode()).hexdigest()

    @classmethod
    def _secret_free(cls, value: Any) -> None:
        if isinstance(value, Mapping):
            for key, child in value.items():
                if not isinstance(key, str):
                    raise InvalidPlanError("object keys must be strings")
                token = key.lower().replace("_", "").replace("-", "")
                if any(part in token for part in _FORBIDDEN):
                    raise InvalidPlanError(f"forbidden field: {key}")
                cls._secret_free(child)
        elif isinstance(value, list):
            for child in value:
                cls._secret_free(child)

    @staticmethod
    def _micro(value: Any, error_type: type[LedgerError] = InvalidPlanError) -> None:
        if (isinstance(value, bool) or not isinstance(value, int) or
                value < 0 or value > _SAFE_INTEGER_MAX):
            raise error_type("micro-USD must be a nonnegative integer")

    @staticmethod
    def _time_ms(value: Any) -> int:
        if (isinstance(value, bool) or not isinstance(value, int) or
                value <= 0 or value > _SAFE_INTEGER_MAX):
            raise CorruptLedger("timestamp is outside the safe integer range")
        return value

    @staticmethod
    def _provider_id(value: Any, error_type: type[LedgerError] = InvalidPlanError) -> str:
        if not isinstance(value, str) or not _PROVIDER_ID.fullmatch(value):
            raise error_type("provider id is invalid")
        normalized = value.lower().replace("_", "").replace("-", "")
        if any(part in normalized for part in _FORBIDDEN_PROVIDER_PARTS):
            raise error_type("provider id is invalid")
        return value

    @staticmethod
    def _provider_state(value: Any, error_type: type[LedgerError] = LedgerError) -> str:
        if not isinstance(value, str) or value not in PROVIDER_STATES:
            raise error_type("state is not a provider state")
        return value

    @staticmethod
    def _persisted_state(value: Any) -> str:
        if value in {"active", "closed", "orphaned", "terminal", "cancel_requested"}:
            return value
        return AttemptLedger._provider_state(value, CorruptLedger)

    @staticmethod
    def _bounded_text(value: Any, maximum: int,
                      error_type: type[LedgerError] = InvalidPlanError) -> str:
        if (not isinstance(value, str) or not 1 <= len(value) <= maximum or
                not _VISIBLE_ASCII.fullmatch(value)):
            raise error_type("bounded text is invalid")
        return value

    @classmethod
    def _validate_plan(cls, task_id: str, plan: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(plan, Mapping):
            raise InvalidPlanError("plan must be an object")
        cls._secret_free(plan)
        fields = {"schemaVersion", "taskId", "chainId", "eligibleProviderIds",
                  "privacyClass", "privacyHash", "policyHash", "contextHash",
                  "grantHash", "taskDeadlineMs", "attemptTimeoutMs",
                  "transitionLimit", "budgetMicroUsd", "providerCeilings",
                  "featurePolicyRevision", "planRevision"}
        if set(plan) != fields or plan["schemaVersion"] != IMMUTABLE_PLAN_SCHEMA_VERSION:
            raise InvalidPlanError("immutable plan fields/version are invalid")
        if (not isinstance(task_id, str) or cls._bounded_text(task_id, 256) != task_id or
                plan["taskId"] != task_id or
                cls._bounded_text(plan["taskId"], 256) != plan["taskId"]):
            raise InvalidPlanError("task binding is invalid")
        providers = plan["eligibleProviderIds"]
        if not isinstance(providers, list) or not providers or len(providers) > 64:
            raise InvalidPlanError("eligible providers are invalid")
        for provider in providers:
            cls._provider_id(provider)
        if len(set(providers)) != len(providers):
            raise InvalidPlanError("eligible providers are invalid")
        ceilings = plan["providerCeilings"]
        if not isinstance(ceilings, Mapping) or set(providers) - set(ceilings):
            raise InvalidPlanError("each eligible provider needs a ceiling")
        for provider in ceilings:
            cls._provider_id(provider)
        for value in ceilings.values():
            cls._micro(value)
        for name in ("privacyHash", "policyHash", "contextHash", "grantHash"):
            if not isinstance(plan[name], str) or not _HASH.fullmatch(plan[name]):
                raise InvalidPlanError(f"{name} must be a SHA-256 hash")
        for name in ("chainId", "privacyClass", "featurePolicyRevision", "planRevision"):
            try:
                cls._bounded_text(plan[name], 128)
            except InvalidPlanError as exc:
                raise InvalidPlanError(f"{name} is invalid") from exc
        for name in ("taskDeadlineMs", "attemptTimeoutMs"):
            value = plan[name]
            if (isinstance(value, bool) or not isinstance(value, int) or
                    value <= 0 or value > _SAFE_INTEGER_MAX):
                raise InvalidPlanError(f"{name} must be positive")
        limit = plan["transitionLimit"]
        if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 64:
            raise InvalidPlanError("transitionLimit is invalid")
        if limit > len(providers) - 1:
            raise InvalidPlanError("transitionLimit exceeds provider chain")
        if plan["budgetMicroUsd"] is not None:
            cls._micro(plan["budgetMicroUsd"])
        return json.loads(cls._json(plan))

    @staticmethod
    def _tuple(value: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any]) -> ActiveTuple:
        if isinstance(value, ActiveTuple):
            result = value
        elif isinstance(value, Mapping):
            result = ActiveTuple(value.get("taskId"), value.get("attemptId"), value.get("epoch"))
        elif isinstance(value, tuple) and len(value) == 3:
            result = ActiveTuple(*value)
        else:
            raise LedgerError("active tuple is invalid")
        if (AttemptLedger._bounded_text(result.task_id, 256, LedgerError) != result.task_id or
                AttemptLedger._bounded_text(result.attempt_id, 128, LedgerError) != result.attempt_id or
                isinstance(result.epoch, bool) or not isinstance(result.epoch, int) or
                not 0 <= result.epoch <= _SAFE_INTEGER_MAX):
            raise LedgerError("active tuple is invalid")
        return result

    @classmethod
    def _payload(cls, payload: Mapping[str, Any] | None) -> dict[str, Any]:
        if payload is None:
            return {}
        if not isinstance(payload, Mapping):
            raise LedgerError("payload must be an object")
        try:
            safe, _ = cls._canonical_payload(payload)
        except (TypeError, ValueError, OverflowError) as exc:
            raise LedgerError("payload contains an unsupported value") from exc
        encoded = cls._json(safe)
        if len(encoded) > 64_000:
            raise LedgerError("payload is too large")
        return json.loads(encoded)

    @classmethod
    def _canonical_payload(cls, value: Any, depth: int = 0) -> tuple[Any, int]:
        """Return a bounded, non-reversible representation of caller data."""
        if depth > 12:
            raise ValueError("payload nesting is too deep")
        if value is None or isinstance(value, bool):
            return value, 1
        if isinstance(value, int):
            if abs(value) > _SAFE_INTEGER_MAX:
                raise ValueError("payload integer is unsafe")
            return value, 1
        if isinstance(value, str):
            if cls._js_length(value) > 16_384:
                raise ValueError("payload string is too large")
            return {"sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
                    "length": cls._js_length(value)}, 1
        if isinstance(value, list):
            if len(value) > 256:
                raise ValueError("payload array is too large")
            result: list[Any] = []
            count = 1
            for child in value:
                safe, child_count = cls._canonical_payload(child, depth + 1)
                result.append(safe)
                count += child_count
            if count > 2048:
                raise ValueError("payload has too many values")
            return result, count
        if isinstance(value, Mapping):
            if set(value) == {"sha256", "length"}:
                digest, length = value["sha256"], value["length"]
                if (not isinstance(digest, str) or not _HASH.fullmatch(digest) or
                        isinstance(length, bool) or not isinstance(length, int) or
                        not 0 <= length <= 16_384):
                    raise ValueError("invalid hash envelope")
                return {"sha256": digest, "length": length}, 1
            if len(value) > 128:
                raise ValueError("payload object is too large")
            result: dict[str, Any] = {}
            count = 1
            for key, child in value.items():
                if (not isinstance(key, str) or not _SAFE_KEY.fullmatch(key) or
                        any(part in key.lower().replace("_", "").replace("-", "")
                            for part in _FORBIDDEN)):
                    raise ValueError("payload contains an unsafe key")
                safe, child_count = cls._canonical_payload(child, depth + 1)
                result[key] = safe
                count += child_count
            if count > 2048:
                raise ValueError("payload has too many values")
            return result, count
        raise TypeError(type(value).__name__)

    @classmethod
    def _active(cls, conn: sqlite3.Connection, expected: ActiveTuple) -> sqlite3.Row | None:
        row = conn.execute("""
          SELECT a.*,t.plan_json,t.plan_hash,t.status AS task_status,
                 t.transitions_used,t.transition_limit,t.deadline_ms,
                 t.budget_micro_usd,t.reserved_micro_usd AS task_reserved
            FROM active_control c
            JOIN attempts a ON a.task_id=c.task_id AND a.attempt_id=c.attempt_id
                            AND a.epoch=c.epoch
            JOIN tasks t ON t.task_id=a.task_id
           WHERE c.task_id=? AND c.attempt_id=? AND c.epoch=?
             AND c.status='active'
             AND a.cancel_requested=0 AND t.status='running'
        """, (expected.task_id, expected.attempt_id, expected.epoch)).fetchone()
        if row is not None:
            cls._persisted_state(row["state"])
            cls._checked_plan(row, conn)
        return row

    @staticmethod
    def _require_one_attempt_mutation(cursor: sqlite3.Cursor, operation: str) -> None:
        if cursor.rowcount != 1:
            raise CorruptLedger(f"{operation} mutated {cursor.rowcount} attempt rows")

    @classmethod
    def _completion_row(cls, conn: sqlite3.Connection,
                        expected: ActiveTuple) -> sqlite3.Row | None:
        # This is called inside BEGIN IMMEDIATE. active_control is the
        # authority for writes, and the exact attempt tuple must match it.
        row = cls._active(conn, expected)
        if row is None:
            return None
        return row

    @classmethod
    def _checked_plan(cls, row: sqlite3.Row,
                      conn: sqlite3.Connection | None = None) -> dict[str, Any]:
        plan = cls._validate_plan(row["task_id"], json.loads(row["plan_json"]))
        plan_digest = cls._plan_hash(plan)
        if plan_digest != row["plan_hash"]:
            raise CorruptLedger("immutable plan hash mismatch")
        if (row["deadline_ms"] != plan["taskDeadlineMs"] or
                row["transition_limit"] != plan["transitionLimit"] or
                row["budget_micro_usd"] != plan["budgetMicroUsd"]):
            raise CorruptLedger("materialized plan authority mismatch")
        try:
            cls._time_ms(row["deadline_ms"])
            cls._micro(row["budget_micro_usd"], CorruptLedger) if row["budget_micro_usd"] is not None else None
            cls._micro(row["task_reserved"], CorruptLedger)
            cls._micro(row["reserved_micro_usd"], CorruptLedger)
        except (TypeError, ValueError) as exc:
            raise CorruptLedger("materialized micro-USD or timestamp is invalid") from exc
        if (not isinstance(row["transitions_used"], int) or
                not 0 <= row["transitions_used"] <= plan["transitionLimit"] or
                row["transitions_used"] != row["epoch"] or
                row["epoch"] > len(plan["eligibleProviderIds"]) - 1):
            raise CorruptLedger("transition counters are invalid")
        provider = row["provider_id"]
        cls._provider_id(provider, CorruptLedger)
        try:
            provider_index = plan["eligibleProviderIds"].index(provider)
        except ValueError as exc:
            raise CorruptLedger("active provider is not eligible") from exc
        if provider_index < row["epoch"]:
            raise CorruptLedger("active provider is out of chain order")
        if row["task_reserved"] < row["reserved_micro_usd"]:
            raise CorruptLedger("task reservation is below active reservation")
        if bool(row["actual_cost_known"]):
            if row["actual_cost_micro_usd"] is None:
                raise CorruptLedger("known actual cost is missing")
            cls._micro(row["actual_cost_micro_usd"], CorruptLedger)
            if row["reserved_micro_usd"] != row["actual_cost_micro_usd"]:
                raise CorruptLedger("active reservation does not match known cost")
        elif row["actual_cost_micro_usd"] is not None:
            raise CorruptLedger("unknown actual cost is populated")
        if conn is not None:
            attempts = conn.execute(
                "SELECT task_id,epoch,attempt_id,provider_id,state,dispatch_attempted,"
                "cancel_requested,reserved_micro_usd,actual_cost_known,"
                "actual_cost_micro_usd,failure_json,created_at_ms,closed_at_ms FROM attempts "
                "WHERE task_id=? ORDER BY epoch",
                (row["task_id"],),
            ).fetchall()
            if (len(attempts) != row["transitions_used"] + 1 or
                    [attempt["epoch"] for attempt in attempts] != list(range(len(attempts)))):
                raise CorruptLedger("attempt epochs do not match transition count")

            attempts_by_key: dict[tuple[str, str, int], sqlite3.Row] = {}
            attempts_by_epoch: dict[int, sqlite3.Row] = {}
            for attempt in attempts:
                cls._bounded_text(attempt["task_id"], 256, CorruptLedger)
                cls._bounded_text(attempt["attempt_id"], 128, CorruptLedger)
                if (isinstance(attempt["epoch"], bool) or
                        not isinstance(attempt["epoch"], int) or
                        not 0 <= attempt["epoch"] <= _SAFE_INTEGER_MAX):
                    raise CorruptLedger("attempt epoch is invalid")
                key = (attempt["task_id"], attempt["attempt_id"], attempt["epoch"])
                if key in attempts_by_key:
                    raise CorruptLedger("duplicate attempt tuple")
                attempts_by_key[key] = attempt
                attempts_by_epoch[attempt["epoch"]] = attempt

            identity_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            cost_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            state_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            dispatch_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            cancel_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            completion_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            recovery_facts: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            facts = conn.execute(
                "SELECT outbox_id,task_id,attempt_id,epoch,kind,payload_json,created_at_ms "
                "FROM outbox WHERE task_id=? AND kind IN "
                "('attempt_created','transitioned','cost_recorded','state_mutated',"
                "'dispatch_attempted','cancel_requested','attempt_completed',"
                "'pre_dispatch_recovered') ORDER BY outbox_id",
                (row["task_id"],),
            ).fetchall()
            for fact in facts:
                if (isinstance(fact["outbox_id"], bool) or
                        not isinstance(fact["outbox_id"], int) or
                        not 1 <= fact["outbox_id"] <= _SAFE_INTEGER_MAX):
                    raise CorruptLedger("outbox fact id is invalid")
                cls._time_ms(fact["created_at_ms"])
                cls._bounded_text(fact["task_id"], 256, CorruptLedger)
                cls._bounded_text(fact["attempt_id"], 128, CorruptLedger)
                if (isinstance(fact["epoch"], bool) or
                        not isinstance(fact["epoch"], int) or
                        not 0 <= fact["epoch"] <= _SAFE_INTEGER_MAX):
                    raise CorruptLedger("outbox fact epoch is invalid")
                key = (fact["task_id"], fact["attempt_id"], fact["epoch"])
                if key not in attempts_by_key:
                    raise CorruptLedger("outbox fact does not match an attempt tuple")
                payload = cls._strict_fact_payload(fact["payload_json"])
                fact_record = {
                    "kind": fact["kind"], "payload": payload,
                    "outboxId": fact["outbox_id"], "createdAtMs": fact["created_at_ms"],
                }
                if fact["kind"] in {"attempt_created", "transitioned"}:
                    identity_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "cost_recorded":
                    if set(payload) != {"actualCostMicroUsd", "known"}:
                        raise CorruptLedger("cost fact shape is invalid")
                    known = payload["known"]
                    actual = payload["actualCostMicroUsd"]
                    if not isinstance(known, bool):
                        raise CorruptLedger("cost fact known flag is invalid")
                    if known:
                        cls._micro(actual, CorruptLedger)
                    elif actual is not None:
                        raise CorruptLedger("unknown cost fact contains an actual cost")
                    cost_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "state_mutated":
                    if set(payload) != {"state", "payload"}:
                        raise CorruptLedger("state fact shape is invalid")
                    try:
                        state = cls._provider_state(payload["state"], CorruptLedger)
                        safe_payload = cls._payload(payload["payload"])
                    except LedgerError as exc:
                        raise CorruptLedger("state fact is invalid") from exc
                    if safe_payload != payload["payload"]:
                        raise CorruptLedger("state fact payload is not canonical")
                    fact_record["state"] = state
                    state_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "dispatch_attempted":
                    if payload:
                        raise CorruptLedger("dispatch fact shape is invalid")
                    dispatch_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "cancel_requested":
                    if payload:
                        raise CorruptLedger("cancel fact shape is invalid")
                    cancel_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "pre_dispatch_recovered":
                    if payload:
                        raise CorruptLedger("recovery fact shape is invalid")
                    recovery_facts.setdefault(key, []).append(fact_record)
                elif fact["kind"] == "attempt_completed":
                    if set(payload) != {"outcome", "actualCostMicroUsd", "known"}:
                        raise CorruptLedger("completion fact shape is invalid")
                    if payload["outcome"] not in {
                            "completed", "cancelled", "cancelled_uncertain",
                            "failed", "terminal"}:
                        raise CorruptLedger("completion fact outcome is invalid")
                    known = payload["known"]
                    actual = payload["actualCostMicroUsd"]
                    if not isinstance(known, bool):
                        raise CorruptLedger("completion fact known flag is invalid")
                    if known:
                        cls._micro(actual, CorruptLedger)
                    elif actual is not None:
                        raise CorruptLedger("unknown completion fact contains an actual cost")
                    completion_facts.setdefault(key, []).append(fact_record)

            derived = 0
            providers = plan["eligibleProviderIds"]
            for attempt in attempts:
                key = (attempt["task_id"], attempt["attempt_id"], attempt["epoch"])
                identities = identity_facts.get(key, [])
                if len(identities) != 1:
                    raise CorruptLedger("attempt must have exactly one identity fact")
                identity = identities[0]
                kind, payload = identity["kind"], identity["payload"]
                if attempt["epoch"] == 0:
                    if (kind != "attempt_created" or
                            set(payload) != {"providerId", "planHash"}):
                        raise CorruptLedger("initial identity fact is invalid")
                    fact_plan_hash = payload["planHash"]
                    if (not isinstance(fact_plan_hash, str) or
                            not _HASH.fullmatch(fact_plan_hash) or
                            fact_plan_hash != plan_digest):
                        raise CorruptLedger("initial plan authority fact is invalid")
                    expected_provider = cls._provider_id(payload["providerId"], CorruptLedger)
                    if expected_provider != providers[0]:
                        raise CorruptLedger("initial identity provider does not match plan")
                else:
                    if kind != "transitioned":
                        raise CorruptLedger("successor identity fact is invalid")
                    try:
                        predecessor, predecessor_provider, expected_provider, _ = (
                            cls._transition_fact_payload(payload)
                        )
                    except LedgerError as exc:
                        raise CorruptLedger("transition identity fact is invalid") from exc
                    prior = attempts_by_epoch.get(attempt["epoch"] - 1)
                    if (prior is None or predecessor.task_id != attempt["task_id"] or
                            predecessor.epoch != attempt["epoch"] - 1 or
                            predecessor.attempt_id != prior["attempt_id"]):
                        raise CorruptLedger("transition predecessor fact is invalid")
                    if predecessor_provider != prior["provider_id"]:
                        raise CorruptLedger("transition predecessor provider is invalid")
                    if expected_provider not in providers:
                        raise CorruptLedger("successor identity provider is not eligible")
                    prior_provider_index = providers.index(prior["provider_id"])
                    if providers.index(expected_provider) <= prior_provider_index:
                        raise CorruptLedger("successor identity provider is out of order")
                if attempt["provider_id"] != expected_provider:
                    raise CorruptLedger("attempt provider does not match identity fact")

                related_facts = [
                    fact for facts_by_kind in (
                        cost_facts.get(key, []), state_facts.get(key, []),
                        dispatch_facts.get(key, []), cancel_facts.get(key, []),
                        completion_facts.get(key, []), recovery_facts.get(key, []),
                    ) for fact in facts_by_kind
                ]
                if (attempt["created_at_ms"] != identity["createdAtMs"] or
                        any(identity["outboxId"] >= fact["outboxId"]
                            for fact in related_facts)):
                    raise CorruptLedger("attempt identity fact ordering is invalid")

                dispatches = dispatch_facts.get(key, [])
                cancels = cancel_facts.get(key, [])
                completions = completion_facts.get(key, [])
                recoveries = recovery_facts.get(key, [])
                if (len(dispatches) > 1 or len(cancels) > 1 or
                        len(completions) > 1 or len(recoveries) > 1):
                    raise CorruptLedger("execution barrier fact is duplicated")
                if sum(bool(group) for group in (cancels, completions, recoveries)) > 1:
                    raise CorruptLedger("execution barrier facts conflict")

                latest_cost = cost_facts.get(key, [])[-1] if cost_facts.get(key) else None
                if latest_cost is None or not latest_cost["payload"]["known"]:
                    expected_known = 0
                    expected_actual = None
                    expected_reserved = plan["providerCeilings"][expected_provider]
                else:
                    expected_known = 1
                    expected_actual = latest_cost["payload"]["actualCostMicroUsd"]
                    expected_reserved = expected_actual
                if (attempt["actual_cost_known"] != expected_known or
                        attempt["actual_cost_micro_usd"] != expected_actual or
                        attempt["reserved_micro_usd"] != expected_reserved):
                    raise CorruptLedger("attempt cost state does not match cost facts")
                if derived > _SAFE_INTEGER_MAX - expected_reserved:
                    raise CorruptLedger("derived task reservation exceeds safe integer range")
                derived += expected_reserved

                state_history = state_facts.get(key, [])
                if attempt["epoch"] == row["epoch"]:
                    expected_state = state_history[-1]["state"] if state_history else "active"
                    if (attempt["state"] != expected_state or
                            attempt["dispatch_attempted"] != int(bool(dispatches)) or
                            attempt["cancel_requested"] != 0 or
                            attempt["failure_json"] is not None or
                            attempt["closed_at_ms"] is not None):
                        raise CorruptLedger("active execution state does not match facts")
                    if cancels or completions or recoveries:
                        raise CorruptLedger("terminal execution fact is incompatible with active task")
                else:
                    successor = attempts_by_epoch.get(attempt["epoch"] + 1)
                    if successor is None:
                        raise CorruptLedger("historical attempt has no successor")
                    successor_key = (successor["task_id"], successor["attempt_id"],
                                     successor["epoch"])
                    successor_identities = identity_facts.get(successor_key, [])
                    if (len(successor_identities) != 1 or
                            successor_identities[0]["kind"] != "transitioned"):
                        raise CorruptLedger("historical attempt has no transition authority")
                    transition_fact = successor_identities[0]
                    transition_payload = transition_fact["payload"]
                    try:
                        _, _, _, transition_failure = cls._transition_fact_payload(
                            transition_payload)
                    except LedgerError as exc:
                        raise CorruptLedger("historical transition failure is invalid") from exc
                    predecessor_facts = [
                        fact for facts_by_kind in (cost_facts.get(key, []), state_history,
                                                   dispatches, cancels, completions, recoveries)
                        for fact in facts_by_kind
                    ]
                    if any(fact["outboxId"] >= transition_fact["outboxId"]
                           for fact in predecessor_facts):
                        raise CorruptLedger("predecessor fact ordering is invalid")
                    if (attempt["state"] not in {"closed", "orphaned"} or
                            attempt["dispatch_attempted"] != 0 or
                            attempt["cancel_requested"] != 0 or
                            dispatches or cancels or completions or
                            attempt["closed_at_ms"] != transition_fact["createdAtMs"]):
                        raise CorruptLedger("historical predecessor state is invalid")
                    try:
                        recorded_failure = cls._strict_fact_payload(attempt["failure_json"])
                        normalized_failure = cls._failure(recorded_failure)
                    except (LedgerError, TypeError) as exc:
                        raise CorruptLedger("historical predecessor failure is invalid") from exc
                    if normalized_failure != transition_failure:
                        raise CorruptLedger("historical predecessor failure does not match transition")
            if derived != row["task_reserved"]:
                raise CorruptLedger("task reservation does not match authoritative facts")
        return plan

    @staticmethod
    def _outbox(conn: sqlite3.Connection, task_id: str, attempt_id: str,
                epoch: int, kind: str, payload: Mapping[str, Any], now: int) -> int:
        if (kind not in _OUTBOX_KINDS or not isinstance(payload, Mapping) or
                not isinstance(now, int) or now <= 0 or now > _SAFE_INTEGER_MAX):
            raise LedgerError("outbox event is invalid")
        cursor = conn.execute("INSERT INTO outbox(task_id,attempt_id,epoch,kind,payload_json,created_at_ms)"
                     " VALUES(?,?,?,?,?,?)",
                     (task_id, attempt_id, epoch, kind, AttemptLedger._json(payload), now))
        if cursor.lastrowid is None:
            raise CorruptLedger("outbox insert did not return an id")
        return int(cursor.lastrowid)

    @staticmethod
    def _snapshot(row: sqlite3.Row) -> dict[str, Any]:
        return {"taskId": row["task_id"], "attemptId": row["attempt_id"],
                "epoch": row["epoch"], "providerId": row["provider_id"],
                "state": row["state"], "dispatchAttempted": bool(row["dispatch_attempted"]),
                "cancelRequested": bool(row["cancel_requested"]),
                "reservedMicroUsd": row["reserved_micro_usd"],
                "actualCostKnown": bool(row["actual_cost_known"]),
                "actualCostMicroUsd": row["actual_cost_micro_usd"]}

    def create_initial(self, task_id: str, immutable_plan: Mapping[str, Any]) -> dict[str, Any]:
        plan = self._validate_plan(task_id, immutable_plan)
        encoded_plan = self._json(plan)
        plan_digest = hashlib.sha256(encoded_plan.encode()).hexdigest()
        attempt_id = uuid.uuid4().hex
        now = self._time_ms(self._now())
        provider = plan["eligibleProviderIds"][0]
        ceiling = plan["providerCeilings"][provider]
        rejection = None
        if now >= plan["taskDeadlineMs"]:
            rejection = "initial admission rejected: task deadline has passed"
        elif (plan["budgetMicroUsd"] is not None and
              plan["budgetMicroUsd"] < ceiling):
            rejection = "initial admission rejected: budget is below initial provider ceiling"
        with self._tx() as conn:
            if conn.execute("SELECT 1 FROM tasks WHERE task_id=?", (task_id,)).fetchone():
                raise TaskAlreadyExists(f"task is permanently tombstoned: {task_id}")
            if rejection is not None:
                conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (task_id, encoded_plan, plan_digest, "rejected", 0,
                              plan["transitionLimit"], plan["taskDeadlineMs"],
                              plan["budgetMicroUsd"], 0, now))
            else:
                conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (task_id, encoded_plan, plan_digest, "running", 0,
                              plan["transitionLimit"], plan["taskDeadlineMs"],
                              plan["budgetMicroUsd"], ceiling, now))
                conn.execute("INSERT INTO attempts(task_id,epoch,attempt_id,provider_id,state,"
                             "dispatch_attempted,cancel_requested,reserved_micro_usd,"
                             "actual_cost_known,actual_cost_micro_usd,created_at_ms)"
                             " VALUES(?,?,?,?,'active',0,0,?,0,NULL,?)",
                             (task_id, 0, attempt_id, provider, ceiling, now))
                conn.execute("INSERT INTO active_control VALUES(?,?,?,'active')",
                             (task_id, attempt_id, 0))
                self._outbox(conn, task_id, attempt_id, 0, "attempt_created",
                             {"providerId": provider, "planHash": plan_digest}, now)
        if rejection is not None:
            raise AdmissionRejected(rejection)
        return {"taskId": task_id, "attemptId": attempt_id, "epoch": 0,
                "providerId": provider, "state": "active",
                "dispatchAttempted": False, "reservedMicroUsd": ceiling}

    @classmethod
    def _idempotency_key(cls, value: Any) -> str:
        if not isinstance(value, str) or not 1 <= len(value) <= 128 or not _VISIBLE_ASCII.fullmatch(value):
            raise LedgerError("idempotency key is invalid")
        return value

    @classmethod
    def _read_idempotency(cls, conn: sqlite3.Connection, operation: str,
                          key: str) -> dict[str, Any] | None:
        key = cls._idempotency_key(key)
        row = conn.execute(
            "SELECT result_json FROM mutation_idempotency WHERE operation=? AND idempotency_key=?",
            (operation, key),
        ).fetchone()
        return None if row is None else json.loads(row["result_json"])

    @classmethod
    def _write_idempotency(cls, conn: sqlite3.Connection, operation: str,
                           key: str, result: Mapping[str, Any],
                           active: ActiveTuple | None = None) -> None:
        key = cls._idempotency_key(key)
        conn.execute(
            "INSERT INTO mutation_idempotency(operation,idempotency_key,task_id,attempt_id,epoch,result_json,created_at_ms) "
            "VALUES(?,?,?,?,?,?,?)",
            (operation, key, active.task_id if active else None,
             active.attempt_id if active else None, active.epoch if active else None,
             cls._json(result), cls._time_ms(cls._now_static_for_idempotency(result))),
        )

    @staticmethod
    def _now_static_for_idempotency(result: Mapping[str, Any]) -> int:
        # The result carries no wall-clock authority; this is only a bounded
        # audit timestamp. Callers that need the exact event time use outbox.
        return int(time.time() * 1000)

    @classmethod
    def normalize_observation(cls, observation: Mapping[str, Any]) -> dict[str, Any]:
        """Reduce a provider observation to the secret-free retry taxonomy."""
        if not isinstance(observation, Mapping):
            raise LedgerError("observation must be an object")
        if {"failureClass", "code", "retryable"}.issubset(observation):
            failure = cls._failure({
                "failureClass": observation["failureClass"],
                "code": observation["code"],
                "retryable": observation["retryable"],
            })
            if failure["failureClass"] == "retryable" and failure["code"] not in _RETRYABLE_CODES:
                raise LedgerError("retryable observation code is not allowlisted")
            return failure
        if any(key.lower() in {"rawerror", "error", "message", "headers", "body"}
               for key in observation):
            raise LedgerError("raw provider observations are not accepted")
        if observation.get("cancelled") is True:
            return {"failureClass": "cancelled", "code": "operator_cancel", "retryable": False}
        if observation.get("dispatchAttempted") is True:
            return {"failureClass": "side_effect_uncertainty", "code": "dispatch_attempted", "retryable": False}
        status = observation.get("httpStatus")
        if isinstance(status, int) and not isinstance(status, bool):
            if status == 408:
                return {"failureClass": "retryable", "code": "http_408", "retryable": True}
            if status == 429:
                return {"failureClass": "retryable", "code": "http_429", "retryable": True}
            if 500 <= status <= 599:
                return {"failureClass": "retryable", "code": "http_5xx", "retryable": True}
            if status in {400, 404}:
                return {"failureClass": "configuration", "code": f"http_{status}", "retryable": False}
            if status in {401, 403}:
                return {"failureClass": "authentication", "code": f"http_{status}", "retryable": False}
        transport = observation.get("transport")
        if transport == "connection":
            return {"failureClass": "retryable", "code": "connection", "retryable": True}
        if transport == "dns":
            return {"failureClass": "retryable", "code": "dns", "retryable": True}
        if observation.get("timedOut") is True:
            return {"failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True}
        return {"failureClass": "terminal", "code": "unknown", "retryable": False}

    def admit_frontier(self, request_id: str, immutable_plan_v1: Mapping[str, Any],
                       deadline_at: int, provider_order: list[str]) -> dict[str, Any]:
        """Idempotent FRONTIER admission façade over the P0 admission fact."""
        if not isinstance(provider_order, list) or len(provider_order) != 2:
            return {"status": "REJECTED", "reason": "frontier requires exactly two providers"}
        try:
            plan = self._validate_plan(request_id, immutable_plan_v1)
            if plan["eligibleProviderIds"] != provider_order:
                return {"status": "REJECTED", "reason": "provider order does not match immutable plan"}
            if plan["transitionLimit"] != 1 or plan["taskDeadlineMs"] != deadline_at:
                return {"status": "REJECTED", "reason": "frontier plan/deadline is invalid"}
            self._time_ms(deadline_at)
            if self._now() >= deadline_at:
                return {"status": "REJECTED", "reason": "deadline is not in the future"}
        except LedgerError as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        plan_hash = self._plan_hash(plan)

        def admission_tuple(active: Mapping[str, Any]) -> dict[str, Any]:
            return {key: active[key] for key in (
                "taskId", "attemptId", "epoch", "providerId", "state",
                "dispatchAttempted", "reservedMicroUsd",
            ) if key in active}

        existing = self.get_task(request_id)
        if existing is not None:
            if existing["plan_hash"] != plan_hash:
                return {"status": "REJECTED", "reason": "request id is bound to another plan"}
            active = self.get_active(request_id)
            if active is not None:
                return {"status": "EXISTING", "tuple": admission_tuple(active), "planHash": plan_hash}
            return {"status": "REJECTED", "reason": "request id is already terminal"}
        try:
            active = self.create_initial(request_id, plan)
        except TaskAlreadyExists:
            active = self.get_active(request_id)
            if active is not None:
                return {"status": "EXISTING", "tuple": admission_tuple(active), "planHash": plan_hash}
            return {"status": "REJECTED", "reason": "request id is already terminal"}
        except LedgerError as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        return {"status": "ADMITTED", "tuple": active, "planHash": plan_hash}

    def submit_attempt(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                       immutable_plan: Mapping[str, Any], provider_ref: Mapping[str, Any],
                       attempt_deadline_ms: int,
                       idempotency_key: str | None = None) -> dict[str, Any]:
        expected = self._tuple(expected_tuple)
        try:
            plan = self._validate_plan(expected.task_id, immutable_plan)
            plan_hash = self._plan_hash(plan)
            self._time_ms(attempt_deadline_ms)
        except (LedgerError, TypeError, ValueError) as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        if not isinstance(provider_ref, Mapping):
            return {"status": "REJECTED", "reason": "provider reference is invalid"}
        try:
            provider = self._provider_id(provider_ref.get("providerId"), LedgerError)
            if set(provider_ref) - {"providerId", "label", "modelId", "credentialEnvName", "baseUrlEnvName"}:
                return {"status": "REJECTED", "reason": "provider reference is not secret-free"}
            for name in ("label", "modelId", "credentialEnvName", "baseUrlEnvName"):
                self._bounded_text(provider_ref.get(name), 256, LedgerError)
            for name in ("credentialEnvName", "baseUrlEnvName"):
                if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", provider_ref[name]):
                    return {"status": "REJECTED", "reason": "provider reference env name is invalid"}
        except LedgerError as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        with self._tx() as conn:
            if idempotency_key is not None:
                prior = self._read_idempotency(conn, "submit", idempotency_key)
                if prior is not None:
                    return {**prior, "status": "DUPLICATE"}
            row = self._active(conn, expected)
            if (row is None or row["provider_id"] != provider or
                    plan_hash != row["plan_hash"] or
                    attempt_deadline_ms > row["deadline_ms"] or
                    attempt_deadline_ms <= self._now()):
                return {"status": "REJECTED", "reason": "stale or mismatched active tuple"}
            result = {"status": "SUBMITTED", "activeTuple": expected.as_dict(),
                      "providerId": provider}
            if idempotency_key is not None:
                self._write_idempotency(conn, "submit", idempotency_key, result, expected)
            return result

    def record_observation(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                           normalized_observation: Mapping[str, Any],
                           idempotency_key: str) -> dict[str, Any]:
        expected = self._tuple(expected_tuple)
        key = self._idempotency_key(idempotency_key)
        try:
            normalized = self.normalize_observation(normalized_observation)
        except LedgerError as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        now = self._time_ms(self._now())
        with self._tx() as conn:
            prior = self._read_idempotency(conn, "observation", key)
            if prior is not None:
                return {"status": "DUPLICATE", "observation": prior["observation"]}
            row = self._active(conn, expected)
            if row is None or now >= row["deadline_ms"]:
                return {"status": "REJECTED", "reason": "stale, cancelled, or expired tuple"}
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "provider_event", {"eventKind": "observation", "payload": normalized}, now)
            result = {"status": "RECORDED", "observation": normalized,
                      "tuple": expected.as_dict()}
            self._write_idempotency(conn, "observation", key, result, expected)
            return result

    def poll_observations(self, task_id: str, after_id: int = 0,
                          limit: int = 100) -> dict[str, Any]:
        page = self.page_outbox(after_id=after_id, limit=limit, task_id=task_id)
        observations = [event for event in page["events"]
                        if event["kind"] == "provider_event" and
                        event["payload"].get("eventKind") == "observation"]
        return {"status": "OK", "observations": observations,
                "nextCursor": page["nextCursor"], "hasMore": page["hasMore"]}

    def transition_once_result(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                               successor_provider_id: str, normalized_failure: Mapping[str, Any],
                               jitter_ms: int = 0, plan_hash: str | None = None,
                               idempotency_key: str | None = None) -> dict[str, Any]:
        if (isinstance(normalized_failure, Mapping) and
                normalized_failure.get("code") == "timeout"):
            return {"status": "REJECTED", "reason": "generic timeout is not retryable"}
        result = self.transition_once(expected_tuple, successor_provider_id,
                                      normalized_failure, jitter_ms, plan_hash,
                                      idempotency_key)
        return result or {"status": "REJECTED", "reason": "transition barrier rejected"}

    def transition_once(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                        successor_provider_id: str,
                        normalized_failure: Mapping[str, Any],
                        jitter_ms: int = 0,
                        plan_hash: str | None = None,
                        idempotency_key: str | None = None) -> dict[str, Any] | None:
        expected = self._tuple(expected_tuple)
        self._provider_id(successor_provider_id, LedgerError)
        failure = self._failure(normalized_failure)
        if (failure["failureClass"] != "retryable" or
                failure["code"] not in _RETRYABLE_CODES | {"timeout"}):
            return None
        if (isinstance(jitter_ms, bool) or not isinstance(jitter_ms, int) or
                not 0 <= jitter_ms <= 750 or (jitter_ms and jitter_ms < 250)):
            return None
        now = self._time_ms(self._now())
        with self._tx() as conn:
            if idempotency_key is not None:
                prior = self._read_idempotency(conn, "transition", idempotency_key)
                if prior is not None:
                    return prior
            row = self._active(conn, expected)
            if row is None:
                return None
            plan = self._checked_plan(row, conn)
            if plan_hash is not None and plan_hash != row["plan_hash"]:
                return None
            if (row["dispatch_attempted"] or row["cancel_requested"] or
                    now + jitter_ms >= row["deadline_ms"] or
                    row["transitions_used"] >= row["transition_limit"] or
                    failure["failureClass"] != "retryable"):
                return None
            providers = plan["eligibleProviderIds"]
            try:
                current = providers.index(row["provider_id"])
                successor = providers.index(successor_provider_id)
            except ValueError:
                return None
            if successor <= current or self._circuit_open(conn, row["provider_id"], now):
                return None
            successor_ceiling = plan["providerCeilings"][successor_provider_id]
            prior = row["reserved_micro_usd"]
            effective = row["actual_cost_micro_usd"] if row["actual_cost_known"] else prior
            replacement = row["task_reserved"] - prior + effective + successor_ceiling
            self._micro(replacement, CorruptLedger)
            if (plan["budgetMicroUsd"] is not None and
                    replacement > plan["budgetMicroUsd"]):
                return None
            next_id, next_epoch = uuid.uuid4().hex, expected.epoch + 1
            closed = conn.execute("UPDATE attempts SET state='closed',failure_json=?,closed_at_ms=?"
                                  " WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                  f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0 AND dispatch_attempted=0",
                                  (self._json(failure), now, expected.task_id, expected.epoch,
                                   expected.attempt_id))
            self._require_one_attempt_mutation(closed, "transition predecessor close")
            conn.execute("INSERT INTO attempts(task_id,epoch,attempt_id,provider_id,state,"
                         "dispatch_attempted,cancel_requested,reserved_micro_usd,"
                         "actual_cost_known,actual_cost_micro_usd,created_at_ms)"
                         " VALUES(?,?,?,?,'active',0,0,?,0,NULL,?)",
                         (expected.task_id, next_epoch, next_id, successor_provider_id,
                          successor_ceiling, now))
            task_update = conn.execute("UPDATE tasks SET transitions_used=transitions_used+1,"
                                       "reserved_micro_usd=? WHERE task_id=? AND status='running'",
                                       (replacement, expected.task_id))
            if task_update.rowcount != 1:
                raise CorruptLedger(f"transition task update mutated {task_update.rowcount} rows")
            control_update = conn.execute("UPDATE active_control SET attempt_id=?,epoch=?,status='active'"
                         " WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                         (next_id, next_epoch, expected.task_id, expected.attempt_id, expected.epoch))
            if control_update.rowcount != 1:
                raise CorruptLedger(f"transition control update mutated {control_update.rowcount} rows")
            self._record_diagnostic_failure(conn, row["provider_id"], now)
            transition_id = self._outbox(conn, expected.task_id, next_id, next_epoch, "transitioned",
                         {"predecessor": expected.as_dict(),
                          "predecessorProviderId": row["provider_id"],
                          "successorProviderId": successor_provider_id,
                          "failure": failure}, now)
            self._insert_witness(
                conn, transition_id, expected, row["provider_id"],
                ActiveTuple(expected.task_id, next_id, next_epoch),
                successor_provider_id, now,
            )
            result = {"status": "TRANSITIONED", "taskId": expected.task_id,
                      "attemptId": next_id, "epoch": next_epoch,
                "providerId": successor_provider_id, "state": "active",
                "dispatchAttempted": False, "reservedMicroUsd": successor_ceiling}
            if idempotency_key is not None:
                self._write_idempotency(conn, "transition", idempotency_key, result, expected)
        return result

    def recover_and_transition_once(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                                    recovery_id: str, jitter_ms: int = 0,
                                    normalized_failure: Mapping[str, Any] | None = None,
                                    successor_provider_id: str | None = None) -> dict[str, Any]:
        expected = self._tuple(expected_tuple)
        key = self._idempotency_key(recovery_id)
        failure = self._failure(normalized_failure or {
            "failureClass": "retryable", "code": "pre_dispatch_timeout", "retryable": True,
        })
        if (failure["failureClass"] != "retryable" or
                failure["code"] not in _RETRYABLE_CODES):
            return {"status": "REJECTED", "reason": "recovery failure is not allowlisted"}
        if (isinstance(jitter_ms, bool) or not isinstance(jitter_ms, int) or
                not 0 <= jitter_ms <= 750 or (jitter_ms and jitter_ms < 250)):
            return {"status": "REJECTED", "reason": "jitter is outside 250-750ms bounds"}
        now = self._time_ms(self._now())
        with self._tx() as conn:
            prior = self._read_idempotency(conn, "recovery", key)
            if prior is not None:
                return prior
            row = self._active(conn, expected)
            if row is None:
                return {"status": "REJECTED", "reason": "stale active tuple"}
            plan = self._checked_plan(row, conn)
            if (row["dispatch_attempted"] or row["cancel_requested"] or
                    now + jitter_ms >= row["deadline_ms"] or
                    row["transitions_used"] >= row["transition_limit"]):
                return {"status": "REJECTED", "reason": "recovery barrier rejected"}
            providers = plan["eligibleProviderIds"]
            current_index = providers.index(row["provider_id"])
            successor_provider_id = successor_provider_id or providers[current_index + 1] \
                if current_index + 1 < len(providers) else None
            if (successor_provider_id is None or successor_provider_id not in providers or
                    providers.index(successor_provider_id) <= current_index or
                    self._circuit_open(conn, row["provider_id"], now)):
                return {"status": "REJECTED", "reason": "successor or circuit barrier rejected"}
            successor_ceiling = plan["providerCeilings"][successor_provider_id]
            effective = row["actual_cost_micro_usd"] if row["actual_cost_known"] else row["reserved_micro_usd"]
            replacement = row["task_reserved"] - row["reserved_micro_usd"] + effective + successor_ceiling
            if (plan["budgetMicroUsd"] is not None and replacement > plan["budgetMicroUsd"]):
                return {"status": "REJECTED", "reason": "budget barrier rejected"}
            closed = conn.execute(
                "UPDATE attempts SET state='closed',failure_json=?,closed_at_ms=? "
                "WHERE task_id=? AND epoch=? AND attempt_id=? AND state IN ('active','provider_ready','provider_started','queued','starting','connecting','thinking','processing','streaming','receiving','waiting','progress') "
                "AND dispatch_attempted=0 AND cancel_requested=0",
                (self._json(failure), now, expected.task_id, expected.epoch, expected.attempt_id),
            )
            self._require_one_attempt_mutation(closed, "recovery predecessor close")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "pre_dispatch_recovered", {}, now)
            next_id, next_epoch = uuid.uuid4().hex, expected.epoch + 1
            conn.execute(
                "INSERT INTO attempts(task_id,epoch,attempt_id,provider_id,state,dispatch_attempted,"
                "cancel_requested,reserved_micro_usd,actual_cost_known,actual_cost_micro_usd,created_at_ms) "
                "VALUES(?,?,?,?,'active',0,0,?,0,NULL,?)",
                (expected.task_id, next_epoch, next_id, successor_provider_id,
                 successor_ceiling, now),
            )
            task_update = conn.execute(
                "UPDATE tasks SET transitions_used=transitions_used+1,reserved_micro_usd=? "
                "WHERE task_id=? AND status='running'", (replacement, expected.task_id),
            )
            if task_update.rowcount != 1:
                raise CorruptLedger("recovery task update mutated an unexpected number of rows")
            control_update = conn.execute(
                "UPDATE active_control SET attempt_id=?,epoch=?,status='active' "
                "WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                (next_id, next_epoch, expected.task_id, expected.attempt_id, expected.epoch),
            )
            if control_update.rowcount != 1:
                raise CorruptLedger("recovery control update mutated an unexpected number of rows")
            self._record_diagnostic_failure(conn, row["provider_id"], now)
            transition_id = self._outbox(
                conn, expected.task_id, next_id, next_epoch, "transitioned",
                {"predecessor": expected.as_dict(),
                 "predecessorProviderId": row["provider_id"],
                 "successorProviderId": successor_provider_id,
                 "failure": failure}, now,
            )
            self._insert_witness(
                conn, transition_id, expected, row["provider_id"],
                ActiveTuple(expected.task_id, next_id, next_epoch),
                successor_provider_id, now,
            )
            result = {"status": "RECOVERED", "tuple": {
                "taskId": expected.task_id, "attemptId": next_id, "epoch": next_epoch,
            }, "providerId": successor_provider_id}
            self._write_idempotency(conn, "recovery", key, result, expected)
            return result

    def authorize_tool_forward(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                               tool_call_id: str, tool_name: str = "",
                               args: Mapping[str, Any] | None = None) -> dict[str, Any]:
        expected = self._tuple(expected_tuple)
        try:
            call_id = self._bounded_text(tool_call_id, 256, LedgerError)
            name = self._bounded_text(tool_name or "unknown", 256, LedgerError)
            args_digest = hashlib.sha256(
                json.dumps(args or {}, sort_keys=True, default=repr,
                            separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            ).hexdigest()
            digest = self._authority_digest({
                "toolCallId": call_id,
                "toolName": name,
                "argsDigest": args_digest,
            })
        except LedgerError as exc:
            return {"status": "REJECTED", "reason": str(exc)}
        now = self._time_ms(self._now())
        with self._tx() as conn:
            prior = conn.execute(
                "SELECT tool_digest FROM tool_fences WHERE task_id=? AND attempt_id=? AND epoch=? AND tool_call_id=?",
                (expected.task_id, expected.attempt_id, expected.epoch, call_id),
            ).fetchone()
            if prior is not None:
                if prior["tool_digest"] == digest:
                    return {"status": "ALREADY_FENCED", "tuple": expected.as_dict(),
                            "toolCallId": call_id}
                return {"status": "REJECTED", "reason": "tool call id was reused with different content"}
            row = self._active(conn, expected)
            if (row is None or row["cancel_requested"] or now >= row["deadline_ms"] or
                    row["state"] not in _LEDGER_MUTABLE_STATES):
                return {"status": "REJECTED", "reason": "stale, cancelled, expired, or inactive tuple"}
            conn.execute("INSERT INTO tool_fences VALUES(?,?,?,?,?,?)",
                         (expected.task_id, expected.attempt_id, expected.epoch,
                          call_id, digest, now))
            if not row["dispatch_attempted"]:
                updated = conn.execute(
                    "UPDATE attempts SET dispatch_attempted=1 WHERE task_id=? AND epoch=? AND attempt_id=? "
                    "AND dispatch_attempted=0 AND cancel_requested=0 AND state IN ('active','provider_ready','provider_started','queued','starting','connecting','thinking','processing','streaming','receiving','waiting','progress')",
                    (expected.task_id, expected.epoch, expected.attempt_id),
                )
                self._require_one_attempt_mutation(updated, "tool dispatch fence")
                self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                             "dispatch_attempted", {}, now)
                return {"status": "FIRST_FENCED", "tuple": expected.as_dict(),
                        "toolCallId": call_id}
            return {"status": "FENCED", "tuple": expected.as_dict(),
                    "toolCallId": call_id}

    def request_cancel(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                       cancel_id: str) -> dict[str, Any]:
        expected = self._tuple(expected_tuple)
        key = self._idempotency_key(cancel_id)
        now = self._time_ms(self._now())
        with self._tx() as conn:
            prior = self._read_idempotency(conn, "cancel", key)
            if prior is not None:
                return prior
            row = conn.execute(
                "SELECT a.*,t.status AS task_status FROM attempts a JOIN tasks t ON t.task_id=a.task_id "
                "WHERE a.task_id=? AND a.attempt_id=? AND a.epoch=?",
                (expected.task_id, expected.attempt_id, expected.epoch),
            ).fetchone()
            if row is None:
                return {"status": "ACK_UNCERTAIN", "reason": "tuple is unknown"}
            if row["task_status"] != "running" or row["cancel_requested"] or row["state"] in {"closed", "terminal", "orphaned"}:
                result = {"status": "ACK_ALREADY_TERMINAL", "tuple": expected.as_dict()}
                self._write_idempotency(conn, "cancel", key, result, expected)
                return result
            cancelled = conn.execute(
                "UPDATE attempts SET state='cancel_requested',cancel_requested=1 "
                "WHERE task_id=? AND attempt_id=? AND epoch=? AND cancel_requested=0",
                (expected.task_id, expected.attempt_id, expected.epoch),
            )
            self._require_one_attempt_mutation(cancelled, "cancel request")
            conn.execute("UPDATE tasks SET status='cancel_requested' WHERE task_id=? AND status='running'",
                         (expected.task_id,))
            conn.execute("UPDATE active_control SET status='cancel_requested' WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                         (expected.task_id, expected.attempt_id, expected.epoch))
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "cancel_requested", {}, now)
            result = {"status": "ACK_CANCELLED", "tuple": expected.as_dict()}
            self._write_idempotency(conn, "cancel", key, result, expected)
            return result

    def get_status(self, task_id: str) -> dict[str, Any]:
        task = self.get_task(task_id)
        if task is None:
            return {"status": "UNKNOWN", "taskId": task_id}
        return {"status": "OK", "taskId": task_id, "taskState": task["status"],
                "active": self.get_active(task_id),
                "attempts": self.list_attempts(task_id),
                "planHash": task["plan_hash"], "deadlineMs": task["deadline_ms"]}

    def page_outbox(self, after_id: int = 0, limit: int = 100,
                    task_id: str | None = None) -> dict[str, Any]:
        if (isinstance(after_id, bool) or not isinstance(after_id, int) or after_id < 0 or
                isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500):
            raise LedgerError("outbox cursor or limit is invalid")
        conn = self._connect()
        try:
            args: list[Any] = [after_id]
            query = "SELECT * FROM outbox WHERE outbox_id>?"
            if task_id is not None:
                query += " AND task_id=?"
                args.append(task_id)
            rows = conn.execute(query + " ORDER BY outbox_id LIMIT ?", args + [limit + 1]).fetchall()
            high_water_mark = conn.execute("SELECT COALESCE(MAX(outbox_id), 0) FROM outbox").fetchone()[0]
            has_more = len(rows) > limit
            rows = rows[:limit]
            events = [{"outboxId": r["outbox_id"], "taskId": r["task_id"],
                       "attemptId": r["attempt_id"], "epoch": r["epoch"],
                       "kind": r["kind"], "payload": json.loads(r["payload_json"]),
                       "createdAtMs": r["created_at_ms"]} for r in rows]
            return {"status": "OK", "events": events,
                    "nextCursor": events[-1]["outboxId"] if events else after_id,
                    "hasMore": has_more, "highWaterMark": high_water_mark}
        finally:
            conn.close()

    @staticmethod
    def _failure(value: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(value, Mapping) or set(value) != {"failureClass", "code", "retryable"}:
            raise LedgerError("normalized failure shape is invalid")
        kind = value["failureClass"]
        if (kind not in _FAILURES or not isinstance(value["code"], str) or
                not _SAFE_TOKEN.fullmatch(value["code"]) or
                not isinstance(value["retryable"], bool) or
                value["retryable"] != (kind == "retryable")):
            raise LedgerError("normalized failure is invalid")
        return {"failureClass": kind, "code": value["code"], "retryable": value["retryable"]}

    @classmethod
    def _transition_fact_payload(cls, payload: Mapping[str, Any]) -> tuple[ActiveTuple, str, str, dict[str, Any]]:
        if (not isinstance(payload, Mapping) or
                set(payload) != {"predecessor", "predecessorProviderId",
                                 "successorProviderId", "failure"}):
            raise CorruptLedger("transition authority fact shape is invalid")
        try:
            predecessor = cls._tuple(payload["predecessor"])
            predecessor_provider = cls._provider_id(
                payload["predecessorProviderId"], CorruptLedger)
            successor_provider = cls._provider_id(
                payload["successorProviderId"], CorruptLedger)
            failure = cls._failure(payload["failure"])
        except LedgerError as exc:
            raise CorruptLedger("transition authority fact is invalid") from exc
        if failure["failureClass"] != "retryable":
            raise CorruptLedger("transition authority failure is not retryable")
        return predecessor, predecessor_provider, successor_provider, failure

    @classmethod
    def _authoritative_identity(cls, conn: sqlite3.Connection,
                                attempt: ActiveTuple) -> tuple[str, int, int]:
        rows = conn.execute(
            "SELECT task_id,attempt_id,epoch,provider_id,created_at_ms FROM attempts "
            "WHERE task_id=? AND attempt_id=? AND epoch=?",
            (attempt.task_id, attempt.attempt_id, attempt.epoch),
        ).fetchall()
        if len(rows) != 1:
            raise CorruptLedger("attempt identity row is missing or duplicated")
        materialized = rows[0]
        materialized_tuple = cls._tuple({
            "taskId": materialized["task_id"],
            "attemptId": materialized["attempt_id"],
            "epoch": materialized["epoch"],
        })
        if materialized_tuple != attempt:
            raise CorruptLedger("attempt identity row tuple is invalid")
        materialized_provider = cls._provider_id(
            materialized["provider_id"], CorruptLedger)
        materialized_created_at = cls._time_ms(materialized["created_at_ms"])

        facts = conn.execute(
            "SELECT outbox_id,task_id,attempt_id,epoch,kind,payload_json,created_at_ms "
            "FROM outbox WHERE task_id=? AND attempt_id=? AND epoch=? "
            "AND kind IN ('attempt_created','transitioned') ORDER BY outbox_id",
            (attempt.task_id, attempt.attempt_id, attempt.epoch),
        ).fetchall()
        if len(facts) != 1:
            raise CorruptLedger("attempt identity authority is missing or duplicated")
        fact = facts[0]
        if (isinstance(fact["outbox_id"], bool) or
                not isinstance(fact["outbox_id"], int) or
                not 1 <= fact["outbox_id"] <= _SAFE_INTEGER_MAX):
            raise CorruptLedger("identity authority id is invalid")
        fact_created_at = cls._time_ms(fact["created_at_ms"])
        fact_tuple = cls._tuple({
            "taskId": fact["task_id"], "attemptId": fact["attempt_id"],
            "epoch": fact["epoch"],
        })
        if fact_tuple != attempt:
            raise CorruptLedger("identity authority tuple is invalid")
        payload = cls._strict_fact_payload(fact["payload_json"])
        if fact["kind"] == "attempt_created":
            if (attempt.epoch != 0 or set(payload) != {"providerId", "planHash"} or
                    not isinstance(payload["planHash"], str) or
                    not _HASH.fullmatch(payload["planHash"])):
                raise CorruptLedger("initial identity authority is invalid")
            provider = cls._provider_id(payload["providerId"], CorruptLedger)
        else:
            if attempt.epoch == 0:
                raise CorruptLedger("transition authority cannot create epoch zero")
            predecessor, _, provider, _ = cls._transition_fact_payload(payload)
            if (predecessor.task_id != attempt.task_id or
                    predecessor.epoch != attempt.epoch - 1):
                raise CorruptLedger("transition identity epoch binding is invalid")
        if (materialized_provider != provider or
                materialized_created_at != fact_created_at):
            raise CorruptLedger("attempt identity fact and row disagree")
        return materialized_provider, fact["outbox_id"], materialized_created_at

    @classmethod
    def _circuit_open(cls, conn: sqlite3.Connection, provider: str, now: int) -> bool:
        # A witness can be the first failure in a qualifying three-failure
        # window whose third failure happened within the current 60s open
        # interval. Query six minutes so that the authoritative scan does not
        # discard that first witness merely because it is older than now-5m.
        cutoff = now - 360_000
        candidates = conn.execute(
            "SELECT * FROM circuit_transition_authority "
            "WHERE witness_created_at_ms>=? "
            "ORDER BY witness_created_at_ms,transition_outbox_id",
            (cutoff,),
        ).fetchall()
        seen_successors: set[tuple[str, str, int]] = set()
        seen_predecessors: set[tuple[str, str, int]] = set()
        failure_times: list[int] = []
        for witness in candidates:
            transition_id = witness["transition_outbox_id"]
            if (isinstance(transition_id, bool) or
                    not isinstance(transition_id, int) or
                    not 1 <= transition_id <= _SAFE_INTEGER_MAX):
                raise CorruptLedger("circuit authority id is invalid")
            witness_created_at = cls._time_ms(witness["witness_created_at_ms"])
            fact = conn.execute(
                "SELECT outbox_id,task_id,attempt_id,epoch,payload_json,created_at_ms "
                "FROM outbox WHERE outbox_id=? AND kind='transitioned'",
                (transition_id,),
            ).fetchone()
            if fact is None:
                raise CorruptLedger("circuit witness points to a non-transition fact")
            fact_created_at = cls._time_ms(fact["created_at_ms"])
            successor = cls._tuple({"taskId": fact["task_id"],
                                    "attemptId": fact["attempt_id"],
                                    "epoch": fact["epoch"]})
            payload = cls._strict_fact_payload(fact["payload_json"])
            predecessor, predecessor_provider, successor_provider, _ = (
                cls._transition_fact_payload(payload)
            )
            if (predecessor.task_id != successor.task_id or
                    predecessor.epoch + 1 != successor.epoch):
                raise CorruptLedger("circuit transition tuple binding is invalid")
            prior_row = conn.execute(
                "SELECT attempt_id FROM attempts WHERE task_id=? AND epoch=?",
                (successor.task_id, predecessor.epoch),
            ).fetchone()
            if prior_row is None or prior_row["attempt_id"] != predecessor.attempt_id:
                raise CorruptLedger("circuit predecessor identity is not the prior epoch")
            successor_key = (successor.task_id, successor.attempt_id, successor.epoch)
            predecessor_key = (predecessor.task_id, predecessor.attempt_id,
                               predecessor.epoch)
            if successor_key in seen_successors or predecessor_key in seen_predecessors:
                raise CorruptLedger("circuit transition authority is duplicated")
            seen_successors.add(successor_key)
            seen_predecessors.add(predecessor_key)
            (authoritative_predecessor, predecessor_fact_id,
             predecessor_created_at) = cls._authoritative_identity(conn, predecessor)
            (authoritative_successor, successor_fact_id,
             successor_created_at) = cls._authoritative_identity(conn, successor)
            expected_digest = cls._witness_digest(
                transition_id, predecessor, predecessor_provider, successor,
                successor_provider, witness_created_at,
            )
            if (authoritative_predecessor != predecessor_provider or
                    authoritative_successor != successor_provider or
                    predecessor_fact_id >= transition_id or
                    successor_fact_id != transition_id or
                    successor_created_at != fact_created_at or
                    witness_created_at != successor_created_at or
                    witness["witness_digest"] != expected_digest or
                    witness["predecessor_task_id"] != predecessor.task_id or
                    witness["predecessor_attempt_id"] != predecessor.attempt_id or
                    witness["predecessor_epoch"] != predecessor.epoch or
                    witness["predecessor_provider_id"] != predecessor_provider or
                    witness["successor_task_id"] != successor.task_id or
                    witness["successor_attempt_id"] != successor.attempt_id or
                    witness["successor_epoch"] != successor.epoch or
                    witness["successor_provider_id"] != successor_provider or
                    predecessor_created_at > fact_created_at):
                raise CorruptLedger("circuit provider authority is inconsistent")
            if (successor_created_at > now or witness_created_at > now):
                raise CorruptLedger("circuit authority timestamp is in the future")
            if predecessor_provider == provider:
                failure_times.append(successor_created_at)

        # Preserve the inclusive five-minute cutoff: t3-t1 <= 300000 qualifies.
        # The circuit is open for exactly 60s after the qualifying third
        # failure. At thresholdTime+60000 it is closed.
        threshold_time: int | None = None
        for index in range(2, len(failure_times)):
            threshold_time = failure_times[index]
            if threshold_time - failure_times[index - 2] <= 300_000:
                if now < threshold_time + 60_000:
                    return True
        return False

    def append_event_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                               event_kind: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
        if not isinstance(event_kind, str) or not _SAFE_TOKEN.fullmatch(event_kind):
            raise LedgerError("event kind is not a safe token")
        expected, safe, now = self._tuple(expected_tuple), self._payload(payload), self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or now >= row["deadline_ms"] or row["cancel_requested"]:
                return None
            conn.execute("INSERT INTO provider_events(task_id,attempt_id,epoch,event_kind,"
                         "payload_json,created_at_ms) VALUES(?,?,?,?,?,?)",
                         (expected.task_id, expected.attempt_id, expected.epoch, event_kind,
                          self._json(safe), now))
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "provider_event", {"eventKind": event_kind, "payload": safe}, now)
        return {"taskId": expected.task_id, "attemptId": expected.attempt_id,
                "epoch": expected.epoch, "eventKind": event_kind}

    def mark_dispatch_attempted(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any]) -> dict[str, Any] | None:
        expected, now = self._tuple(expected_tuple), self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or now >= row["deadline_ms"] or row["cancel_requested"] or row["dispatch_attempted"]:
                return None
            marked = conn.execute("UPDATE attempts SET dispatch_attempted=1 WHERE task_id=? AND epoch=? AND attempt_id=?"
                                  f" AND {_NONTERMINAL_STATE_SQL} AND cancel_requested=0 AND dispatch_attempted=0",
                                  (expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(marked, "dispatch mark")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "dispatch_attempted", {}, now)
        return expected.as_dict() | {"dispatchAttempted": True}

    def record_cost_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                              actual_cost_micro_usd: int | None) -> dict[str, Any] | None:
        expected = self._tuple(expected_tuple)
        if actual_cost_micro_usd is not None:
            self._micro(actual_cost_micro_usd)
        now = self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if (row is None or now >= row["deadline_ms"] or row["cancel_requested"] or
                    (row["actual_cost_known"] and actual_cost_micro_usd is None)):
                return None
            old = row["reserved_micro_usd"]
            new = old if actual_cost_micro_usd is None else actual_cost_micro_usd
            replacement = row["task_reserved"] - old + new
            self._micro(replacement, CorruptLedger)
            recorded = conn.execute("UPDATE attempts SET actual_cost_known=?,actual_cost_micro_usd=?,"
                                    "reserved_micro_usd=? WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                    f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0",
                                    (actual_cost_micro_usd is not None, actual_cost_micro_usd, new,
                                     expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(recorded, "cost record")
            task_update = conn.execute("UPDATE tasks SET reserved_micro_usd=? WHERE task_id=?",
                                       (replacement, expected.task_id))
            if task_update.rowcount != 1:
                raise CorruptLedger(f"cost task update mutated {task_update.rowcount} rows")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "cost_recorded", {"actualCostMicroUsd": actual_cost_micro_usd,
                                           "known": actual_cost_micro_usd is not None}, now)
        return expected.as_dict() | {"actualCostKnown": actual_cost_micro_usd is not None,
                                     "actualCostMicroUsd": actual_cost_micro_usd,
                                     "reservedMicroUsd": new}

    def mutate_state_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                               state: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
        expected, safe, now = self._tuple(expected_tuple), self._payload(payload), self._time_ms(self._now())
        self._provider_state(state, LedgerError)
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or now >= row["deadline_ms"] or row["cancel_requested"]:
                return None
            mutated = conn.execute("UPDATE attempts SET state=? WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                  f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0",
                                  (state, expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(mutated, "provider state mutation")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "state_mutated", {"state": state, "payload": safe}, now)
        return expected.as_dict() | {"state": state}

    def request_cancel_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any]) -> dict[str, Any] | None:
        expected, now = self._tuple(expected_tuple), self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or now >= row["deadline_ms"]:
                return None
            cancelled = conn.execute("UPDATE attempts SET state='cancel_requested',cancel_requested=1 WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                     f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0",
                                     (expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(cancelled, "cancel request")
            task_update = conn.execute("UPDATE tasks SET status='cancel_requested' WHERE task_id=? AND status='running'",
                                       (expected.task_id,))
            if task_update.rowcount != 1:
                raise CorruptLedger(f"cancel task update mutated {task_update.rowcount} rows")
            control_update = conn.execute("UPDATE active_control SET status='cancel_requested' WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                                          (expected.task_id, expected.attempt_id, expected.epoch))
            if control_update.rowcount != 1:
                raise CorruptLedger(f"cancel control update mutated {control_update.rowcount} rows")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "cancel_requested", {}, now)
        return expected.as_dict() | {"state": "cancel_requested"}

    def complete_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                           outcome: str = "completed", actual_cost_micro_usd: int | None = None) -> dict[str, Any] | None:
        expected = self._tuple(expected_tuple)
        if outcome not in {"completed", "cancelled", "cancelled_uncertain", "failed", "terminal"}:
            raise LedgerError("invalid terminal outcome")
        if actual_cost_micro_usd is not None:
            self._micro(actual_cost_micro_usd)
        now = self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or now >= row["deadline_ms"] or row["cancel_requested"]:
                return None
            old = row["reserved_micro_usd"]
            if actual_cost_micro_usd is None:
                final_known = bool(row["actual_cost_known"])
                final_actual = row["actual_cost_micro_usd"] if final_known else None
                new = old
            else:
                final_known = True
                final_actual = actual_cost_micro_usd
                new = actual_cost_micro_usd
            replacement = row["task_reserved"] - old + new
            self._micro(replacement, CorruptLedger)
            completed = conn.execute("UPDATE attempts SET state='terminal',closed_at_ms=?,actual_cost_known=?,"
                                     "actual_cost_micro_usd=?,reserved_micro_usd=? WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                     f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0",
                                     (now, final_known, final_actual, new,
                                      expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(completed, "completion")
            task_update = conn.execute("UPDATE tasks SET status=?,reserved_micro_usd=? WHERE task_id=?",
                                       (outcome, replacement, expected.task_id))
            if task_update.rowcount != 1:
                raise CorruptLedger(f"completion task update mutated {task_update.rowcount} rows")
            control_update = conn.execute("UPDATE active_control SET status='terminal' WHERE task_id=? AND attempt_id=? AND epoch=?",
                                          (expected.task_id, expected.attempt_id, expected.epoch))
            if control_update.rowcount != 1:
                raise CorruptLedger(f"completion control update mutated {control_update.rowcount} rows")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "attempt_completed", {"outcome": outcome,
                                               "actualCostMicroUsd": final_actual,
                                               "known": final_known}, now)
        return expected.as_dict() | {"state": "terminal", "outcome": outcome}

    def close_terminal_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any],
                                 outcome: str = "failed") -> dict[str, Any] | None:
        """Close an internal terminal observation, including persist-first cancel.

        This is separate from complete_if_active because request_cancel changes
        the authoritative control row to cancel_requested before the provider
        signal. A later terminal observation must still be able to close that
        exact attempt once, while a stale predecessor must remain rejected.
        """
        expected = self._tuple(expected_tuple)
        if outcome not in {"completed", "cancelled", "cancelled_uncertain", "failed", "terminal"}:
            raise LedgerError("invalid terminal outcome")
        now = self._time_ms(self._now())
        with self._tx() as conn:
            row = conn.execute(
                "SELECT a.*, t.status AS task_status, c.status AS control_status "
                "FROM attempts a JOIN tasks t ON t.task_id=a.task_id "
                "JOIN active_control c ON c.task_id=a.task_id AND c.attempt_id=a.attempt_id "
                "AND c.epoch=a.epoch WHERE a.task_id=? AND a.attempt_id=? AND a.epoch=?",
                (expected.task_id, expected.attempt_id, expected.epoch),
            ).fetchone()
            if row is None or row["control_status"] not in {"active", "cancel_requested"}:
                return None
            if row["state"] in {"terminal", "closed", "orphaned"}:
                return None
            closed = conn.execute(
                "UPDATE attempts SET state='terminal',closed_at_ms=? WHERE task_id=? "
                "AND epoch=? AND attempt_id=? AND state IN (" +
                ",".join("?" for _ in _LEDGER_MUTABLE_STATES) +
                ",?)",
                (now, expected.task_id, expected.epoch, expected.attempt_id,
                 *sorted(_LEDGER_MUTABLE_STATES), "cancel_requested"),
            )
            self._require_one_attempt_mutation(closed, "terminal observation close")
            task_update = conn.execute(
                "UPDATE tasks SET status=? WHERE task_id=? AND status IN ('running','cancel_requested')",
                (outcome, expected.task_id),
            )
            if task_update.rowcount != 1:
                raise CorruptLedger(f"terminal task update mutated {task_update.rowcount} rows")
            control_update = conn.execute(
                "UPDATE active_control SET status='terminal' WHERE task_id=? AND attempt_id=? "
                "AND epoch=? AND status IN ('active','cancel_requested')",
                (expected.task_id, expected.attempt_id, expected.epoch),
            )
            if control_update.rowcount != 1:
                raise CorruptLedger(f"terminal control update mutated {control_update.rowcount} rows")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "attempt_completed", {"outcome": outcome,
                                                "actualCostMicroUsd": row["actual_cost_micro_usd"],
                                                "known": bool(row["actual_cost_known"])}, now)
        return expected.as_dict() | {"state": "terminal", "outcome": outcome}

    def validate_poll_tuple(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any]) -> bool:
        """Validate the exact active tuple, allowing repeated reads of its terminal fact."""
        expected = self._tuple(expected_tuple)
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT a.state,t.status AS task_status,c.status AS control_status "
                "FROM attempts a JOIN tasks t ON t.task_id=a.task_id "
                "JOIN active_control c ON c.task_id=a.task_id AND c.attempt_id=a.attempt_id "
                "AND c.epoch=a.epoch WHERE a.task_id=? AND a.attempt_id=? AND a.epoch=?",
                (expected.task_id, expected.attempt_id, expected.epoch),
            ).fetchone()
            if row is None:
                return False
            if row["control_status"] in {"active", "cancel_requested"}:
                return True
            return row["control_status"] == "terminal" and row["state"] == "terminal"
        finally:
            conn.close()
    def recover_pre_dispatch_if_active(self, expected_tuple: ActiveTuple | Mapping[str, Any] | tuple[Any, Any, Any]) -> dict[str, Any] | None:
        expected = self._tuple(expected_tuple)
        now = self._time_ms(self._now())
        with self._tx() as conn:
            row = self._completion_row(conn, expected)
            if row is None or row["cancel_requested"]:
                return None
            if row["dispatch_attempted"] or now >= row["deadline_ms"]:
                fenced = conn.execute("UPDATE attempts SET state='terminal',closed_at_ms=? WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                      f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0",
                                      (now, expected.task_id, expected.epoch, expected.attempt_id))
                self._require_one_attempt_mutation(fenced, "post-dispatch recovery fence")
                task_update = conn.execute("UPDATE tasks SET status='cancelled_uncertain' WHERE task_id=? AND status='running'",
                                           (expected.task_id,))
                if task_update.rowcount != 1:
                    raise CorruptLedger(f"recovery task update mutated {task_update.rowcount} rows")
                control_update = conn.execute("UPDATE active_control SET status='terminal' WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                                              (expected.task_id, expected.attempt_id, expected.epoch))
                if control_update.rowcount != 1:
                    raise CorruptLedger(f"recovery control update mutated {control_update.rowcount} rows")
                self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                             "attempt_completed", {"outcome": "cancelled_uncertain",
                                                   "actualCostMicroUsd": row["actual_cost_micro_usd"],
                                                   "known": bool(row["actual_cost_known"])}, now)
                return expected.as_dict() | {"state": "terminal", "outcome": "cancelled_uncertain"}
            orphaned = conn.execute("UPDATE attempts SET state='orphaned',closed_at_ms=? WHERE task_id=? AND epoch=? AND attempt_id=? AND "
                                    f"{_NONTERMINAL_STATE_SQL} AND cancel_requested=0 AND dispatch_attempted=0",
                                    (now, expected.task_id, expected.epoch, expected.attempt_id))
            self._require_one_attempt_mutation(orphaned, "pre-dispatch recovery")
            task_update = conn.execute("UPDATE tasks SET status='orphaned' WHERE task_id=? AND status='running'",
                                       (expected.task_id,))
            if task_update.rowcount != 1:
                raise CorruptLedger(f"recovery task update mutated {task_update.rowcount} rows")
            control_update = conn.execute("UPDATE active_control SET status='terminal' WHERE task_id=? AND attempt_id=? AND epoch=? AND status='active'",
                                          (expected.task_id, expected.attempt_id, expected.epoch))
            if control_update.rowcount != 1:
                raise CorruptLedger(f"recovery control update mutated {control_update.rowcount} rows")
            self._outbox(conn, expected.task_id, expected.attempt_id, expected.epoch,
                         "pre_dispatch_recovered", {}, now)
        return expected.as_dict() | {"state": "orphaned"}
    def get_active(self, task_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        try:
            row = conn.execute("""
              SELECT a.*,t.plan_json,t.plan_hash,t.status AS task_status,
                     t.transitions_used,t.transition_limit,t.deadline_ms,
                     t.budget_micro_usd,t.reserved_micro_usd AS task_reserved
                FROM active_control c
                JOIN attempts a ON a.task_id=c.task_id AND a.attempt_id=c.attempt_id
                                AND a.epoch=c.epoch
                JOIN tasks t ON t.task_id=a.task_id
               WHERE c.task_id=? AND c.status='active'
                 AND a.cancel_requested=0 AND t.status='running'
            """, (task_id,)).fetchone()
            if row is None:
                return None
            self._persisted_state(row["state"])
            self._checked_plan(row, conn)
            return self._snapshot(row)
        finally:
            conn.close()

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            if row is None:
                return None
            result = dict(row)
            result["plan"] = json.loads(result.pop("plan_json"))
            return result
        finally:
            conn.close()

    def list_attempts(self, task_id: str) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM attempts WHERE task_id=? ORDER BY epoch", (task_id,)).fetchall()
            return [self._snapshot(r) | {"failure": None if r["failure_json"] is None else json.loads(r["failure_json"])} for r in rows]
        finally:
            conn.close()

    def read_outbox(self, task_id: str | None = None, after_id: int = 0) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            query = "SELECT * FROM outbox WHERE outbox_id>?"
            args: list[Any] = [after_id]
            if task_id is not None:
                query += " AND task_id=?"
                args.append(task_id)
            rows = conn.execute(query + " ORDER BY outbox_id", args).fetchall()
            return [{"outboxId": r["outbox_id"], "taskId": r["task_id"],
                     "attemptId": r["attempt_id"], "epoch": r["epoch"],
                     "kind": r["kind"], "payload": json.loads(r["payload_json"]),
                     "createdAtMs": r["created_at_ms"]} for r in rows]
        finally:
            conn.close()

    def project_outbox(self, projector: Callable[[dict[str, Any]], None],
                       task_id: str | None = None) -> int:
        count = 0
        for event in self.read_outbox(task_id):
            with self._tx() as conn:
                inserted = conn.execute("INSERT OR IGNORE INTO projection_dedupe VALUES(?,?)",
                                         (event["outboxId"], self._time_ms(self._now()))).rowcount
                if not inserted:
                    continue
                projector(event)
                count += 1
        return count

    def schema_version(self) -> int:
        conn = self._connect()
        try:
            row = conn.execute("SELECT value FROM ledger_meta WHERE key='schema_version'").fetchone()
            if row is None:
                raise UnsupportedSchemaVersion("missing schema version")
            return int(row["value"])
        finally:
            conn.close()


def circuit_open_indexed(conn: sqlite3.Connection, provider: str, now_ms: int) -> bool:
    """Public read-only circuit check used by deterministic engine tests."""
    AttemptLedger._provider_id(provider, CorruptLedger)
    AttemptLedger._time_ms(now_ms)
    return AttemptLedger._circuit_open(conn, provider, now_ms)
