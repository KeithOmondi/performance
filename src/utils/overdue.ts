/**
 * Single source of truth for "overdue" indicators.
 *
 * An indicator is overdue only when its deadline has passed AND nothing has
 * been submitted for its active period yet. Anything already uploaded —
 * awaiting review, returned for correction, rejected, or completed — is not
 * overdue, even if the indicator's own status was never moved off "Pending".
 *
 * @param alias table alias for `indicators` in the surrounding query
 */
export const overdueSql = (alias = "i") => `(
  ${alias}.deadline < NOW()
  AND ${alias}.assignee_id IS NOT NULL
  AND ${alias}.status NOT IN (
    'Completed',
    'Awaiting Admin Approval',
    'Awaiting Super Admin',
    'Correction Needed',
    'Rejected by Admin',
    'Rejected by Super Admin'
  )
  AND NOT EXISTS (
    SELECT 1 FROM submissions os
    WHERE os.indicator_id = ${alias}.id
      AND os.quarter = ${alias}.active_quarter
  )
)`;
