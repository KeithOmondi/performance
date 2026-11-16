-- Schedule 1 (Performance Targets Matrix) grading.
-- Additive only: new columns on strategic_objectives + two new tables. Safe to re-run.
--
-- Values below are transcribed from the signed ORHC 2025/2026 PMMU, Schedule 1.
-- NOTE: in the hard copy, section E's rows weigh 2 + 1 + 2 = 5 but its printed subtotal
-- is 9 (and the Grand Total 100). Row weights are stored exactly as printed; totals are
-- computed from the rows (so E = 5, overall = 96) until the weights are corrected.

BEGIN;

ALTER TABLE strategic_objectives
  ADD COLUMN IF NOT EXISTS schedule_name   TEXT,          -- row name as printed in Schedule 1
  ADD COLUMN IF NOT EXISTS unit_of_measure TEXT,          -- '%' or 'No.'
  ADD COLUMN IF NOT EXISTS weight          NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS baseline        NUMERIC(8,2),  -- Baseline 2024/2025
  ADD COLUMN IF NOT EXISTS target          NUMERIC(8,2);  -- Target 2025/2026

-- Fill Schedule 1 by perspective + PMMU objective number (sort_order)
UPDATE strategic_objectives so
SET    schedule_name = v.name, unit_of_measure = v.unit, weight = v.weight,
       baseline = v.baseline, target = v.target
FROM   strategic_plans sp,
       (VALUES
         ('CORE%',        1, 'Improve proximity to courts',                                   '%',   5, 100,   100),
         ('CORE%',        2, 'Enhance Efficiency in Determination of Special Bench Cases',    '%',   5, 100,   100),
         ('CORE%',        3, 'Provide reliable ICT Infrastructure and modernize Registry Records', '%', 3, 95, 100),
         ('CORE%',        4, 'Expand the doorways of Justice',                                '%',   5, 100,   100),
         ('CORE%',        5, 'Enhance Access to Legal Information and Legal Aid',             '%',   5, 100,   100),
         ('CORE%',        6, 'Enhance Access of Justice to Vulnerable groups',                '%',   5, 100,   100),
         ('CORE%',        7, 'Champion High Court Justice Reforms',                           '%',   5, 100,   100),
         ('CORE%',        8, 'Promote Indigenous Social Justice Jurisprudence and Demos prudence', '%', 4, 100, 100),
         ('CORE%',        9, 'Foster a Culture of Shared Leadership',                         '%',   5, 100,   100),
         ('CORE%',       10, 'Enhance Strategic Partnerships and Collaborative Relationships', '%',  5, 100,   100),
         ('CORE%',       11, 'Streamline Registry Operations',                                '%',   6, 100,   100),
         ('CORE%',       12, 'Provide administrative support to Judges and Courts',           '%',   5, 100,   100),
         ('CORE%',       13, 'Supervision of DRs',                                            '%',   5, 100,   100),
         ('CORE%',       14, 'Maintenance of Infrastructure and Assets',                      '%',   5, 100,   100),
         ('CORE%',       15, 'Timely submission of quarterly management reports',             '%',   2, 100,   100),
         ('CUSTOMER%',    1, 'Compliance with Service Charter Standards',                     '%',   5, 100,   100),
         ('CUSTOMER%',    2, 'Customer Survey Recommendations',                               '%',   5, 100,   100),
         ('FINANC%',      1, 'Compliance with the set budget level',                          '%',   2, 99.45, 100),
         ('FINANC%',      2, 'Implementation of Audit Report Recommendations',                '%',   1, 95,    100),
         ('FINANC%',      3, 'Greening Initiatives',                                          '%',   2, 100,   100),
         ('INNOVATION%',  1, 'Service Delivery Innovation',                                   'No.', 3, 1,     1),
         ('INNOVATION%',  2, 'Competence Development',                                        '%',   3, 100,   100),
         ('INTERNAL%',    1, 'Corruption prevention and eradication',                         '%',   2, 100,   100),
         ('INTERNAL%',    2, 'Improve employee wellness',                                     '%',   1, 100,   100),
         ('INTERNAL%',    3, 'Enhance Employee satisfaction & Work Environment',              '%',   2, 100,   100)
       ) AS v(persp, num, name, unit, weight, baseline, target)
WHERE  sp.id = so.plan_id
  AND  sp.perspective ILIKE v.persp
  AND  so.sort_order = v.num;

-- One current grade per Schedule-1 row (objective)
CREATE TABLE IF NOT EXISTS objective_grades (
  objective_id   UUID PRIMARY KEY REFERENCES strategic_objectives(id) ON DELETE CASCADE,
  actual         NUMERIC(8,2) NOT NULL CHECK (actual >= 0),
  remarks        TEXT,
  graded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  graded_by_role TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every change, for the audit trail
CREATE TABLE IF NOT EXISTS objective_grade_history (
  id             BIGSERIAL PRIMARY KEY,
  objective_id   UUID NOT NULL REFERENCES strategic_objectives(id) ON DELETE CASCADE,
  actual         NUMERIC(8,2) NOT NULL,
  remarks        TEXT,
  graded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  graded_by_role TEXT NOT NULL,
  graded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_objective_grade_history_objective
  ON objective_grade_history (objective_id, graded_at DESC);

COMMIT;
