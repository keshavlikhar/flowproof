CREATE TABLE public.orders (
  id BIGINT PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO public.orders (id, status, amount, updated_at) VALUES
  (1, 'created', 25.00, '2026-08-22T18:00:00Z'),
  (2, 'paid', 100.50, '2026-08-22T18:01:00Z'),
  (3, 'shipped', 75.25, '2026-08-22T18:02:00Z'),
  (4, 'cancelled', 10.00, '2026-08-22T18:03:00Z'),
  (5, 'paid', 250.00, '2026-08-22T18:04:00Z');

GRANT CONNECT ON DATABASE flowproof_pilot TO flowproof_reader, openflow_connector;
GRANT USAGE ON SCHEMA public TO flowproof_reader, openflow_connector;
GRANT SELECT ON TABLE public.orders TO flowproof_reader, openflow_connector;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO flowproof_reader, openflow_connector;

CREATE PUBLICATION flowproof_publication
  FOR TABLE public.orders
  WITH (publish_via_partition_root = true);
