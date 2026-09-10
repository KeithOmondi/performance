import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import PDFDocument from "pdfkit";
import axios from "axios";

/* ============================================================================
   SHARED SELECT
============================================================================ */

const REPORT_SELECT = `
  SELECT
    sp.id AS "planId",
    sp.perspective,

    so.id AS "objectiveId",
    so.title AS "objectiveTitle",

    sa.id AS "activityId",
    sa.description AS "activityDescription",

    i.id AS "indicatorId",
    i.status,
    i.weight,
    i.unit,
    i.target,
    i.progress,
    i.deadline,
    i.instructions,
    i.reporting_cycle AS "reportingCycle",
    i.active_quarter AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.assignee_model AS "assignmentType",

    CASE
      WHEN i.assignee_model = 'User' THEN u.id
      ELSE t.id
    END AS "assigneeId",

    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE COALESCE(
        (
          SELECT string_agg(
            tm_u.name,
            ', '
            ORDER BY tm_u.name
          )
          FROM team_members tm
          JOIN users tm_u
            ON tm_u.id = tm.user_id
          WHERE tm.team_id = t.id
        ),
        t.name
      )
    END AS "assigneeDisplayName",

    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'submissionId', s.id,
            'quarter', s.quarter,
            'year', s.year,
            'achievedValue', s.achieved_value,
            'notes', s.notes,
            'submittedAt', s.submitted_at,

            'documents',
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'fileName', sd.file_name,
                    'fileType', sd.file_type,
                    'evidenceUrl', sd.evidence_url,
                    'description', sd.description,
                    'status', sd.status
                  )
                )
                FROM submission_documents sd
                WHERE sd.submission_id = s.id
                  AND sd.status != 'Deleted'
              ),
              '[]'::json
            )
          )
          ORDER BY
            s.year ASC,
            s.quarter ASC,
            s.submitted_at DESC
        )
        FROM submissions s
        WHERE s.indicator_id = i.id
          AND s.review_status NOT IN (
            'Rejected',
            'Correction Needed'
          )
      ),
      '[]'::json
    ) AS "submissions"
`;

const REPORT_JOINS = `
  FROM strategic_plans sp

  JOIN strategic_objectives so
    ON so.plan_id = sp.id

  JOIN strategic_activities sa
    ON sa.objective_id = so.id

  JOIN indicators i
    ON i.activity_id = sa.id

  LEFT JOIN users u
    ON i.assignee_id = u.id
   AND i.assignee_model = 'User'

  LEFT JOIN teams t
    ON i.assignee_id = t.id
   AND i.assignee_model = 'Team'
`;

/* ============================================================================
   SHARED FILTER BUILDER
============================================================================ */

function buildWhereClause(query: Request["query"]): {
  where: string;
  params: (string | number)[];
} {
  let where = "WHERE i.deleted_at IS NULL";

  const params: (string | number)[] = [];

  /*
   * Include:
   * - Completed
   * - Partially Approved
   * - Awaiting Super Admin
   * - Indicators with no submissions
   */
  where += `
    AND (
      i.status = 'Completed'
      OR i.status = 'Partially Approved'
      OR i.status = 'Awaiting Super Admin'
      OR NOT EXISTS (
        SELECT 1
        FROM submissions s
        WHERE s.indicator_id = i.id
      )
    )
  `;

  /*
   * Exclude rejected / returned indicators.
   */
  where += `
    AND i.status NOT IN (
      'Rejected by Admin',
      'Rejected by Super Admin',
      'Correction Needed',
      'Awaiting Admin Approval'
    )
  `;

  if (query.perspective) {
    params.push(query.perspective as string);

    where += `
      AND sp.perspective = $${params.length}
    `;
  }

  /*
   * Status filter — accepts a single value OR a comma-separated list.
   *   ?status=Completed
   *   ?status=Partially Approved,Awaiting Super Admin
   *   ?status=Pending,Verified,Awaiting Admin Approval,...
   *
   * The explicit ::indicator_status[] cast is required because
   * `i.status` is a Postgres enum, not text. A plain `ANY($N)` would
   * be treated as text[] and reject the comparison.
   */
  if (query.status && query.status !== "all") {
    const statuses = String(query.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (statuses.length === 1) {
      params.push(statuses[0]);

      where += `
        AND i.status = $${params.length}::indicator_status
      `;
    } else if (statuses.length > 1) {
      const placeholders = statuses
        .map((_, index) => `$${params.length + index + 1}`)
        .join(", ");

      params.push(...statuses);

      where += `
        AND i.status = ANY(ARRAY[${placeholders}]::indicator_status[])
      `;
    }
  }

  if (query.assigneeId) {
    params.push(query.assigneeId as string);

    where += `
      AND i.assignee_id = $${params.length}
    `;
  }

  if (query.quarter) {
    params.push(Number(query.quarter));

    where += `
      AND i.active_quarter = $${params.length}
    `;
  }

  if (query.year) {
    params.push(Number(query.year));

    where += `
      AND EXISTS (
        SELECT 1
        FROM submissions s2
        WHERE s2.indicator_id = i.id
          AND s2.year = $${params.length}
      )
    `;
  }

  if (query.hasSubmission === "true") {
    where += `
      AND EXISTS (
        SELECT 1
        FROM submissions s
        WHERE s.indicator_id = i.id
      )
    `;
  }

  if (query.hasSubmission === "false") {
    where += `
      AND NOT EXISTS (
        SELECT 1
        FROM submissions s
        WHERE s.indicator_id = i.id
      )
    `;
  }

  if (query.submissionStatus) {
    const statuses = (query.submissionStatus as string)
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);

    if (statuses.length > 0) {
      const statusPlaceholders = statuses
        .map(
          (_, index) =>
            `$${params.length + index + 1}`
        )
        .join(", ");

      params.push(...statuses);

      where += `
        AND EXISTS (
          SELECT 1
          FROM submissions s
          WHERE s.indicator_id = i.id
            AND s.review_status =
              ANY(
                ARRAY[${statusPlaceholders}]::review_status[]
              )
        )
      `;
    }
  }

  return {
    where,
    params,
  };
}

/* ============================================================================
   INTERFACES
============================================================================ */

