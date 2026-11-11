-- RESTORE ONLY IF NEEDED — not a migration to run on deploy.
--
-- On 2026-11-09 all 29 spot checks and their 35 documents were soft-deleted in one
-- batch, all stamped with the same deleted_at below. Running this file brings that
-- exact batch back (anything deleted at any other time is left alone).
-- The 64 links attaching spot-check documents to indicator submissions were never
-- touched, so nothing else needs restoring.

BEGIN;

UPDATE spot_check_documents
SET    status = 'Active', deleted_at = NULL
WHERE  deleted_at = '2026-11-09T17:14:07.934Z';

UPDATE spot_checks
SET    deleted_at = NULL, updated_at = NOW()
WHERE  deleted_at = '2026-11-09T17:14:07.934Z';

COMMIT;
