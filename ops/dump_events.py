"""Print recent gateway events from state.db — what the console actually sent."""
import sqlite3
from pathlib import Path

con = sqlite3.connect(str(Path.home() / ".torqclaw" / "state.db"))
con.row_factory = sqlite3.Row
rows = con.execute(
    "SELECT seq, type, message, tier FROM events "
    "WHERE timestamp > datetime('now','-120 minutes') ORDER BY seq ASC"
).fetchall()
for r in rows:
    tier = r["tier"] or "-"
    msg = (r["message"] or "")[:90]
    print(f"[{r['seq']}] {tier:14} {r['type']:16} {msg}")
print(f"\n{len(rows)} events in the last 2h")
