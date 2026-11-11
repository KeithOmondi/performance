-- RESTORE ONLY IF NEEDED — not a migration to run on deploy.
--
-- On 2026-11-09 the PMMU structure was aligned with the signed hard copy:
--   1. "Reduce external audit recommendations by 75%" was moved from a stray Customer
--      objective to Financial C.2 as (d).
--   2. The stray Customer objective "Implementation of Audit Report Recommendations"
--      (2 activities / 2 indicators not in the hard copy) was removed.
-- Every affected row was archived in deleted_records_archive first. This script
-- reverses BOTH steps (step 2 first, then step 1). Run the whole file in one go.

BEGIN;

CREATE TEMP TABLE restore_batch AS
SELECT * FROM deleted_records_archive
WHERE note = '2026-11-09: stray Customer objective ''Implementation of Audit Report Recommendations'' removed to mirror the hard copy';

-- ── Undo step 2: put the stray objective back, parents before children ──
INSERT INTO strategic_objectives
SELECT (jsonb_populate_record(NULL::strategic_objectives, row_data)).* FROM restore_batch WHERE source_table = 'strategic_objectives';
INSERT INTO strategic_activities
SELECT (jsonb_populate_record(NULL::strategic_activities, row_data)).* FROM restore_batch WHERE source_table = 'strategic_activities';
INSERT INTO indicators
SELECT (jsonb_populate_record(NULL::indicators, row_data)).* FROM restore_batch WHERE source_table = 'indicators';
INSERT INTO indicator_assignees
SELECT (jsonb_populate_record(NULL::indicator_assignees, row_data)).* FROM restore_batch WHERE source_table = 'indicator_assignees';
INSERT INTO submissions
SELECT (jsonb_populate_record(NULL::submissions, row_data)).* FROM restore_batch WHERE source_table = 'submissions';
INSERT INTO submission_documents
SELECT (jsonb_populate_record(NULL::submission_documents, row_data)).* FROM restore_batch WHERE source_table = 'submission_documents';
INSERT INTO submission_spot_check_links
SELECT (jsonb_populate_record(NULL::submission_spot_check_links, row_data)).* FROM restore_batch WHERE source_table = 'submission_spot_check_links';
INSERT INTO review_history
SELECT (jsonb_populate_record(NULL::review_history, row_data)).* FROM restore_batch WHERE source_table = 'review_history';
INSERT INTO examiner_folder_assignments
SELECT (jsonb_populate_record(NULL::examiner_folder_assignments, row_data)).* FROM restore_batch WHERE source_table = 'examiner_folder_assignments';
INSERT INTO supervisor_folder_assignments
SELECT (jsonb_populate_record(NULL::supervisor_folder_assignments, row_data)).* FROM restore_batch WHERE source_table = 'supervisor_folder_assignments';

-- ── Undo step 1: move C.2(d) back under the stray Customer objective ──
UPDATE strategic_activities sa
SET    objective_id = (r.row_data->>'objective_id')::uuid, "order" = (r.row_data->>'order')::int
FROM   deleted_records_archive r
WHERE  r.note LIKE '2026-11-09: C.2(d) moved%' AND r.source_table = 'strategic_activities'
  AND  sa.id = (r.row_data->>'id')::uuid;

UPDATE indicators i
SET    objective_id = (r.row_data->>'objective_id')::uuid, strategic_plan_id = (r.row_data->>'strategic_plan_id')::uuid
FROM   deleted_records_archive r
WHERE  r.note LIKE '2026-11-09: C.2(d) moved%' AND r.source_table = 'indicators'
  AND  i.id = (r.row_data->>'id')::uuid;

COMMIT;
