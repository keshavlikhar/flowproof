-- OPTIONAL: exposes account-level usage history to the verifier role.
-- Skip this during the correctness pilot if account-wide usage visibility is too broad.

USE ROLE ACCOUNTADMIN;
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER TO ROLE FLOWPROOF_READER;
