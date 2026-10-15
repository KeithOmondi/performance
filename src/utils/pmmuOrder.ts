/**
 * Ordering that mirrors the signed ORHC 2025/2026 PMMU:
 *   A. Core Business → B. Customer → C. Finance → D. Innovation & Learning → E. Internal Process,
 * then objectives by their PMMU number (strategic_objectives.sort_order),
 * then activities by their PMMU letter (strategic_activities."order").
 */
export const perspectiveRankSql = (col: string) => `(CASE
  WHEN ${col} ILIKE 'CORE%'       THEN 1
  WHEN ${col} ILIKE 'CUSTOMER%'   THEN 2
  WHEN ${col} ILIKE 'FINANC%'     THEN 3
  WHEN ${col} ILIKE 'INNOVATION%' THEN 4
  WHEN ${col} ILIKE 'INTERNAL%'   THEN 5
  ELSE 9
END)`;

/** sp = strategic_plans alias, so = strategic_objectives alias */
export const objectiveOrderSql = (sp: string, so: string) =>
  `${perspectiveRankSql(`${sp}.perspective`)}, ${sp}.perspective, ${so}.sort_order NULLS LAST, ${so}.created_at, ${so}.title`;

/** sa = strategic_activities alias */
export const activityOrderSql = (sa: string) =>
  `${sa}."order" NULLS LAST, ${sa}.created_at`;

/** Full PMMU ordering for indicator rows (i = indicators alias). */
export const pmmuOrderSql = (sp: string, so: string, sa: string, i: string) =>
  `${objectiveOrderSql(sp, so)}, ${activityOrderSql(sa)}, ${i}.created_at`;
