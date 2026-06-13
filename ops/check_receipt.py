"""Confirm a P2.5 receipt SYSTEM event was emitted on the last completed task."""
import sqlite3
from pathlib import Path

con = sqlite3.connect(str(Path.home() / ".torqclaw" / "state.db"))
r = con.execute(
    "SELECT message, metadata FROM events "
    "WHERE type='SYSTEM' AND metadata LIKE '%\"receipt\"%' "
    "ORDER BY seq DESC LIMIT 1"
).fetchone()
if r:
    print("RECEIPT FOUND:", r[0], "::", r[1])
else:
    print("NO RECEIPT FOUND")
