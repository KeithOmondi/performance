import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import PDFDocument from "pdfkit";

/* ─── SHARED SELECT ───────────────────────────────────────────────────────── */
const REPORT_SELECT = `
  SELECT
    sp.id                    AS "planId",
    sp.perspective,

    so.id                    AS "objectiveId",
    so.title                 AS "objectiveTitle",

    sa.id                    AS "activityId",
    sa.description           AS "activityDescription",

    i.id                     AS "indicatorId",
    i.status,
    i.weight,
    i.unit,
    i.target,
    i.progress,
    i.deadline,
    i.instructions,
    i.reporting_cycle        AS "reportingCycle",
    i.active_quarter         AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.assignee_model         AS "assignmentType",

    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE t.name
    END                      AS "assigneeDisplayName",

    CASE
      WHEN i.assignee_model = 'User' THEN u.id
      ELSE t.id
    END                      AS "assigneeId",

    ab.name                  AS "assignedByName",

    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'submissionId',  s.id,
            'quarter',       s.quarter,
            'year',          s.year,
            'achievedValue', s.achieved_value,
            'notes',         s.notes,
            'reviewStatus',  s.review_status,
            'submittedAt',   s.submitted_at,
            'documents',     COALESCE(
              (
                SELECT json_agg(json_build_object(
                  'fileName',    sd.file_name,
                  'fileType',    sd.file_type,
                  'evidenceUrl', sd.evidence_url,
                  'description', sd.description,
                  'status',      sd.status
                ))
                FROM submission_documents sd
                WHERE sd.submission_id = s.id
              ), '[]'::json
            )
          )
          ORDER BY s.year ASC, s.quarter ASC
        )
        FROM submissions s
        WHERE s.indicator_id = i.id
      ), '[]'::json
    )                        AS "submissions"
`;

const REPORT_JOINS = `
  FROM strategic_plans sp
  JOIN strategic_objectives so ON so.plan_id       = sp.id
  JOIN strategic_activities sa  ON sa.objective_id  = so.id
  JOIN indicators i             ON i.activity_id    = sa.id
  LEFT JOIN users u             ON i.assignee_id    = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t             ON i.assignee_id    = t.id AND i.assignee_model = 'Team'
  LEFT JOIN users ab            ON i.assigned_by    = ab.id
`;

/* ─── SHARED FILTER BUILDER ───────────────────────────────────────────────── */
function buildWhereClause(query: Request["query"]): {
  where: string;
  params: (string | number)[];
} {
  let where = "WHERE i.deleted_at IS NULL";
  const params: (string | number)[] = [];

  if (query.perspective) {
    params.push(query.perspective as string);
    where += ` AND sp.perspective = $${params.length}`;
  }
  if (query.status) {
    params.push(query.status as string);
    where += ` AND i.status = $${params.length}`;
  }
  if (query.assigneeId) {
    params.push(query.assigneeId as string);
    where += ` AND i.assignee_id = $${params.length}`;
  }
  if (query.quarter) {
    params.push(Number(query.quarter));
    where += ` AND i.active_quarter = $${params.length}`;
  }
  if (query.year) {
    params.push(Number(query.year));
    where += ` AND EXISTS (
      SELECT 1 FROM submissions s2
      WHERE s2.indicator_id = i.id AND s2.year = $${params.length}
    )`;
  }

  return { where, params };
}

/* ─── INTERFACES ──────────────────────────────────────────────────────────── */
interface IndicatorRow {
  perspective:          string;
  objectiveId:          string;
  objectiveTitle:       string;
  activityId:           string;
  activityDescription:  string;
  indicatorId:          string;
  status:               string;
  weight:               number;
  unit:                 string;
  target:               number;
  progress:             number;
  deadline:             string;
  instructions:         string;
  reportingCycle:       string;
  activeQuarter:        number;
  currentTotalAchieved: number;
  assignmentType:       string;
  assigneeId:           string;
  assigneeDisplayName:  string;
  assignedByName:       string;
  submissions:          SubmissionRow[];
}

