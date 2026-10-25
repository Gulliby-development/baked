"""Hidden check: applies the migrations in order to a database with items and moves stock."""

import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
db = sqlite3.connect(":memory:")
db.executescript((root / "sql/migrations/001_items.sql").read_text(encoding="utf-8"))
db.executescript("INSERT INTO items (id, name, price_cents) VALUES (1, 'pen', 120), (2, 'ink', 450);")
db.executescript((root / "sql/migrations/002_stock.sql").read_text(encoding="utf-8"))
assert db.execute("SELECT id, stock FROM items ORDER BY id").fetchall() == [(1, 0), (2, 0)]
db.execute("INSERT INTO stock_moves (item_id, delta) VALUES (1, 5)")
db.execute("INSERT INTO stock_moves (item_id, delta) VALUES (1, -2)")
db.execute("INSERT INTO stock_moves (item_id, delta) VALUES (2, 3)")
try:
    db.execute("INSERT INTO stock_moves (item_id, delta) VALUES (2, -4)")
except sqlite3.DatabaseError as error:
    assert "insufficient stock" in str(error), str(error)
else:
    raise AssertionError("a move below zero stock was accepted")
assert db.execute("SELECT id, stock FROM items ORDER BY id").fetchall() == [(1, 3), (2, 3)]
assert db.execute("SELECT COUNT(*) FROM stock_moves").fetchone() == (3,)
db.execute("INSERT INTO items (id, name, price_cents) VALUES (3, 'nib', 80)")
assert db.execute("SELECT stock FROM items WHERE id = 3").fetchone() == (0,)
print("ok")
