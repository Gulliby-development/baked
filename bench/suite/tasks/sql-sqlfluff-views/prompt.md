The SQLite schema in `sql/schema.sql` has `customers(id, name)` and `orders(id, customer_id, total_cents, status)`, where `status` is `'paid'` or `'refunded'`.

Write `sql/views.sql` with two views, to be run after `sql/schema.sql`:

- `customer_totals(customer_id, name, paid_orders, paid_cents)`: one row per customer, counting only `'paid'` orders. A customer without paid orders has `paid_orders = 0` and `paid_cents = 0`, not NULL.
- `top_customers(customer_id, name, paid_cents)`: the three customers with the highest `paid_cents`, highest first, ties broken by the lower `customer_id`.

The SQL must pass `sqlfluff lint .` with the project's `.sqlfluff`. Add a README.md that says how to load the schema and the views with `sqlite3`.
