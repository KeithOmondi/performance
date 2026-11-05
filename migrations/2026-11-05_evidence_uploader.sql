-- Evidence uploader: one user, chosen by the super admin, who can upload evidence
-- (submit, resubmit, add/edit/delete pending documents) on EVERY indicator, not just
-- their own. All actions are still recorded under their own user id.
--
-- Run this BEFORE deploying the matching code: every user-portal ownership check
-- reads this column.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_upload_for_all BOOLEAN NOT NULL DEFAULT false;

-- At most one evidence uploader at a time
CREATE UNIQUE INDEX IF NOT EXISTS users_single_evidence_uploader
  ON users (can_upload_for_all)
  WHERE can_upload_for_all;
