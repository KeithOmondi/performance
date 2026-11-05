-- Puts activities in the exact order of the signed ORHC 2025/2026 PMMU (Annex 1),
-- lettering a = 0, b = 1 …
--
-- Fixes the earlier PMMU-order migration, whose activity step failed on the unique
-- index idx_activities_order_per_objective (objective_id, "order"): swapping two
-- activities in a single UPDATE briefly produced duplicate positions. (Its objective
-- sort_order step DID apply.)
--
-- Here every matched activity is first parked in a temporary slot (10000 + n), then
-- moved to its PMMU position — all inside one transaction, so it's all-or-nothing.
-- Run the whole file in one go, in one session.

BEGIN;

CREATE TEMP TABLE pmmu_activity_order (persp TEXT, obj TEXT, act TEXT, n INT) ON COMMIT DROP;
INSERT INTO pmmu_activity_order VALUES
  -- A1 Improve proximity to courts
  ('CORE%', 'Improve proximity%', 'Operationalize 1 High Court sub-registry%', 0),
  ('CORE%', 'Improve proximity%', 'Prepare and Submit a Proposal%Tribunals%', 1),
  -- A2 Special Bench Cases
  ('CORE%', 'Enhance Efficiency in Determination%', 'Facilitating approved special benches%', 0),
  ('CORE%', 'Enhance Efficiency in Determination%', 'Prepare and submit to the Principal Judge an annual status report%', 1),
  ('CORE%', 'Enhance Efficiency in Determination%', 'Facilitate Gazettement of records%', 2),
  -- A3 ICT
  ('CORE%', '%ICT Infrastructure%', 'Liaise with DICT%', 0),
  ('CORE%', '%ICT Infrastructure%', 'Update the ICT equipment%', 1),
  ('CORE%', '%ICT Infrastructure%', 'Follow up with the Directorate of ICT%', 2),
  ('CORE%', '%ICT Infrastructure%', 'Initiate automation%', 3),
  -- A4 Expand the doorways of Justice
  ('CORE%', 'Expand the doorways%', 'Liaise with AJS%', 0),
  ('CORE%', 'Expand the doorways%', 'Facilitate all approved circuit%', 1),
  ('CORE%', 'Expand the doorways%', '%Taxation Matters%', 2),
  ('CORE%', 'Expand the doorways%', 'Develop and submit a needs assessment report for recruitment%', 3),
  ('CORE%', 'Expand the doorways%', '%Mahakama Popote%', 4),
  -- A5 Access to Legal Information
  ('CORE%', 'Enhance Access to Legal Information%', 'Conduct sensitization forum on court processes%', 0),
  ('CORE%', 'Enhance Access to Legal Information%', 'Develop and disseminate IEC%', 1),
  ('CORE%', 'Enhance Access to Legal Information%', 'Process all applications for form 30%', 2),
  ('CORE%', 'Enhance Access to Legal Information%', 'Publication of 2000 form 60%', 3),
  ('CORE%', 'Enhance Access to Legal Information%', 'Disseminate the High Court Service Week%', 4),
  ('CORE%', 'Enhance Access to Legal Information%', 'Liaise with Deputy Registrars in (15)%', 5),
  ('CORE%', 'Enhance Access to Legal Information%', 'Maintain and Update the High Court Website%', 6),
  -- A6 Vulnerable groups
  ('CORE%', '%Vulnerable groups%', '%Service Delivery Charter in Kiswahili%', 0),
  ('CORE%', '%Vulnerable groups%', 'Sensitise stakeholders%', 1),
  ('CORE%', '%Vulnerable groups%', 'Co-ordinate payment of Pro-Bono%', 2),
  ('CORE%', '%Vulnerable groups%', 'Sensitize at least 100%', 3),
  -- A7 Justice Reforms
  ('CORE%', 'Champion High Court%', '%criminal justice reform%', 0),
  ('CORE%', 'Champion High Court%', 'Develop draft guidelines for Kadhis%', 1),
  -- A9 Shared Leadership
  ('CORE%', 'Foster a Culture%', 'Liaise with the Deputy Registrars to ensure that stations comply%', 0),
  ('CORE%', 'Foster a Culture%', 'Liaise with OCRJ%', 1),
  ('CORE%', 'Foster a Culture%', 'Organize an annual forum for Judges%', 2),
  ('CORE%', 'Foster a Culture%', 'Organize an annual forum for Deputy Registrars%', 3),
  ('CORE%', 'Foster a Culture%', 'Facilitate meeting between Principal Judge and Presiding Judges%', 4),
  ('CORE%', 'Foster a Culture%', 'Facilitate meeting between Principal Judge and Judges%', 5),
  ('CORE%', 'Foster a Culture%', 'Facilitate meeting between Judiciary Spokesperson%', 6),
  ('CORE%', 'Foster a Culture%', 'Implement the relevant resolutions%', 7),
  -- A10 Strategic Partnerships
  ('CORE%', 'Enhance Strategic Partnerships%', 'Organize (1) forum%', 0),
  ('CORE%', 'Enhance Strategic Partnerships%', 'Facilitate the attendance of the Principal Judge%', 1),
  -- A11 Streamline Registry Operations
  ('CORE%', 'Streamline Registry%', 'Ensure that High Court Registries have all the required standardized%', 0),
  ('CORE%', 'Streamline Registry%', 'Coordinate sensitization on the High Court Registry Manual%', 1),
  ('CORE%', 'Streamline Registry%', 'Monitor implementation of all registry manuals%', 2),
  ('CORE%', 'Streamline Registry%', 'Issuance of colour coded%', 3),
  ('CORE%', 'Streamline Registry%', 'Facilitate typing and submission%', 4),
  ('CORE%', 'Streamline Registry%', 'Conduct 10 virtual and 5 physical%', 5),
  ('CORE%', 'Streamline Registry%', 'Initiate capacity building on preparation of 2nd%', 6),
  ('CORE%', 'Streamline Registry%', 'Facilitate implementation of backlog%', 7),
  ('CORE%', 'Streamline Registry%', 'Track compliance with Hon. CRJ%', 8),
  ('CORE%', 'Streamline Registry%', 'Facilitate Gazettement of forfeiture%', 9),
  -- A12 Administrative support
  ('CORE%', 'Provide administrative support%', 'Facilitate Judges on various administrative requests%', 0),
  ('CORE%', 'Provide administrative support%', 'Facilitate procurement of robes%', 1),
  ('CORE%', 'Provide administrative support%', 'Prepare and submit quarterly administrative support status report%', 2),
  ('CORE%', 'Provide administrative support%', '%Administrative Support Standard Operating%', 3),
  ('CORE%', 'Provide administrative support%', 'Provide Technical Support on budgeting%', 4),
  -- A13 Supervision of Deputy Registrars
  ('CORE%', 'Supervision of%', 'Conduct spot checks%', 0),
  ('CORE%', 'Supervision of%', 'The Registrar will follow up with stations upon receipt%', 1),
  ('CORE%', 'Supervision of%', 'Coordinate with Deputy Registrars to ensure the proper maintenance%', 2),
  ('CORE%', 'Supervision of%', 'Conduct sensitization forums for Deputy Registrars%', 3),
  ('CORE%', 'Supervision of%', 'Facilitate 4 regional meetings%', 4),
  -- A14 Infrastructure and Assets
  ('CORE%', 'Maintenance of Infrastructure%', 'Procure and distribute furniture%', 0),
  ('CORE%', 'Maintenance of Infrastructure%', 'Update needs assessment as requested%', 1),
  ('CORE%', 'Maintenance of Infrastructure%', 'Follow up with relevant directorates%', 2),
  -- B1 Service Delivery Charter
  ('CUSTOMER%', 'Compliance with Service Delivery%', 'Disseminate the High Court Service Delivery charter%', 0),
  ('CUSTOMER%', 'Compliance with Service Delivery%', 'Monitor compliance with Service Delivery Charter%', 1),
  -- C2 Audit Report Recommendations (Financial)
  ('FINANC%', 'Implementation of Audit%', 'Implement all final audit report recommendations%', 0),
  ('FINANC%', 'Implementation of Audit%', 'The Registrar will respond to High Court station%', 1),
  ('FINANC%', 'Implementation of Audit%', 'Follow up with High court Stations/Divisions on the implementation of internal audit%', 2),
  -- C3 Greening
  ('FINANC%', 'Greening%', 'Implement paperless%', 0),
  ('FINANC%', 'Greening%', 'Implement energy saving%', 1),
  -- D1 Service Improvement Innovations
  ('INNOVATION%', 'Service Improvement%', 'Replicate/adopt%', 0),
  ('INNOVATION%', 'Service Improvement%', 'May come up with one%', 1),
  -- D2 Competency Development
  ('INNOVATION%', 'Competenc%', 'Identify training gaps%', 0),
  ('INNOVATION%', 'Competenc%', 'Conduct at least one in-house training%', 1),
  -- E1 Corruption eradication
  ('INTERNAL%', 'Corruption%', 'Continue sensitizing%', 0),
  ('INTERNAL%', 'Corruption%', 'Document and maintain records%', 1),
  ('INTERNAL%', 'Corruption%', 'Implement the recommendations of corruption prevalence%', 2),
  ('INTERNAL%', 'Corruption%', 'Implement the recommendations of the consolidated integrity%', 3),
  ('INTERNAL%', 'Corruption%', 'Implement strategies to address reported%', 4),
  -- E2 Employee wellness
  ('INTERNAL%', 'Improve Employee wellness%', 'Maintain the ORHC staff welfare%', 0),
  ('INTERNAL%', 'Improve Employee wellness%', 'Organize one team building%', 1),
  -- E3 Employee Satisfaction
  ('INTERNAL%', 'Enhance Employee Satisfaction%', 'Hold quarterly staff meetings%', 0),
  ('INTERNAL%', 'Enhance Employee Satisfaction%', '%Employee Satisfaction and Work Environment Survey%', 1);

-- Phase 1: park matched activities far away from any real position
UPDATE strategic_activities sa
SET    "order" = 10000 + p.n
FROM   strategic_objectives so, strategic_plans sp, pmmu_activity_order p
WHERE  so.id = sa.objective_id
  AND  sp.id = so.plan_id
  AND  sp.perspective ILIKE p.persp
  AND  so.title ILIKE p.obj
  AND  sa.description ILIKE p.act;

-- Phase 2: move them into their PMMU position
UPDATE strategic_activities
SET    "order" = "order" - 10000
WHERE  "order" >= 10000;

COMMIT;
