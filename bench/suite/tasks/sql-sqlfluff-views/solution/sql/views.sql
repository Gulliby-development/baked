CREATE VIEW customer_totals AS
SELECT
    c.id AS customer_id,
    c.name,
    COUNT(o.id) AS paid_orders,
    COALESCE(SUM(o.total_cents), 0) AS paid_cents
FROM customers AS c
LEFT JOIN orders AS o
    ON c.id = o.customer_id AND o.status = 'paid'
GROUP BY c.id, c.name;

CREATE VIEW top_customers AS
SELECT
    customer_id,
    name,
    paid_cents
FROM customer_totals
ORDER BY paid_cents DESC, customer_id ASC
LIMIT 3;
