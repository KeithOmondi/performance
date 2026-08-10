import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import PDFDocument from "pdfkit";
import axios from "axios";

/* ─── SHARED SELECT ───────────────────────────────────────────────── */
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
      WHEN i.assignee_model = 'User' THEN u.id
      ELSE t.id
    END                      AS "assigneeId",

    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE COALESCE(
        (
          SELECT string_agg(tm_u.name, ', ' ORDER BY tm_u.name)
          FROM team_members tm
          JOIN users tm_u ON tm_u.id = tm.user_id
          WHERE tm.team_id = t.id
        ),
        t.name
      )
    END                      AS "assigneeDisplayName",

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

  if (query.status === "Incomplete") {
    where += ` AND i.status != 'Completed'`;
  } else if (query.status) {
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

  if (query.hasSubmission === 'true') {
    where += ` AND EXISTS (
      SELECT 1 FROM submissions s
      WHERE s.indicator_id = i.id
    )`;
  }

  if (query.submissionStatus) {
    const statuses = (query.submissionStatus as string).split(',');
    const statusPlaceholders = statuses.map((_, idx) => `$${params.length + idx + 1}`).join(', ');
    params.push(...statuses);
    where += ` AND EXISTS (
      SELECT 1 FROM submissions s
      WHERE s.indicator_id = i.id
      AND s.review_status = ANY(ARRAY[${statusPlaceholders}]::review_status[])
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

/* ─── HELPER: Format evidence for PDF (matches UI display) ── */
function formatEvidenceForPdf(submissions: SubmissionRow[]): string {
  if (!submissions || submissions.length === 0) {
    return "";
  }

  const latestSubmission = submissions.reduce((latest, current) => {
    const latestDate = new Date(latest.submittedAt);
    const currentDate = new Date(current.submittedAt);
    return currentDate > latestDate ? current : latest;
  });

  const documentsWithDescriptions = latestSubmission.documents?.filter(
    (doc) => doc.description?.trim()
  ) || [];

  const hasNotes = latestSubmission.notes?.trim();
  const hasDocuments = documentsWithDescriptions.length > 0;

  if (!hasNotes && !hasDocuments) {
    return "";
  }

  let evidenceText = "";
  if (hasNotes) {
    evidenceText += latestSubmission.notes;
  }
  if (hasDocuments) {
    if (hasNotes) evidenceText += "\n\n";
    documentsWithDescriptions.forEach((doc, index) => {
      if (index > 0) evidenceText += "\n";
      evidenceText += "❖ " + doc.description;
    });
  }

  return evidenceText.trim();
}

/**
 * Returns the raw evidence lines (without the ❖ prefix already baked in) so
 * the caller can render the diamond marker and the text in different colors,
 * matching the UI's gold-diamond / dark-text bullet style.
 */
function getEvidenceLines(submissions: SubmissionRow[]): { isBullet: boolean; text: string }[] {
  if (!submissions || submissions.length === 0) return [];

  const latestSubmission = submissions.reduce((latest, current) => {
    const latestDate = new Date(latest.submittedAt);
    const currentDate = new Date(current.submittedAt);
    return currentDate > latestDate ? current : latest;
  });

  const documentsWithDescriptions = latestSubmission.documents?.filter(
    (doc) => doc.description?.trim()
  ) || [];

  const lines: { isBullet: boolean; text: string }[] = [];

  if (latestSubmission.notes?.trim()) {
    lines.push({ isBullet: false, text: latestSubmission.notes.trim() });
  }

  documentsWithDescriptions.forEach((doc) => {
    lines.push({ isBullet: true, text: doc.description!.trim() });
  });

  return lines;
}

/* ─── UI-matched color palette ──────────────────────────────────────────── */
const UI_COLORS = {
  darkGreen:      "#1d3331",
  gold:           "#c2a336",
  borderLight:    "#e2e8f0", // slate-200
  headerText:     "#334155", // slate-700
  bodyText:       "#1a2c2c",
  mutedText:      "#64748b", // slate-500
  perspectiveBg:  "#eef1f0", // ≈ dark green at 5% opacity over white
  perspectiveText:"#1d3331",
  completeBg:     "#d1fae5", // emerald-100
  completeText:   "#047857", // emerald-700
  completeBorder: "#a7f3d0", // emerald-200
  pendingBg:      "#fef3c7", // amber-100
  pendingText:    "#b45309", // amber-700
  pendingBorder:  "#fde68a", // amber-200
  rowAlt:         "#fcfcf7",
};

/* ─── HELPER: draw a table row in pdfkit with UI styling ── */
const COL_WIDTHS = [140, 50, 150, 110, 200, 90];
const ROW_PADDING = 6;
const FONT_SIZE = 7.5;
const LINE_HEIGHT = FONT_SIZE * 1.35;
const EVIDENCE_COL_INDEX = 4;
const STATUS_COL_INDEX = 5;

/**
 * Draws borders + optional fill for every column, and plain text for every
 * column EXCEPT those listed in `skipTextColumns` (used for the Evidence and
 * Status columns, which get custom-rendered content drawn on top afterward).
 */
function drawTableRow(
  doc: InstanceType<typeof PDFDocument>,
  cells: string[],
  x: number,
  y: number,
  opts: {
    bold?: boolean;
    fillColor?: string;
    textColor?: string;
    isHeader?: boolean;
    skipTextColumns?: number[];
  } = {}
): number {
  const skip = new Set(opts.skipTextColumns ?? []);

  let maxLines = 1;
  cells.forEach((text, i) => {
    const w = COL_WIDTHS[i] - ROW_PADDING * 2;
    const approxCh = Math.floor(w / (FONT_SIZE * 0.52));
    const words = text.split(/\n/);
    let lines = 0;
    words.forEach((line) => {
      lines += Math.max(1, Math.ceil(line.length / approxCh));
    });
    if (lines > maxLines) maxLines = lines;
  });

  const rowHeight = maxLines * LINE_HEIGHT + ROW_PADDING * 2;

  if (opts.fillColor) {
    doc.save()
      .rect(x, y, COL_WIDTHS.reduce((a, b) => a + b, 0), rowHeight)
      .fill(opts.fillColor)
      .restore();
  }

  let cx = x;
  COL_WIDTHS.forEach((w) => {
    doc.save()
      .rect(cx, y, w, rowHeight)
      .stroke(UI_COLORS.borderLight)
      .restore();
    cx += w;
  });

  cx = x;
  cells.forEach((text, i) => {
    if (!skip.has(i)) {
      const color = opts.textColor || (opts.isHeader ? UI_COLORS.headerText : UI_COLORS.bodyText);
      doc
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.isHeader ? 7 : FONT_SIZE)
        .fillColor(color)
        .text(text, cx + ROW_PADDING, y + ROW_PADDING, {
          width: COL_WIDTHS[i] - ROW_PADDING * 2,
          height: rowHeight - ROW_PADDING,
          ellipsis: false,
          align: i === 1 ? "center" : "left",
        });
    }
    cx += COL_WIDTHS[i];
  });

  return rowHeight;
}

/** Draws a rounded pill badge for the Status column, matching the UI's StatusBadge. */
function drawStatusPill(
  doc: InstanceType<typeof PDFDocument>,
  status: string,
  colX: number,
  rowY: number,
  rowHeight: number
): void {
  const isCompleted = status === "Completed";
  const label = isCompleted ? "COMPLETE" : "INCOMPLETE";
  const bg = isCompleted ? UI_COLORS.completeBg : UI_COLORS.pendingBg;
  const border = isCompleted ? UI_COLORS.completeBorder : UI_COLORS.pendingBorder;
  const text = isCompleted ? UI_COLORS.completeText : UI_COLORS.pendingText;

  const colWidth = COL_WIDTHS[STATUS_COL_INDEX];
  const pillFontSize = 6.5;
  doc.font("Helvetica-Bold").fontSize(pillFontSize);
  const textWidth = doc.widthOfString(label);

  const pillPaddingX = 8;
  const pillHeight = 14;
  const pillWidth = Math.min(colWidth - 12, textWidth + pillPaddingX * 2);

  const pillX = colX + (colWidth - pillWidth) / 2;
  const pillY = rowY + (rowHeight - pillHeight) / 2;

  doc.save()
    .roundedRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2)
    .fillAndStroke(bg, border)
    .restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(pillFontSize)
    .fillColor(text)
    .text(label, pillX, pillY + (pillHeight - pillFontSize) / 2 - 1, {
      width: pillWidth,
      align: "center",
    });
}

/** Draws the Evidence column's bullet lines with a gold diamond marker and dark text, matching the UI's EvidenceCell. */
function drawEvidenceCell(
  doc: InstanceType<typeof PDFDocument>,
  submissions: SubmissionRow[],
  colX: number,
  rowY: number,
  rowHeight: number
): void {
  const lines = getEvidenceLines(submissions);
  if (lines.length === 0) return;

  const colWidth = COL_WIDTHS[EVIDENCE_COL_INDEX];
  const innerX = colX + ROW_PADDING;
  const innerWidth = colWidth - ROW_PADDING * 2;
  const diamondWidth = 10;

  let cy = rowY + ROW_PADDING;

  for (const line of lines) {
    if (line.isBullet) {
      doc
        .font("Helvetica")
        .fontSize(FONT_SIZE)
        .fillColor(UI_COLORS.gold)
        .text("❖", innerX, cy, { width: diamondWidth, lineBreak: false });

      const textHeight = doc.heightOfString(line.text, {
        width: innerWidth - diamondWidth,
      });

      doc
        .font("Helvetica-Bold")
        .fontSize(FONT_SIZE)
        .fillColor(UI_COLORS.bodyText)
        .text(line.text, innerX + diamondWidth, cy, {
          width: innerWidth - diamondWidth,
        });

      cy += Math.max(textHeight, LINE_HEIGHT) + 2;
    } else {
      const textHeight = doc.heightOfString(line.text, { width: innerWidth });
      doc
        .font("Helvetica-Oblique")
        .fontSize(FONT_SIZE)
        .fillColor(UI_COLORS.mutedText)
        .text(line.text, innerX, cy, { width: innerWidth });
      cy += textHeight + 4;
    }
  }
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
        ROUND(AVG(i.progress))::int                                         AS "avgProgress",
        COUNT(DISTINCT i.id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM submissions s
            WHERE s.indicator_id = i.id
          )
        )::int                                                              AS "hasSubmissions",
        COUNT(DISTINCT i.id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM submissions s
            WHERE s.indicator_id = i.id
            AND s.review_status IN ('Verified', 'Accepted', 'Partially Approved')
          )
        )::int                                                              AS "submittedComplete"
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

const LOGO_URL = "https://res.cloudinary.com/do0yflasl/image/upload/v1781759596/JOB_LOGO_ubls4m.jpg";

async function fetchLogoBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch (err) {
    console.error("[getTrackerPdf] Failed to fetch logo:", err);
    return null;
  }
}

export const getTrackerPdf = asyncHandler(
  async (req: Request, res: Response) => {
    const { where, params } = buildWhereClause(req.query);

    const { rows } = await pool.query(
      `${REPORT_SELECT} ${REPORT_JOINS} ${where}
       ORDER BY sp.perspective ASC, so.title ASC, sa.description ASC`,
      params
    );

    const grouped = groupByPerspective(rows as IndicatorRow[]);

    const logoBuffer = await fetchLogoBuffer(LOGO_URL);

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 50, bottom: 40, left: 20, right: 20 },
      bufferPages: true,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tracker-${new Date().toISOString().slice(0, 10)}.pdf"`
    );
    doc.pipe(res);

    const PAGE_WIDTH = doc.page.width;
    const LOGO_SIZE = 60;

    // ── HEADER with UI styling ──
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, (PAGE_WIDTH - LOGO_SIZE) / 2, doc.y, {
          width: LOGO_SIZE,
          height: LOGO_SIZE,
        });
        doc.moveDown(LOGO_SIZE / doc.currentLineHeight() + 1);
      } catch (err) {
        console.error("[getTrackerPdf] Failed to render logo image:", err);
      }
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor(UI_COLORS.darkGreen)
      .text("RHC 2025/2026 PMMU 1ST JULY 2025 TO 30TH JUNE 2026", {
        align: "center",
        characterSpacing: 0.5,
      })
      .moveDown(0.2);

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(UI_COLORS.gold)
      .text("Implementation and Evaluation Tracker", {
        align: "center",
        characterSpacing: 2,
      })
      .moveDown(0.8);

    const TABLE_X = doc.page.margins.left;
    const HEADER_CELLS = [
      "INDICATORS",
      "UNIT OF MEASURE",
      "EXPLANATORY NOTES",
      "RESPONSIBILITY",
      "EVIDENCE",
      "STATUS",
    ];

    let cursorY = doc.y;

    // ── Header row: white background, dark bold uppercase text (matches UI) ──
    const drawHeaderRow = () =>
      drawTableRow(doc, HEADER_CELLS, TABLE_X, cursorY, {
        bold: true,
        isHeader: true,
      });

    const headerHeight = drawHeaderRow();
    cursorY += headerHeight;

    const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom - 20;
    const TABLE_WIDTH = COL_WIDTHS.reduce((a, b) => a + b, 0);

    let rowIndex = 0;

    for (const persp of grouped) {
      if (cursorY + 25 > PAGE_BOTTOM) {
        doc.addPage();
        cursorY = doc.page.margins.top;
        cursorY += drawHeaderRow();
      }

      // ── Perspective banner: light tinted background, dark green text (matches UI) ──
      doc.save()
        .rect(TABLE_X, cursorY, TABLE_WIDTH, 20)
        .fill(UI_COLORS.perspectiveBg)
        .restore();

      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor(UI_COLORS.perspectiveText)
        .text(persp.perspective, TABLE_X + ROW_PADDING, cursorY + 5, {
          width: TABLE_WIDTH - ROW_PADDING * 2,
          characterSpacing: 0.5,
        });

      doc.save()
        .rect(TABLE_X, cursorY, TABLE_WIDTH, 20)
        .stroke(UI_COLORS.borderLight)
        .restore();
      cursorY += 20;

      let lastObjectiveId: string | null = null;

      for (const obj of persp.objectives) {
        for (const act of obj.activities) {
          for (const ind of act.indicators) {
            const evidenceText = formatEvidenceForPdf(ind.submissions || []);

            const isFirstForObjective = obj.id !== lastObjectiveId;
            lastObjectiveId = obj.id;

            const indicatorLabel = obj.title?.trim() || act.description;
            const indicatorCell = isFirstForObjective ? indicatorLabel : "";

            // Text used only for row-height estimation; actual rendering of
            // Evidence and Status columns is skipped in drawTableRow and
            // done separately below via drawEvidenceCell / drawStatusPill.
            const cells = [
              indicatorCell,
              ind.unit || "%",
              act.description + (ind.instructions ? `\n${ind.instructions}` : ""),
              ind.assigneeDisplayName || "Unassigned",
              evidenceText,
              ind.status === "Completed" ? "COMPLETE" : "INCOMPLETE",
            ];

            const estLines = cells.reduce((max, text, i) => {
              const w = COL_WIDTHS[i] - ROW_PADDING * 2;
              const approxCh = Math.floor(w / (FONT_SIZE * 0.52));
              const lines = text.split("\n").reduce((s, l) => s + Math.max(1, Math.ceil(l.length / approxCh)), 0);
              return Math.max(max, lines);
            }, 1);
            const estHeight = estLines * LINE_HEIGHT + ROW_PADDING * 2;

            if (cursorY + estHeight > PAGE_BOTTOM) {
              doc.addPage();
              cursorY = doc.page.margins.top;
              cursorY += drawHeaderRow();
            }

            const bgColor = rowIndex % 2 === 0 ? UI_COLORS.rowAlt : "#ffffff";

            const rowH = drawTableRow(doc, cells, TABLE_X, cursorY, {
              fillColor: bgColor,
              skipTextColumns: [EVIDENCE_COL_INDEX, STATUS_COL_INDEX],
            });

            // Column x-offset for Evidence and Status columns
            const evidenceColX = TABLE_X + COL_WIDTHS.slice(0, EVIDENCE_COL_INDEX).reduce((a, b) => a + b, 0);
            const statusColX = TABLE_X + COL_WIDTHS.slice(0, STATUS_COL_INDEX).reduce((a, b) => a + b, 0);

            drawEvidenceCell(doc, ind.submissions || [], evidenceColX, cursorY, rowH);
            drawStatusPill(doc, ind.status, statusColX, cursorY, rowH);

            cursorY += rowH;
            rowIndex++;
          }
        }
      }
    }

    // ── Footer with UI styling (applied to all pages) ──
    const totalPages = doc.bufferedPageRange().count || 1;

    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);

      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor(UI_COLORS.mutedText)
        .text(
          `RHC PMMU Tracker · FY 2024/2025 · Generated ${new Date().toLocaleDateString("en-KE", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}`,
          TABLE_X,
          doc.page.height - doc.page.margins.bottom,
          { align: "center", width: TABLE_WIDTH }
        )
        .text(
          `Page ${i + 1} of ${totalPages}`,
          TABLE_X + TABLE_WIDTH - 60,
          doc.page.height - doc.page.margins.bottom,
          { width: 60, align: "right" }
        );
    }

    doc.end();
  }
);