interface DocumentRow {
  fileName: string;
  fileType: string;
  evidenceUrl: string;
  description: string;
  status: string;
}

interface SubmissionRow {
  submissionId: string;
  quarter: number;
  year: number;
  achievedValue: number;
  notes: string;
  submittedAt: string;
  documents: DocumentRow[];
}

interface IndicatorRow {
  planId: string;
  perspective: string;

  objectiveId: string;
  objectiveTitle: string;

  activityId: string;
  activityDescription: string;

  indicatorId: string;
  status: string;

  weight: number;
  unit: string;
  target: number;
  progress: number;

  deadline: string;
  instructions: string;

  reportingCycle: string;
  activeQuarter: number;
  currentTotalAchieved: number;

  assignmentType: string;
  assigneeId: string;
  assigneeDisplayName: string;

  submissions: SubmissionRow[];
}

interface GroupedActivity {
  id: string;
  description: string;
  indicators: IndicatorRow[];
}

interface GroupedObjective {
  id: string;
  title: string;
  activities: GroupedActivity[];
}

interface GroupedPerspective {
  perspective: string;
  objectives: GroupedObjective[];
}

/* ============================================================================
   GROUP FLAT ROWS
============================================================================ */

function groupByPerspective(
  rows: IndicatorRow[]
): GroupedPerspective[] {
  const map: Record<
    string,
    {
      planId: string;
      perspective: string;
      objectives: Record<
        string,
        {
          id: string;
          title: string;
          activities: Record<
            string,
            {
              id: string;
              description: string;
              indicators: IndicatorRow[];
            }
          >;
        }
      >;
    }
  > = {};

  for (const row of rows) {
    const key = `${row.planId}-${row.perspective}`;

    if (!map[key]) {
      map[key] = {
        planId: row.planId,
        perspective: row.perspective,
        objectives: {},
      };
    }

    const objectiveKey = row.objectiveId;

    if (!map[key].objectives[objectiveKey]) {
      map[key].objectives[objectiveKey] = {
        id: row.objectiveId,
        title:
          row.objectiveTitle ||
          row.perspective,
        activities: {},
      };
    }

    const activityKey = row.activityId;

    if (
      !map[key]
        .objectives[objectiveKey]
        .activities[activityKey]
    ) {
      map[key]
        .objectives[objectiveKey]
        .activities[activityKey] = {
          id: row.activityId,
          description: row.activityDescription,
          indicators: [],
        };
    }

    map[key]
      .objectives[objectiveKey]
      .activities[activityKey]
      .indicators.push(row);
  }

  return Object.values(map).map((perspective) => ({
    perspective: perspective.perspective,

    objectives: Object.values(
      perspective.objectives
    ).map((objective) => ({
      id: objective.id,
      title: objective.title,

      activities: Object.values(
        objective.activities
      ),
    })),
  }));
}

/* ============================================================================
   EVIDENCE HELPERS
============================================================================ */

interface EvidenceLine {
  isBullet: boolean;
  text: string;
}

/**
 * Returns ALL evidence.
 *
 * IMPORTANT:
 * There is deliberately NO evidence cap here.
 *
 * Every evidence description is rendered.
 * Only shows descriptions, not file names.
 * Review status is NOT displayed in the report.
 */
function getEvidenceLines(
  submissions: SubmissionRow[]
): EvidenceLine[] {
  if (
    !submissions ||
    submissions.length === 0
  ) {
    return [];
  }

  const lines: EvidenceLine[] = [];

  const sortedSubmissions = [
    ...submissions,
  ].sort((a, b) => {
    if (a.year !== b.year) {
      return a.year - b.year;
    }

    return a.quarter - b.quarter;
  });

  for (const submission of sortedSubmissions) {
    const periodLabel =
      submission.quarter === 0
        ? "Annual"
        : `Q${submission.quarter}`;

    const notes =
      submission.notes?.trim() || "";

    const documents =
      submission.documents || [];

    /*
     * Only active/non-deleted documents should
     * reach this point.
     */
    const validDocuments = documents.filter(
      (doc: DocumentRow) =>
        doc.status !== "Deleted"
    );

    /*
     * ✅ Only keep documents that have descriptions.
     * Do NOT fall back to file name.
     */
    const documentsWithDescription =
      validDocuments.filter((doc: DocumentRow) =>
        doc.description?.trim()
      );

    /*
     * If no documents have descriptions and no notes, skip this quarter.
     */
    if (
      !notes &&
      documentsWithDescription.length === 0
    ) {
      continue;
    }

    // ✅ REMOVED: Review status from header
    lines.push({
      isBullet: false,
      text: `─── ${periodLabel} ${submission.year} ───`,
    });

    if (notes) {
      lines.push({
        isBullet: false,
        text: notes,
      });
    }

    /*
     * ✅ Only show descriptions, not file names.
     */
    for (const document of documentsWithDescription) {
      lines.push({
        isBullet: true,
        text: document.description!.trim(),
      });
    }

    lines.push({
      isBullet: false,
      text: "",
    });
  }

  /*
   * Remove final blank separator.
   */
  if (
    lines.length > 0 &&
    lines[lines.length - 1].text === ""
  ) {
    lines.pop();
  }

  return lines;
}

/* ============================================================================
   PDF COLORS
============================================================================ */

const UI_COLORS = {
  darkGreen: "#1d3331",
  gold: "#c2a336",

  borderLight: "#dbe2e8",

  headerText: "#334155",
  bodyText: "#1a2c2c",
  mutedText: "#64748b",

  perspectiveBg: "#eef1f0",
  perspectiveText: "#1d3331",

  completeBg: "#d1fae5",
  completeText: "#047857",
  completeBorder: "#a7f3d0",

  pendingBg: "#fef3c7",
  pendingText: "#b45309",
  pendingBorder: "#fde68a",

  partialBg: "#ede9fe",
  partialText: "#6d28d9",
  partialBorder: "#c4b5fd",

  rowAlt: "#fcfcf7",
  white: "#ffffff",
};

/* ============================================================================
   PDF TABLE SETTINGS
============================================================================ */

