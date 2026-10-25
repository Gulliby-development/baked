ALTER TABLE items ADD COLUMN stock INTEGER NOT NULL DEFAULT 0;

CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    delta INTEGER NOT NULL
);

CREATE TRIGGER stock_moves_check
BEFORE INSERT ON stock_moves
WHEN (
    SELECT items.stock
    FROM items
    WHERE items.id = new.item_id
) + new.delta < 0
BEGIN
    SELECT RAISE(ABORT, 'insufficient stock');
END;

CREATE TRIGGER stock_moves_apply
AFTER INSERT ON stock_moves
BEGIN
    UPDATE items SET stock = stock + new.delta
    WHERE id = new.item_id;
END;
