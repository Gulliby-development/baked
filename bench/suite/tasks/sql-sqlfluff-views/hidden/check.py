"""Hidden check: loads the schema and the views into SQLite and queries them."""

import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
db = sqlite3.connect(":memory:")
db.executescript((root / "sql/schema.sql").read_text(encoding="utf-8"))
db.executescript((root / "sql/views.sql").read_text(encoding="utf-8"))
db.executescript(
    """
    INSERT INTO customers (id, name) VALUES (1, 'Ada'), (2, 'Bo'), (3, 'Cy'), (4, 'Di'), (5, 'Ed');
    INSERT INTO orders (id, customer_id, total_cents, status) VALUES
      (1, 1, 500, 'paid'), (2, 1, 700, 'paid'), (3, 2, 900, 'refunded'),
      (4, 3, 1200, 'paid'), (5, 4, 1200, 'paid'), (6, 5, 100, 'paid');
    """
)
totals = db.execute(
    "SELECT customer_id, name, paid_orders, paid_cents FROM customer_totals ORDER BY customer_id"
).fetchall()
expected = [(1, "Ada", 2, 1200), (2, "Bo", 0, 0), (3, "Cy", 1, 1200), (4, "Di", 1, 1200), (5, "Ed", 1, 100)]
assert totals == expected, f"customer_totals: {totals}"
top = db.execute("SELECT customer_id, name, paid_cents FROM top_customers").fetchall()
assert top == [(1, "Ada", 1200), (3, "Cy", 1200), (4, "Di", 1200)], f"top_customers: {top}"
print("ok")