/*
 * A4 landscape is approximately:
 *
 * width  = 841.89
 * height = 595.28
 *
 * With 20px left/right margins:
 *
 * printable width ≈ 801.89
 *
 * Therefore the columns MUST add up to <= 801.89.
 *
 * Previous controller had:
 *
 * 140 + 50 + 150 + 110 + 280 + 90 = 820
 *
 * which was wider than the printable A4 page.
 *
 * This version totals exactly 801.
 */

const COL_WIDTHS = [
  125, // Indicator
  45,  // Unit
  145, // Explanatory notes
  105, // Responsibility
  295, // Evidence
  86,  // Status
];

const TABLE_WIDTH = COL_WIDTHS.reduce(
  (sum, width) => sum + width,
  0
);

const ROW_PADDING = 6;

const FONT_SIZE = 7.5;

const LINE_HEIGHT =
  FONT_SIZE * 1.35;

const EVIDENCE_COL_INDEX = 4;
const STATUS_COL_INDEX = 5;

const HEADER_HEIGHT = 26;
const PERSPECTIVE_HEIGHT = 20;

/* ============================================================================
   GENERIC PDF HELPERS
============================================================================ */

function getPageBottom(
  doc: InstanceType<typeof PDFDocument>
): number {
  return (
    doc.page.height -
    doc.page.margins.bottom -
    22
  );
}

/**
 * Measure a normal table cell using the actual
 * PDFKit font and width rather than estimating
 * characters.
 */
function measureCellHeight(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  width: number,
  bold = false,
  fontSize = FONT_SIZE
): number {
  doc
    .font(
      bold
        ? "Helvetica-Bold"
        : "Helvetica"
    )
    .fontSize(fontSize);

  const height = doc.heightOfString(
    text || "",
    {
      width:
        width - ROW_PADDING * 2,
      align: "left",
    }
  );

  return Math.max(
    height,
    LINE_HEIGHT
  ) + ROW_PADDING * 2;
}

/**
 * Calculate the vertical height required by
 * one evidence line.
 */
function measureEvidenceLineHeight(
  doc: InstanceType<typeof PDFDocument>,
  line: EvidenceLine,
  colWidth: number
): number {
  const innerWidth =
    colWidth - ROW_PADDING * 2;

  const diamondWidth = 10;

  if (
    line.text.startsWith("───")
  ) {
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5);

    return (
      doc.heightOfString(
        line.text,
        {
          width: innerWidth,
          align: "center",
        }
      ) + 2
    );
  }

  if (line.text === "") {
    return 3;
  }

  if (line.isBullet) {
    doc
      .font("Helvetica-Bold")
      .fontSize(FONT_SIZE);

    const height =
      doc.heightOfString(
        line.text,
        {
          width:
            innerWidth -
            diamondWidth,
          align: "left",
        }
      );

    return (
      Math.max(
        height,
        LINE_HEIGHT
      ) + 1
    );
  }

  doc
    .font("Helvetica-Oblique")
    .fontSize(FONT_SIZE);

  return (
    doc.heightOfString(
      line.text,
      {
        width: innerWidth,
        align: "left",
      }
    ) + 1
  );
}

/**
 * Measure all evidence lines.
 */
function measureEvidenceHeight(
  doc: InstanceType<typeof PDFDocument>,
  lines: EvidenceLine[],
  colWidth: number
): number {
  if (!lines.length) {
    return 0;
  }

  let height = 0;

  for (const line of lines) {
    height += measureEvidenceLineHeight(
      doc,
      line,
      colWidth
    );
  }

  return height;
}

/* ============================================================================
   SPLIT LONG EVIDENCE TEXT
============================================================================ */

/**
 * A single evidence description can itself be extremely long.
 *
 * This helper prevents one description from becoming
 * taller than an entire A4 page.
 */
function splitEvidenceLineToHeight(
  doc: InstanceType<typeof PDFDocument>,
  line: EvidenceLine,
  colWidth: number,
  maxHeight: number
): {
  first: EvidenceLine | null;
  remainder: EvidenceLine | null;
} {
  const fullHeight =
    measureEvidenceLineHeight(
      doc,
      line,
      colWidth
    );

  if (fullHeight <= maxHeight) {
    return {
      first: line,
      remainder: null,
    };
  }

  /*
   * Quarter headers and blank lines are tiny and
   * should never need splitting.
   */
  if (
    line.text === "" ||
    line.text.startsWith("───")
  ) {
    return {
      first: null,
      remainder: line,
    };
  }

  const words = line.text
    .split(/\s+/)
    .filter(Boolean);

  if (words.length <= 1) {
    return {
      first: null,
      remainder: line,
    };
  }

  let low = 1;
  let high = words.length;
  let best = 0;

  /*
   * Binary search for the largest number of words
   * that fits the available vertical space.
   */
  while (low <= high) {
    const mid = Math.floor(
      (low + high) / 2
    );

    const candidateText =
      words.slice(0, mid).join(" ");

    const candidate: EvidenceLine = {
      isBullet: line.isBullet,
      text: candidateText,
    };

    const candidateHeight =
      measureEvidenceLineHeight(
        doc,
        candidate,
        colWidth
      );

    if (candidateHeight <= maxHeight) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  /*
   * Nothing fits on this page.
   */
  if (best === 0) {
    return {
      first: null,
      remainder: line,
    };
  }

  const firstText =
    words
      .slice(0, best)
      .join(" ");

  const remainderWords =
    words.slice(best);

  return {
    first: {
      isBullet: line.isBullet,
      text: firstText,
    },

    remainder:
      remainderWords.length > 0
        ? {
            isBullet: line.isBullet,
            text:
              remainderWords.join(" "),
          }
        : null,
  };
}

/* ============================================================================
   TAKE EVIDENCE THAT FITS IN A ROW
============================================================================ */

function takeEvidenceChunk(
  doc: InstanceType<typeof PDFDocument>,
  lines: EvidenceLine[],
  colWidth: number,
  availableHeight: number
): {
  chunk: EvidenceLine[];
  remaining: EvidenceLine[];
} {
  const chunk: EvidenceLine[] = [];

  let remainingHeight =
    availableHeight;

  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const lineHeight =
      measureEvidenceLineHeight(
        doc,
        line,
        colWidth
      );

    if (
      lineHeight <= remainingHeight
    ) {
      chunk.push(line);
      remainingHeight -= lineHeight;
      index++;
      continue;
    }

    /*
     * Try splitting a long line.
     */
    const split =
      splitEvidenceLineToHeight(
        doc,
        line,
        colWidth,
        remainingHeight
      );

    if (split.first) {
      chunk.push(split.first);

      if (split.remainder) {
        return {
          chunk,
          remaining: [
            split.remainder,
            ...lines.slice(index + 1),
          ],
        };
      }

      index++;
      continue;
    }

    /*
     * Nothing from this line fits.
     */
    break;
  }

  return {
    chunk,
    remaining: lines.slice(index),
  };
}