interface SubmissionRow {
  submissionId:  string;
  quarter:       number;
  year:          number;
  achievedValue: number;
  notes:         string;
  reviewStatus:  string;
  submittedAt:   string;
  documents:     DocumentRow[];
}

interface DocumentRow {
  fileName:    string;
  fileType:    string;
  evidenceUrl: string;
  description: string;
  status:      string;
}

interface GroupedActivity {
  id:          string;
  description: string;
  indicators:  IndicatorRow[];
}

interface GroupedObjective {
  id:         string;
  title:      string;
  activities: GroupedActivity[];
}

interface GroupedPerspective {
  perspective: string;
  objectives:  GroupedObjective[];
}

/* ─── HELPER: group flat rows → nested perspective/objective/activity ─────── */
function groupByPerspective(rows: IndicatorRow[]): GroupedPerspective[] {
  const map: Record<string, {
    perspective: string;
    objectives:  Record<string, {
      id:         string;
      title:      string;
      activities: Record<string, {
        id:          string;
        description: string;
        indicators:  IndicatorRow[];
      }>;
    }>;
  }> = {};

  for (const row of rows) {
    const p = row.perspective;

    if (!map[p]) map[p] = { perspective: p, objectives: {} };

    const objKey = row.objectiveId;
    if (!map[p].objectives[objKey]) {
      map[p].objectives[objKey] = {
        id:         row.objectiveId,
        title:      row.objectiveTitle,
        activities: {},
      };
    }

    const actKey = row.activityId;
    if (!map[p].objectives[objKey].activities[actKey]) {
      map[p].objectives[objKey].activities[actKey] = {
        id:          row.activityId,
        description: row.activityDescription,
        indicators:  [],
      };
    }

    map[p].objectives[objKey].activities[actKey].indicators.push({
      indicatorId:          row.indicatorId,
      status:               row.status,
      weight:               row.weight,
      unit:                 row.unit,
      target:               row.target,
      progress:             row.progress,
      deadline:             row.deadline,
      instructions:         row.instructions,
      reportingCycle:       row.reportingCycle,
      activeQuarter:        row.activeQuarter,
      currentTotalAchieved: row.currentTotalAchieved,
      assignmentType:       row.assignmentType,
      assigneeId:           row.assigneeId,
      assigneeDisplayName:  row.assigneeDisplayName,
      assignedByName:       row.assignedByName,
      submissions:          row.submissions,
    } as IndicatorRow);
  }

  return Object.values(map).map((p) => ({
    ...p,
    objectives: Object.values(p.objectives).map((o) => ({
      ...o,
      activities: Object.values(o.activities),
    })),
  }));
}

/* ─── HELPER: draw a table row in pdfkit ─────────────────────────────────── */
const COL_WIDTHS  = [160, 40, 150, 110, 200, 110]; // landscape ~770pt usable
const ROW_PADDING = 6;
const FONT_SIZE   = 7.5;
const LINE_HEIGHT  = FONT_SIZE * 1.35;

function drawTableRow(
  doc: InstanceType<typeof PDFDocument>,
  cells: string[],
  x: number,
  y: number,
  opts: { bold?: boolean; fillColor?: string } = {}
): number {
  // measure tallest cell first
  let maxLines = 1;
  cells.forEach((text, i) => {
    const w        = COL_WIDTHS[i] - ROW_PADDING * 2;
    const approxCh = Math.floor(w / (FONT_SIZE * 0.52));
    const words    = text.split(/\n/);
    let lines      = 0;
    words.forEach((line) => {
      lines += Math.max(1, Math.ceil(line.length / approxCh));
    });
    if (lines > maxLines) maxLines = lines;
  });

  const rowHeight = maxLines * LINE_HEIGHT + ROW_PADDING * 2;

  // background fill
  if (opts.fillColor) {
    doc.save().rect(x, y, COL_WIDTHS.reduce((a, b) => a + b, 0), rowHeight)
       .fill(opts.fillColor).restore();
  }

  // borders
  let cx = x;
  COL_WIDTHS.forEach((w) => {
    doc.save().rect(cx, y, w, rowHeight).stroke("#d1d5db").restore();
    cx += w;
  });

  // text
  cx = x;
  cells.forEach((text, i) => {
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(FONT_SIZE)
      .fillColor("#1f2937")
      .text(text, cx + ROW_PADDING, y + ROW_PADDING, {
        width:    COL_WIDTHS[i] - ROW_PADDING * 2,
        height:   rowHeight - ROW_PADDING,
        ellipsis: false,
      });
    cx += COL_WIDTHS[i];
  });

  return rowHeight;
}

