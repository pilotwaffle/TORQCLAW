"""Debug helper: print the most recent task and its event log from hermes_tasks.db.

Usage: python dump_last_task.py [path-to-db]   (defaults to ~/.torqclaw/hermes_tasks.db)
"""
import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".torqclaw" / "hermes_tasks.db"
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row

cols = [r["name"] for r in con.execute("PRAGMA table_info(task_events)")]
print("task_events columns:", cols)

t = con.execute("SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1").fetchone()
print("STATE:", t["state"], "| ERROR:", t["error"], "| TELEMETRY:", t["telemetry"])
print("RESULT:", (t["result"] or "")[:300])

order = "seq" if "seq" in cols else "rowid"
evs = con.execute(
    f"SELECT * FROM task_events WHERE task_id=? ORDER BY {order}", (t["task_id"],)
).fetchall()
print(f"{len(evs)} events:")
for e in evs:
    msg = (e["message"] or "")[:200]
    print(f"  [{e[order]}] {e['type']}: {msg}")
