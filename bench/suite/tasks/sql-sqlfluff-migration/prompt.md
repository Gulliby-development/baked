`sql/migrations/001_items.sql` creates the SQLite table `items(id, name, price_cents)`. Migrations run in file-name order.

Write `sql/migrations/002_stock.sql`, which runs after it on a database that already has items:

- Add a column `stock INTEGER NOT NULL DEFAULT 0` to `items`; existing items get 0.
- Create a table `stock_moves(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), delta INTEGER NOT NULL)`.
- Create a trigger `stock_moves_apply` so that every row inserted into `stock_moves` adds its `delta` to the item's `stock`.
- A move that would make an item's stock negative is rejected with `RAISE(ABORT, 'insufficient stock')` and changes nothing.

The SQL must pass `sqlfluff lint .` with the project's `.sqlfluff`. Add a README.md that says how to apply the migrations with `sqlite3`.