/* ─── 1. GET FULL TRACKER REPORT ──────────────────────────────────────────── */
export const getTrackerReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { where, params } = buildWhereClause(req.query);

    const { rows } = await pool.query(
      `${REPORT_SELECT} ${REPORT_JOINS} ${where}
       ORDER BY sp.perspective ASC, so.title ASC, sa.description ASC`,
      params
    );

    res.status(200).json({
      success: true,
      count:   rows.length,
      data:    groupByPerspective(rows as IndicatorRow[]),
      raw:     rows,
    });
  }
);

/* ─── 2. GET REPORT BY PLAN ID ────────────────────────────────────────────── */
export const getReportByPlanId = asyncHandler(
  async (req: Request, res: Response) => {
    const { planId } = req.params;

    const { rows } = await pool.query(
      `${REPORT_SELECT} ${REPORT_JOINS}
       WHERE sp.id = $1 AND i.deleted_at IS NULL
       ORDER BY so.title ASC, sa.description ASC`,
      [planId]
    );

    if (rows.length === 0) {
      throw new AppError("No indicators found for this plan.", 404);
    }

    res.status(200).json({
      success: true,
      count:   rows.length,
      data:    groupByPerspective(rows as IndicatorRow[]),
      raw:     rows,
    });
  }
);