/* ============================================================================
   DRAW TABLE ROW
============================================================================ */

function drawTableRow(
  doc: InstanceType<typeof PDFDocument>,
  cells: string[],
  x: number,
  y: number,
  rowHeight: number,
  options: {
    fillColor?: string;
    bold?: boolean;
    isHeader?: boolean;
    skipTextColumns?: number[];
    continuation?: boolean;
  } = {}
): number {
  const skip = new Set(
    options.skipTextColumns || []
  );

  /*
   * Background.
   */
  if (options.fillColor) {
    doc.save();

    doc
      .rect(
        x,
        y,
        TABLE_WIDTH,
        rowHeight
      )
      .fill(options.fillColor);

    doc.restore();
  }

  /*
   * Vertical/horizontal borders.
   */
  let cx = x;

  for (const width of COL_WIDTHS) {
    doc.save();

    doc
      .rect(
        cx,
        y,
        width,
        rowHeight
      )
      .stroke(
        UI_COLORS.borderLight
      );

    doc.restore();

    cx += width;
  }

  /*
   * Cell text.
   */
  cx = x;

  cells.forEach((cell, index) => {
    if (!skip.has(index)) {
      const font =
        options.bold
          ? "Helvetica-Bold"
          : "Helvetica";

      const fontSize =
        options.isHeader
          ? 7
          : FONT_SIZE;

      doc
        .font(font)
        .fontSize(fontSize)
        .fillColor(
          options.isHeader
            ? UI_COLORS.headerText
            : UI_COLORS.bodyText
        );

      doc.text(
        cell || "",
        cx + ROW_PADDING,
        y + ROW_PADDING,
        {
          width:
            COL_WIDTHS[index] -
            ROW_PADDING * 2,

          height:
            rowHeight -
            ROW_PADDING * 2,

          align:
            index === 1
              ? "center"
              : "left",
        }
      );
    }

    cx += COL_WIDTHS[index];
  });

  /*
   * On continuation rows, identify that the
   * evidence is continuing.
   */
  if (
    options.continuation &&
    cells[EVIDENCE_COL_INDEX] === ""
  ) {
    const evidenceX =
      x +
      COL_WIDTHS
        .slice(
          0,
          EVIDENCE_COL_INDEX
        )
        .reduce(
          (sum, width) =>
            sum + width,
          0
        );

    doc
      .font("Helvetica-Oblique")
      .fontSize(6)
      .fillColor(
        UI_COLORS.mutedText
      )
      .text(
        "Evidence continued...",
        evidenceX +
          ROW_PADDING,
        y + ROW_PADDING,
        {
          width:
            COL_WIDTHS[
              EVIDENCE_COL_INDEX
            ] -
            ROW_PADDING * 2,
          align: "right",
        }
      );
  }

  return rowHeight;
}

/* ============================================================================
   DRAW EVIDENCE CELL
============================================================================ */

function drawEvidenceCell(
  doc: InstanceType<typeof PDFDocument>,
  lines: EvidenceLine[],
  colX: number,
  rowY: number
): void {
  if (!lines.length) {
    return;
  }

  const innerX =
    colX + ROW_PADDING;

  const innerWidth =
    COL_WIDTHS[
      EVIDENCE_COL_INDEX
    ] -
    ROW_PADDING * 2;

  const diamondWidth = 10;

  let cy =
    rowY + ROW_PADDING;

  for (const line of lines) {
    /*
     * Quarter heading.
     */
    if (
      line.text.startsWith("───")
    ) {
      doc
        .font("Helvetica-Bold")
        .fontSize(6.5)
        .fillColor(
          UI_COLORS.mutedText
        )
        .text(
          line.text,
          innerX,
          cy,
          {
            width: innerWidth,
            align: "center",
          }
        );

      const h =
        doc.heightOfString(
          line.text,
          {
            width: innerWidth,
            align: "center",
          }
        );

      cy += h + 2;

      continue;
    }

    /*
     * Spacer.
     */
    if (line.text === "") {
      cy += 3;
      continue;
    }

    /*
     * Evidence document description.
     */
    if (line.isBullet) {
      const textOptions = {
        width:
          innerWidth -
          diamondWidth,
        align:
          "left" as const,
      };

      doc
        .font("Helvetica")
        .fontSize(FONT_SIZE)
        .fillColor(
          UI_COLORS.gold
        )
        .text(
          "❖",
          innerX,
          cy,
          {
            width:
              diamondWidth,
            lineBreak: false,
          }
        );

      doc
        .font("Helvetica-Bold")
        .fontSize(FONT_SIZE)
        .fillColor(
          UI_COLORS.bodyText
        )
        .text(
          line.text,
          innerX +
            diamondWidth,
          cy,
          textOptions
        );

      const textHeight =
        doc.heightOfString(
          line.text,
          textOptions
        );

      cy +=
        Math.max(
          textHeight,
          LINE_HEIGHT
        ) + 1;

      continue;
    }

    /*
     * Submission notes.
     */
    const textOptions = {
      width: innerWidth,
      align: "left" as const,
    };

    doc
      .font("Helvetica-Oblique")
      .fontSize(FONT_SIZE)
      .fillColor(
        UI_COLORS.mutedText
      )
      .text(
        line.text,
        innerX,
        cy,
        textOptions
      );

    const textHeight =
      doc.heightOfString(
        line.text,
        textOptions
      );

    cy += textHeight + 1;
  }
}

/* ============================================================================
   STATUS PILL
============================================================================ */

