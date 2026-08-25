-- One-time upgrade for relay ledgers created before commit_lsn_bytes existed.
-- Run as ACCOUNTADMIN in Snowsight. No passwords or credentials are changed.

USE ROLE ACCOUNTADMIN;
USE DATABASE FLOWPROOF_PILOT;
USE SCHEMA RAW;

ALTER TABLE FLOWPROOF_RELAY_TRANSACTIONS
  ADD COLUMN IF NOT EXISTS commit_lsn_bytes NUMBER(38, 0);

-- PostgreSQL LSN X/Y means (hex X * 2^32) + hex Y.
UPDATE FLOWPROOF_RELAY_TRANSACTIONS
SET commit_lsn_bytes =
  TO_NUMBER(SPLIT_PART(commit_lsn, '/', 1), 'XXXXXXXX') * 4294967296
  + TO_NUMBER(SPLIT_PART(commit_lsn, '/', 2), 'XXXXXXXX')
WHERE commit_lsn_bytes IS NULL;

ALTER TABLE FLOWPROOF_RELAY_TRANSACTIONS
  ALTER COLUMN commit_lsn_bytes SET NOT NULL;

ALTER WAREHOUSE FLOWPROOF_PILOT_WH SUSPEND;
