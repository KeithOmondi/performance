-- RESTORE ONLY IF NEEDED — not a migration to run on deploy.
--
-- Rows removed on 2026-11-09 were copied (as JSON) into deleted_records_archive before
-- deletion. This script puts a chosen batch back. Set the note filter below to one of:
--
--   2026-11-09: submissions removed on Registrar's instruction (A.5(f), A.11(c))
--   2026-11-09: spot-check reports removed on Registrar's instruction (A.11(i), A.13(c), A.13(d))
--   2026-11-09: spot-check reports removed on Registrar's instruction (B.1(b))
--   2026-11-09: spot-check reports removed on Registrar's instruction (A.13(a))
--
-- Order matters: submissions first, then their documents and spot-check links.
-- Indicators are restored to their pre-deletion status/progress last.

BEGIN;

-- ▼▼ choose the batch ▼▼
CREATE TEMP TABLE restore_batch AS
SELECT * FROM deleted_records_archive
WHERE note = '2026-11-09: spot-check reports removed on Registrar''s instruction (A.11(i), A.13(c), A.13(d))';

INSERT INTO submissions
SELECT (jsonb_populate_record(NULL::submissions, row_data)).*
FROM restore_batch WHERE source_table = 'submissions'
ON CONFLICT (id) DO NOTHING;

INSERT INTO submission_documents
SELECT (jsonb_populate_record(NULL::submission_documents, row_data)).*
FROM restore_batch WHERE source_table = 'submission_documents'
ON CONFLICT (id) DO NOTHING;

INSERT INTO submission_spot_check_links
SELECT (jsonb_populate_record(NULL::submission_spot_check_links, row_data)).*
FROM restore_batch WHERE source_table = 'submission_spot_check_links'
ON CONFLICT (id) DO NOTHING;

UPDATE indicators i
SET    status                 = (r.row_data->>'status')::indicator_status,
       progress               = (r.row_data->>'progress')::numeric,
       current_total_achieved = (r.row_data->>'current_total_achieved')::numeric,
       updated_at             = NOW()
FROM   restore_batch r
WHERE  r.source_table = 'indicators (before reset)'
  AND  i.id = (r.row_data->>'id')::uuid;

COMMIT;
