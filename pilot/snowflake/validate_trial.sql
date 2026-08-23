-- FLOWPROOF SNOWFLAKE PILOT VALIDATION
-- Run as ACCOUNTADMIN after setup_trial.sql.
-- This script never prints or changes the FLOWPROOF_READER password.

USE ROLE ACCOUNTADMIN;

-- Inspect the cost controls. In the results, confirm:
--   warehouse size = X-Small
--   auto suspend = 60 seconds
--   resource monitor = FLOWPROOF_PILOT_MONITOR
SHOW WAREHOUSES LIKE 'FLOWPROOF_PILOT_WH';
SHOW RESOURCE MONITORS LIKE 'FLOWPROOF_PILOT_MONITOR';

-- Confirm that the application role has only the expected usage and SELECT grants.
SHOW GRANTS TO ROLE FLOWPROOF_READER;

-- Confirm the Openflow-shaped target schema.
DESCRIBE TABLE FLOWPROOF_PILOT.RAW.ORDERS;

USE WAREHOUSE FLOWPROOF_PILOT_WH;
USE DATABASE FLOWPROOF_PILOT;
USE SCHEMA RAW;

-- A successful setup returns PASS with:
--   5 rows, 5 distinct keys, 0 deleted rows, $460.75 total, 30s maximum lag.
WITH observed AS (
  SELECT
    COUNT(*) AS row_count,
    COUNT(DISTINCT id) AS distinct_key_count,
    COUNT_IF(_SNOWFLAKE_DELETED) AS deleted_row_count,
    MIN(id) AS minimum_id,
    MAX(id) AS maximum_id,
    SUM(amount) AS total_amount,
    MAX(
      DATEDIFF(
        'second',
        CONVERT_TIMEZONE('UTC', updated_at)::TIMESTAMP_NTZ,
        _SNOWFLAKE_INSERTED_AT
      )
    ) AS maximum_delivery_lag_seconds
  FROM ORDERS
)
SELECT
  IFF(
    row_count = 5
    AND distinct_key_count = 5
    AND deleted_row_count = 0
    AND minimum_id = 1
    AND maximum_id = 5
    AND total_amount = 460.75
    AND maximum_delivery_lag_seconds = 30,
    'PASS',
    'FAIL'
  ) AS validation_status,
  row_count,
  distinct_key_count,
  deleted_row_count,
  minimum_id,
  maximum_id,
  total_amount,
  maximum_delivery_lag_seconds
FROM observed;

ALTER WAREHOUSE FLOWPROOF_PILOT_WH SUSPEND;