/* ─── 3. GET REPORT SUMMARY ───────────────────────────────────────────────── */
export const getReportSummary = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        sp.perspective,
        COUNT(DISTINCT i.id)::int                                           AS "totalIndicators",
        COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'Completed')::int    AS "completed",
        COUNT(DISTINCT i.id) FILTER (WHERE i.assignee_id IS NULL)::int     AS "unassigned",
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')
        )::int                                                              AS "awaitingReview",
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.deadline < NOW()
            AND i.status NOT IN ('Completed', 'Awaiting Admin Approval', 'Awaiting Super Admin')
            AND i.assignee_id IS NOT NULL
        )::int                                                              AS "overdue",
        ROUND(AVG(i.progress))::int                                         AS "avgProgress"
      FROM strategic_plans sp
      JOIN strategic_objectives so ON so.plan_id      = sp.id
      JOIN strategic_activities sa  ON sa.objective_id = so.id
      JOIN indicators i             ON i.activity_id   = sa.id
      WHERE i.deleted_at IS NULL
      GROUP BY sp.perspective
      ORDER BY sp.perspective ASC
    `);

    res.status(200).json({ success: true, data: rows });
  }
);

/* ─── 4. GET TRACKER PDF ──────────────────────────────────────────────────── */
export const getTrackerPdf = asyncHandler(
  async (req: Request, res: Response) => {
    const { where, params } = buildWhereClause(req.query);

    const { rows } = await pool.query(
      `${REPORT_SELECT} ${REPORT_JOINS} ${where}
       ORDER BY sp.perspective ASC, so.title ASC, sa.description ASC`,
      params
    );

    const grouped = groupByPerspective(rows as IndicatorRow[]);

    /* ── Create PDF (A4 landscape) ── */
    const doc = new PDFDocument({
      size:    "A4",
      layout:  "landscape",
      margins: { top: 50, bottom: 40, left: 20, right: 20 },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tracker-${new Date().toISOString().slice(0, 10)}.pdf"`
    );
    doc.pipe(res);

    /* ── Header ── */
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#374151")
      .text(
        "RHC 2024/2025 PMMU — Implementation and Evaluation Tracker",
        { align: "center" }
      )
      .moveDown(0.5);

    /* ── Generated date ── */
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6b7280")
      .text(`Generated: ${new Date().toLocaleDateString("en-KE")}`, { align: "right" })
      .moveDown(0.5);

    /* ── Column headers ── */
    const TABLE_X      = doc.page.margins.left;
    const HEADER_CELLS = [
      "INDICATORS", "Unit", "Explanatory Notes",
      "Responsibility", "Evidence", "Eval. Person",
    ];

    let cursorY = doc.y;

    const headerHeight = drawTableRow(doc, HEADER_CELLS, TABLE_X, cursorY, {
      bold:      true,
      fillColor: "#bbf7d0",
    });
    cursorY += headerHeight;

    /* ── Table body ── */
    let indicatorIndex = 0;
    const PAGE_BOTTOM  = doc.page.height - doc.page.margins.bottom - 20;
    const TABLE_WIDTH  = COL_WIDTHS.reduce((a, b) => a + b, 0);

    for (const persp of grouped) {
      /* Check space — add page if needed */
      if (cursorY + 20 > PAGE_BOTTOM) {
        doc.addPage();
        cursorY = doc.page.margins.top;
      }

      /* Perspective section header */
      doc.save()
         .rect(TABLE_X, cursorY, TABLE_WIDTH, 18)
         .fill("#d1fae5")
         .restore();

      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#14532d")
        .text(persp.perspective, TABLE_X + ROW_PADDING, cursorY + 4, {
          width: TABLE_WIDTH - ROW_PADDING * 2,
        });

      doc.save().rect(TABLE_X, cursorY, TABLE_WIDTH, 18).stroke("#d1d5db").restore();
      cursorY += 18;

      for (const obj of persp.objectives) {
        for (const act of obj.activities) {
          for (const ind of act.indicators) {
            indicatorIndex += 1;

            /* Evidence lines */
            const evidenceLines: string[] = [];
            if (ind.submissions?.length > 0) {
              for (const sub of ind.submissions) {
                const period = sub.quarter === 0 ? "Annual" : `Q${sub.quarter}`;
                evidenceLines.push(`${period} ${sub.year} [${sub.reviewStatus}]`);
                if (sub.notes) evidenceLines.push(`  ${sub.notes}`);
                if (sub.documents) {
                  for (const doc of sub.documents) {
                    evidenceLines.push(
                      `  * ${doc.fileName || doc.description || "Document"}`
                    );
                  }
                }
              }
            } else {
              evidenceLines.push("No submissions yet");
            }

            const cells = [
              `${indicatorIndex}. ${obj.title}\n[${ind.status}] ${ind.progress ?? 0}%`,
              ind.unit || "%",
              act.description + (ind.instructions ? `\n${ind.instructions}` : ""),
              ind.assigneeDisplayName || "Unassigned",
              evidenceLines.join("\n"),
              ind.assignedByName || "—",
            ];

            /* Estimate row height to check for page break */
            const estLines = cells.reduce((max, text, i) => {
              const w        = COL_WIDTHS[i] - ROW_PADDING * 2;
              const approxCh = Math.floor(w / (FONT_SIZE * 0.52));
              const lines    = text.split("\n").reduce((s, l) => s + Math.max(1, Math.ceil(l.length / approxCh)), 0);
              return Math.max(max, lines);
            }, 1);
            const estHeight = estLines * LINE_HEIGHT + ROW_PADDING * 2;

            if (cursorY + estHeight > PAGE_BOTTOM) {
              doc.addPage();
              cursorY = doc.page.margins.top;

              /* Re-draw header on new page */
              const h = drawTableRow(doc, HEADER_CELLS, TABLE_X, cursorY, {
                bold:      true,
                fillColor: "#bbf7d0",
              });
              cursorY += h;
            }

            const rowH = drawTableRow(doc, cells, TABLE_X, cursorY);
            cursorY += rowH;
          }
        }
      }
    }

    /* ── Footer on each page (pdfkit doesn't auto-footer, so stamp last page) ── */
    const totalPages = (doc as any)._pageBuffer?.length ?? 1;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#9ca3af")
      .text(
        `Page 1 of ${totalPages}  ·  Generated ${new Date().toLocaleDateString("en-KE")}`,
        TABLE_X,
        doc.page.height - doc.page.margins.bottom,
        { align: "center", width: TABLE_WIDTH }
      );

    doc.end();
  }
);