function drawStatusPill(
  doc: InstanceType<typeof PDFDocument>,
  status: string,
  colX: number,
  rowY: number
): void {
  const isCompleted =
    status === "Completed";

  const isPartiallyApproved =
    status === "Partially Approved" ||
    status === "Awaiting Super Admin";

  let label: string;
  let bg: string;
  let border: string;
  let text: string;

  if (isCompleted) {
    label = "COMPLETE";
    bg = UI_COLORS.completeBg;
    border =
      UI_COLORS.completeBorder;
    text =
      UI_COLORS.completeText;
  } else if (
    isPartiallyApproved
  ) {
    label = "PARTIAL";
    bg = UI_COLORS.partialBg;
    border =
      UI_COLORS.partialBorder;
    text =
      UI_COLORS.partialText;
  } else {
    label = "NO SUBMISSION";
    bg = UI_COLORS.pendingBg;
    border =
      UI_COLORS.pendingBorder;
    text =
      UI_COLORS.pendingText;
  }

  const colWidth =
    COL_WIDTHS[
      STATUS_COL_INDEX
    ];

  const fontSize = 6.5;

  doc
    .font("Helvetica-Bold")
    .fontSize(fontSize);

  const textWidth =
    doc.widthOfString(label);

  const paddingX = 7;

  const pillHeight = 14;

  const pillWidth = Math.min(
    colWidth - 10,
    textWidth +
      paddingX * 2
  );

  const pillX =
    colX +
    (colWidth -
      pillWidth) /
      2;

  const pillY =
    rowY + ROW_PADDING;

  doc.save();

  doc
    .roundedRect(
      pillX,
      pillY,
      pillWidth,
      pillHeight,
      7
    )
    .fillAndStroke(
      bg,
      border
    );

  doc.restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(fontSize)
    .fillColor(text)
    .text(
      label,
      pillX,
      pillY + 3,
      {
        width: pillWidth,
        align: "center",
      }
    );
}

/* ============================================================================
   PDF HEADER
============================================================================ */

const HEADER_CELLS = [
  "INDICATORS",
  "UNIT OF MEASURE",
  "EXPLANATORY NOTES",
  "RESPONSIBILITY",
  "EVIDENCE",
  "STATUS",
];

function drawTableHeader(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number
): number {
  return drawTableRow(
    doc,
    HEADER_CELLS,
    x,
    y,
    HEADER_HEIGHT,
    {
      bold: true,
      isHeader: true,
      fillColor: "#f8fafc",
    }
  );
}

/* ============================================================================
   PERSPECTIVE HEADER
============================================================================ */

function drawPerspectiveHeader(
  doc: InstanceType<typeof PDFDocument>,
  perspective: string,
  x: number,
  y: number
): number {
  doc.save();

  doc
    .rect(
      x,
      y,
      TABLE_WIDTH,
      PERSPECTIVE_HEIGHT
    )
    .fill(
      UI_COLORS.perspectiveBg
    );

  doc.restore();

  /*
   * Border.
   */
  doc.save();

  doc
    .rect(
      x,
      y,
      TABLE_WIDTH,
      PERSPECTIVE_HEIGHT
    )
    .stroke(
      UI_COLORS.borderLight
    );

  doc.restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(
      UI_COLORS.perspectiveText
    )
    .text(
      perspective,
      x + ROW_PADDING,
      y + 5,
      {
        width:
          TABLE_WIDTH -
          ROW_PADDING * 2,
        characterSpacing: 0.4,
      }
    );

  return PERSPECTIVE_HEIGHT;
}

/* ============================================================================
   PDF LOGO
============================================================================ */

const LOGO_URL =
  process.env.TRACKER_LOGO_URL ||
  "https://res.cloudinary.com/do0yflasl/image/upload/v1784363826/ORHC_L_crclut.jpg";

async function fetchLogoBuffer(
  url: string
): Promise<Buffer | null> {
  try {
    const response =
      await axios.get(url, {
        responseType:
          "arraybuffer",
        timeout: 10000,
      });

    return Buffer.from(
      response.data
    );
  } catch (error) {
    console.error(
      "[getTrackerPdf] Failed to fetch logo:",
      error
    );

    return null;
  }
}

/* ============================================================================
   DRAW FIRST PAGE TITLE
============================================================================ */

function drawReportTitle(
  doc: InstanceType<typeof PDFDocument>,
  logoBuffer: Buffer | null
): void {
  const pageWidth =
    doc.page.width;

  const logoSize = 54;

  /*
   * Logo.
   */
  if (logoBuffer) {
    try {
      doc.image(
        logoBuffer,
        (pageWidth -
          logoSize) /
          2,
        doc.y,
        {
          width: logoSize,
          height: logoSize,
        }
      );

      doc.y +=
        logoSize + 8;
    } catch (error) {
      console.error(
        "[getTrackerPdf] Failed to render logo:",
        error
      );
    }
  }

  /*
   * Main title.
   */
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(
      UI_COLORS.darkGreen
    )
    .text(
      "RHC 2025/2026 PMMU 1ST JULY 2025 TO 30TH JUNE 2026",
      {
        align: "center",
        characterSpacing: 0.3,
      }
    );

  doc.moveDown(0.3);

  /*
   * Subtitle.
   */
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(
      UI_COLORS.gold
    )
    .text(
      "IMPLEMENTATION AND EVALUATION TRACKER",
      {
        align: "center",
        characterSpacing: 1.4,
      }
    );

  doc.moveDown(0.8);
}

/* ============================================================================
   NORMAL CELL HEIGHT
============================================================================ */

function measureNormalRowHeight(
  doc: InstanceType<typeof PDFDocument>,
  cells: string[]
): number {
  let height = 0;

  cells.forEach(
    (cell, index) => {
      if (
        index ===
          EVIDENCE_COL_INDEX ||
        index ===
          STATUS_COL_INDEX
      ) {
        return;
      }

      const cellHeight =
        measureCellHeight(
          doc,
          cell,
          COL_WIDTHS[index],
          false,
          FONT_SIZE
        );

      height = Math.max(
        height,
        cellHeight
      );
    }
  );

  return Math.max(
    height,
    30
  );
}

/* ============================================================================
   DRAW FOOTERS
============================================================================ */

