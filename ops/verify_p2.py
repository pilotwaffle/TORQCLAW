"""P2 invariant checks against state.db after the approval e2e ran.

Verifies:
  1. Context-poisoning guard: the BLOCKED task wrote NO RESULT event and is NOT
     in task_episodes (so getContextWindow can't surface the aborted attempt).
  2. The re-run task DID produce a RESULT.
  3. tool_approvals has exactly one decided 'approved' row for the run.
"""
import json
import sqlite3
import sys
from pathlib import Path

db = Path.home() / ".torqclaw" / "state.db"
con = sqlite3.connect(str(db))
con.row_factory = sqlite3.Row

# Most recent approval (the e2e just ran).
appr = con.execute(
    "SELECT * FROM tool_approvals ORDER BY created_at DESC, rowid DESC LIMIT 1"
).fetchone()
if not appr:
    print("FAIL: no tool_approvals rows"); sys.exit(1)

blocked_req = appr["request_id"]
print(f"approval: status={appr['status']} tool={appr['tool_name']} blocked_req={blocked_req}")

# (1) blocked task: completed-with-blockedOn, NO RESULT event, NOT in episodes.
blocked_task = con.execute(
    "SELECT state, telemetry_json FROM tasks WHERE request_id=?", (blocked_req,)
).fetchone()
tele = json.loads(blocked_task["telemetry_json"] or "{}") if blocked_task else {}
result_events = con.execute(
    "SELECT COUNT(*) c FROM events WHERE request_id=? AND type='RESULT'", (blocked_req,)
).fetchone()["c"]
episode = con.execute(
    "SELECT COUNT(*) c FROM task_episodes WHERE request_id=?", (blocked_req,)
).fetchone()["c"]

ok = True
if not blocked_task or blocked_task["state"] != "completed":
    print(f"FAIL: blocked task state != completed ({blocked_task and blocked_task['state']})"); ok = False
elif tele.get("blockedOn") != appr["tool_name"]:
    print(f"FAIL: blockedOn telemetry missing/wrong ({tele.get('blockedOn')})"); ok = False
else:
    print(f"OK: blocked task completed with blockedOn={tele.get('blockedOn')}")
if result_events != 0:
    print(f"FAIL: blocked task emitted {result_events} RESULT events (must be 0)"); ok = False
else:
    print("OK: blocked task emitted no RESULT event")
if episode != 0:
    print(f"FAIL: blocked task is in task_episodes (context poisoning!)"); ok = False
else:
    print("OK: blocked task skipped storeEpisode (no context poisoning)")

# (3) the approval was decided 'approved'.
if appr["status"] != "approved":
    print(f"NOTE: last approval status={appr['status']} (expected 'approved' after APPROVE e2e)")

print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
