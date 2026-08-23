-- Run after `flowproof relay-run` is listening.
-- Each block is a separate committed PostgreSQL transaction.

BEGIN;
INSERT INTO public.orders (id, status, amount, updated_at)
VALUES (6, 'created', 42.25, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status, amount = EXCLUDED.amount, updated_at = EXCLUDED.updated_at;
COMMIT;

BEGIN;
UPDATE public.orders
SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
WHERE id = 2;
COMMIT;

-- A delete is represented as a soft-deleted target row by the test relay.
BEGIN;
DELETE FROM public.orders WHERE id = 3;
COMMIT;