function drawFooters(
  doc: InstanceType<typeof PDFDocument>,
  tableX: number
): void {
  const pageRange =
    doc.bufferedPageRange();

  const totalPages =
    pageRange.count || 1;

  for (
    let index = 0;
    index < totalPages;
    index++
  ) {
    doc.switchToPage(index);

    const footerY =
      doc.page.height -
      doc.page.margins.bottom +
      4;

    /*
     * Footer separator.
     */
    doc
      .save()
      .moveTo(
        tableX,
        footerY - 7
      )
      .lineTo(
        tableX + TABLE_WIDTH,
        footerY - 7
      )
      .stroke(
        UI_COLORS.borderLight
      )
      .restore();

    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(
        UI_COLORS.mutedText
      )
      .text(
        `RHC PMMU Tracker · FY 2025/2026 · Generated ${new Date().toLocaleDateString(
          "en-KE",
          {
            day: "numeric",
            month: "long",
            year: "numeric",
          }
        )}`,
        tableX,
        footerY,
        {
          width:
            TABLE_WIDTH,
          align: "left",
        }
      );

    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor(
        UI_COLORS.mutedText
      )
      .text(
        `Page ${index + 1} of ${totalPages}`,
        tableX,
        footerY,
        {
          width:
            TABLE_WIDTH,
          align: "right",
        }
      );
  }
}

/* ============================================================================
   1. GET FULL TRACKER REPORT
============================================================================ */

export const getTrackerReport =
  asyncHandler(
    async (
      req: Request,
      res: Response
    ) => {
      const {
        where,
        params,
      } = buildWhereClause(
        req.query
      );

      const { rows } =
        await pool.query(
          `
          ${REPORT_SELECT}
          ${REPORT_JOINS}
          ${where}

          ORDER BY
            sp.id ASC,
            so.id ASC,
            sa.id ASC,
            i.id ASC
          `,
          params
        );

      res.status(200).json({
        success: true,
        count: rows.length,
        data: groupByPerspective(
          rows as IndicatorRow[]
        ),
        raw: rows,
      });
    }
  );

/* ============================================================================
   2. GET REPORT BY PLAN ID
============================================================================ */

export const getReportByPlanId =
  asyncHandler(
    async (
      req: Request,
      res: Response
    ) => {
      const { planId } =
        req.params;

      const { rows } =
        await pool.query(
          `
          ${REPORT_SELECT}
          ${REPORT_JOINS}

          WHERE
            sp.id = $1
            AND i.deleted_at IS NULL

          ORDER BY
            sp.id ASC,
            so.id ASC,
            sa.id ASC,
            i.id ASC
          `,
          [planId]
        );

      if (rows.length === 0) {
        throw new AppError(
          "No indicators found for this plan.",
          404
        );
      }

      res.status(200).json({
        success: true,
        count: rows.length,
        data: groupByPerspective(
          rows as IndicatorRow[]
        ),
        raw: rows,
      });
    }
  );

/* ============================================================================
   3. GET REPORT SUMMARY
============================================================================ */

export const getReportSummary =
  asyncHandler(
    async (
      _req: Request,
      res: Response
    ) => {
      const { rows } =
        await pool.query(`
          SELECT
            sp.id,
            sp.perspective,

            COUNT(DISTINCT i.id)::int
              AS "totalIndicators",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE i.status = 'Completed'
              )::int
              AS "completed",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE i.assignee_id IS NULL
              )::int
              AS "unassigned",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE i.status IN (
                  'Awaiting Admin Approval',
                  'Awaiting Super Admin'
                )
              )::int
              AS "awaitingReview",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE
                  i.deadline < NOW()
                  AND i.status NOT IN (
                    'Completed',
                    'Awaiting Admin Approval',
                    'Awaiting Super Admin'
                  )
                  AND i.assignee_id IS NOT NULL
              )::int
              AS "overdue",

            ROUND(
              AVG(i.progress)
            )::int
              AS "avgProgress",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE EXISTS (
                  SELECT 1
                  FROM submissions s
                  WHERE s.indicator_id = i.id
                )
              )::int
              AS "hasSubmissions",

            COUNT(DISTINCT i.id)
              FILTER (
                WHERE EXISTS (
                  SELECT 1
                  FROM submissions s
                  WHERE s.indicator_id = i.id
                    AND s.review_status IN (
                      'Verified',
                      'Accepted',
                      'Partially Approved'
                    )
                )
              )::int
              AS "submittedComplete"

          FROM strategic_plans sp

          JOIN strategic_objectives so
            ON so.plan_id = sp.id

          JOIN strategic_activities sa
            ON sa.objective_id = so.id

          JOIN indicators i
            ON i.activity_id = sa.id

          WHERE i.deleted_at IS NULL

          GROUP BY
            sp.id,
            sp.perspective

          ORDER BY
            sp.id ASC
        `);

      res.status(200).json({
        success: true,
        data: rows,
      });
    }
  );

/* ============================================================================
   4. GET TRACKER PDF
============================================================================ */

export const getTrackerPdf =
  asyncHandler(
    async (
      req: Request,
      res: Response
    ) => {
      /* ----------------------------------------------------------------------
         GET DATA
      ---------------------------------------------------------------------- */

      const {
        where,
        params,
      } = buildWhereClause(
        req.query
      );

      const { rows } =
        await pool.query(
          `
          ${REPORT_SELECT}
          ${REPORT_JOINS}
          ${where}

          ORDER BY
            sp.id ASC,
            so.id ASC,
            sa.id ASC,
            i.id ASC
          `,
          params
        );

      const grouped =
        groupByPerspective(
          rows as IndicatorRow[]
        );

      /* ----------------------------------------------------------------------
         LOGO
      ---------------------------------------------------------------------- */

      const logoBuffer =
        await fetchLogoBuffer(
          LOGO_URL
        );

      /* ----------------------------------------------------------------------
         CREATE A4 LANDSCAPE PDF
      ---------------------------------------------------------------------- */

      const doc =
        new PDFDocument({
          size: "A4",
          layout: "landscape",

          margins: {
            top: 50,
            bottom: 40,
            left: 20,
            right: 20,
          },

          bufferPages: true,

          /*
           * Better PDF compatibility.
           */
          autoFirstPage: true,
        });

      /* ----------------------------------------------------------------------
         RESPONSE HEADERS
      ---------------------------------------------------------------------- */

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="tracker-${new Date()
          .toISOString()
          .slice(0, 10)}.pdf"`
      );

      doc.pipe(res);

      /* ----------------------------------------------------------------------
         PAGE VARIABLES
      ---------------------------------------------------------------------- */

      const TABLE_X =
        doc.page.margins.left;

      let cursorY =
        doc.page.margins.top;

      /* ----------------------------------------------------------------------
         FIRST PAGE TITLE
      ---------------------------------------------------------------------- */

      drawReportTitle(
        doc,
        logoBuffer
      );

      cursorY = doc.y;

      /*
       * Table header.
       */
      cursorY +=
        drawTableHeader(
          doc,
          TABLE_X,
          cursorY
        );

      /* ----------------------------------------------------------------------
         PDF RENDERING
      ---------------------------------------------------------------------- */

      let rowIndex = 0;

      for (const perspective of grouped) {
        /*
         * Before drawing perspective header,
         * make sure we have enough room for it
         * and at least one table row.
         */
        if (
          cursorY +
            PERSPECTIVE_HEIGHT +
            30 >
          getPageBottom(doc)
        ) {
          doc.addPage();

          cursorY =
            doc.page.margins.top;

          cursorY +=
            drawTableHeader(
              doc,
              TABLE_X,
              cursorY
            );
        }

        /*
         * Perspective heading.
         */
        cursorY +=
          drawPerspectiveHeader(
            doc,
            perspective.perspective,
            TABLE_X,
            cursorY
          );

        /*
         * Objectives.
         */
        for (const objective of
          perspective.objectives) {
          /*
           * Activities.
           */
          for (const activity of
            objective.activities) {
            /*
             * We only print the objective/activity
             * information on the first indicator
             * belonging to the activity.
             */
            let firstActivityIndicator =
              true;

            /*
             * Indicators.
             */
            for (const indicator of
              activity.indicators) {
              const submissions =
                indicator.submissions ||
                [];

              /*
               * ALL evidence.
               */
              let remainingEvidence =
                getEvidenceLines(
                  submissions
                );

              /*
               * Build normal table cells.
               */
              let indicatorCell =
                "";

              if (
                firstActivityIndicator
              ) {
                indicatorCell =
                  objective.title?.trim() ||
                  activity.description ||
                  "";

                firstActivityIndicator =
                  false;
              }

              /*
               * Notes column - REMOVED all admin/review metadata
               */
              let notesText =
                activity.description ||
                "";

              /*
               * Add submission period information
               * to explanatory notes - WITHOUT review status
               */
              if (
                submissions.length > 0
              ) {
                const sortedSubs =
                  [
                    ...submissions,
                  ].sort(
                    (a, b) => {
                      if (
                        a.year !==
                        b.year
                      ) {
                        return (
                          a.year -
                          b.year
                        );
                      }

                      return (
                        a.quarter -
                        b.quarter
                      );
                    }
                  );

                for (const sub of
                  sortedSubs) {
                  const periodLabel =
                    sub.quarter === 0
                      ? "Annual"
                      : `Q${sub.quarter}`;

                  // ✅ REMOVED: Review status from notes
                  notesText +=
                    `\n[${periodLabel} ${sub.year}]`;

                  // ✅ REMOVED: Admin comments
                  // ✅ REMOVED: Resubmission count
                }
              } else {
                notesText +=
                  "\n[No Submissions]";
              }

              if (
                indicator.instructions
              ) {
                notesText +=
                  `\n${indicator.instructions}`;
              }

              /*
               * Has submission?
               */
              const hasSubmission =
                submissions.length >
                0;

              /*
               * The normal cells for the
               * first physical row.
               */
              const firstCells = [
                indicatorCell,

                indicator.unit || "%",

                notesText,

                indicator.assigneeDisplayName ||
                  "Unassigned",

                "",

                hasSubmission
                  ? ""
                  : "NO SUBMISSION",
              ];

              /*
               * Measure normal columns.
               */
              let normalRowHeight =
                measureNormalRowHeight(
                  doc,
                  firstCells
                );

              /*
               * Ensure there is enough room
               * for the first row.
               */
              if (
                cursorY +
                  normalRowHeight >
                getPageBottom(doc)
              ) {
                doc.addPage();

                cursorY =
                  doc.page.margins.top;

                cursorY +=
                  drawTableHeader(
                    doc,
                    TABLE_X,
                    cursorY
                  );

                /*
                 * Small continuation label
                 * for the perspective.
                 */
                cursorY +=
                  drawPerspectiveHeader(
                    doc,
                    `${perspective.perspective} — CONTINUED`,
                    TABLE_X,
                    cursorY
                  );
              }

              /*
               * If there is NO evidence,
               * render a normal one-row indicator.
               */
              if (
                remainingEvidence.length ===
                0
              ) {
                const cells = [
                  firstCells[0],
                  firstCells[1],
                  firstCells[2],
                  firstCells[3],
                  "",
                  firstCells[5],
                ];

                const rowHeight =
                  Math.max(
                    normalRowHeight,
                    30
                  );

                const fillColor =
                  rowIndex % 2 === 0
                    ? UI_COLORS.rowAlt
                    : UI_COLORS.white;

                drawTableRow(
                  doc,
                  cells,
                  TABLE_X,
                  cursorY,
                  rowHeight,
                  {
                    fillColor,
                    skipTextColumns: [
                      EVIDENCE_COL_INDEX,
                      STATUS_COL_INDEX,
                    ],
                  }
                );

                const statusX =
                  TABLE_X +
                  COL_WIDTHS
                    .slice(
                      0,
                      STATUS_COL_INDEX
                    )
                    .reduce(
                      (sum, width) =>
                        sum + width,
                      0
                    );

                drawStatusPill(
                  doc,
                  hasSubmission
                    ? indicator.status
                    : "NO SUBMISSION",
                  statusX,
                  cursorY
                );

                cursorY +=
                  rowHeight;

                rowIndex++;

                continue;
              }

              /*
               * ==============================================================
               * EVIDENCE ROWS
               *
               * This is the important part.
               *
               * Instead of putting all evidence into
               * one enormous row, we split it into
               * multiple physical table rows/pages.
               *
               * NOTHING IS DROPPED.
               * ==============================================================
               */

              let isFirstEvidenceRow =
                true;

              while (
                remainingEvidence.length >
                0
              ) {
                /*
                 * Available vertical space
                 * on the current page.
                 */
                let availablePageHeight =
                  getPageBottom(doc) -
                  cursorY;

                /*
                 * Keep at least 25px available
                 * for a useful row.
                 */
                if (
                  availablePageHeight <
                  30
                ) {
                  doc.addPage();

                  cursorY =
                    doc.page.margins.top;

                  cursorY +=
                    drawTableHeader(
                      doc,
                      TABLE_X,
                      cursorY
                    );

                  cursorY +=
                    drawPerspectiveHeader(
                      doc,
                      `${perspective.perspective} — CONTINUED`,
                      TABLE_X,
                      cursorY
                    );

                  availablePageHeight =
                    getPageBottom(doc) -
                    cursorY;
                }

                /*
                 * Evidence content gets the
                 * available page height minus
                 * table padding.
                 */
                const maxEvidenceHeight =
                  Math.max(
                    20,
                    availablePageHeight -
                      ROW_PADDING * 2
                  );

                /*
                 * Take as many evidence lines
                 * as physically fit.
                 */
                const evidenceChunk =
                  takeEvidenceChunk(
                    doc,
                    remainingEvidence,
                    COL_WIDTHS[
                      EVIDENCE_COL_INDEX
                    ],
                    maxEvidenceHeight
                  );

                /*
                 * It is possible that the next
                 * evidence line is too large to
                 * fit because the remaining page
                 * space is tiny.
                 */
                if (
                  evidenceChunk.chunk
                    .length === 0
                ) {
                  doc.addPage();

                  cursorY =
                    doc.page.margins.top;

                  cursorY +=
                    drawTableHeader(
                      doc,
                      TABLE_X,
                      cursorY
                    );

                  cursorY +=
                    drawPerspectiveHeader(
                      doc,
                      `${perspective.perspective} — CONTINUED`,
                      TABLE_X,
                      cursorY
                    );

                  continue;
                }

                /*
                 * Measure evidence chunk.
                 */
                const evidenceHeight =
                  measureEvidenceHeight(
                    doc,
                    evidenceChunk.chunk,
                    COL_WIDTHS[
                      EVIDENCE_COL_INDEX
                    ]
                  ) +
                  ROW_PADDING * 2;

                /*
                 * First row contains all
                 * metadata.
                 *
                 * Continuation rows only contain
                 * evidence.
                 */
                const cells =
                  isFirstEvidenceRow
                    ? [
                        firstCells[0],
                        firstCells[1],
                        firstCells[2],
                        firstCells[3],
                        "",
                        "",
                      ]
                    : [
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                      ];

                /*
                 * On first row, normal content
                 * determines a minimum height.
                 *
                 * On continuation rows,
                 * evidence determines it.
                 */
                const rowHeight =
                  isFirstEvidenceRow
                    ? Math.max(
                        normalRowHeight,
                        evidenceHeight,
                        30
                      )
                    : Math.max(
                        evidenceHeight,
                        24
                      );

                /*
                 * If the row somehow doesn't fit,
                 * move it to the next page.
                 */
                if (
                  cursorY +
                    rowHeight >
                  getPageBottom(doc)
                ) {
                  doc.addPage();

                  cursorY =
                    doc.page.margins.top;

                  cursorY +=
                    drawTableHeader(
                      doc,
                      TABLE_X,
                      cursorY
                    );

                  cursorY +=
                    drawPerspectiveHeader(
                      doc,
                      `${perspective.perspective} — CONTINUED`,
                      TABLE_X,
                      cursorY
                    );

                  continue;
                }

                /*
                 * Alternating background.
                 *
                 * Continuation rows retain the
                 * same indicator shading.
                 */
                const fillColor =
                  rowIndex % 2 === 0
                    ? UI_COLORS.rowAlt
                    : UI_COLORS.white;

                drawTableRow(
                  doc,
                  cells,
                  TABLE_X,
                  cursorY,
                  rowHeight,
                  {
                    fillColor,

                    skipTextColumns: [
                      EVIDENCE_COL_INDEX,
                      STATUS_COL_INDEX,
                    ],

                    continuation:
                      !isFirstEvidenceRow,
                  }
                );

                /*
                 * Evidence X position.
                 */
                const evidenceX =
                  TABLE_X +
                  COL_WIDTHS
                    .slice(
                      0,
                      EVIDENCE_COL_INDEX
                    )
                    .reduce(
                      (sum, width) =>
                        sum + width,
                      0
                    );

                /*
                 * Draw this evidence chunk.
                 */
                drawEvidenceCell(
                  doc,
                  evidenceChunk.chunk,
                  evidenceX,
                  cursorY
                );

                /*
                 * Status only belongs on
                 * the first physical row.
                 */
                if (
                  isFirstEvidenceRow
                ) {
                  const statusX =
                    TABLE_X +
                    COL_WIDTHS
                      .slice(
                        0,
                        STATUS_COL_INDEX
                      )
                      .reduce(
                        (
                          sum,
                          width
                        ) =>
                          sum + width,
                        0
                      );

                  drawStatusPill(
                    doc,
                    hasSubmission
                      ? indicator.status
                      : "NO SUBMISSION",
                    statusX,
                    cursorY
                  );
                }

                /*
                 * Advance vertically.
                 */
                cursorY +=
                  rowHeight;

                /*
                 * Remove rendered evidence.
                 */
                remainingEvidence =
                  evidenceChunk.remaining;

                isFirstEvidenceRow =
                  false;
              }

              /*
               * The complete indicator has
               * now been rendered.
               */
              rowIndex++;
            }
          }
        }
      }

      /* ----------------------------------------------------------------------
         FOOTERS / PAGE NUMBERS
      ---------------------------------------------------------------------- */

      drawFooters(
        doc,
        TABLE_X
      );

      /* ----------------------------------------------------------------------
         FINISH PDF
      ---------------------------------------------------------------------- */

      doc.end();
    }
  );