import { Request, Response } from "express";
import PDFDocument from "pdfkit";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { perspectiveRankSql } from "../../utils/pmmuOrder";

/* ─── Schedule 1 scorecard ──────────────────────────────────────────────────
 * One row per strategic objective, exactly as Schedule 1 of the signed PMMU:
 *   weight, unit, baseline, target (stored on strategic_objectives)
 *   actual + remarks (objective_grades) → score = weight × min(actual ÷ target, 1)
 * Only the super admin fills in "Actual"; everything else is fixed as printed.
 * ────────────────────────────────────────────────────────────────────────── */

const LETTERS = ["A", "B", "C", "D", "E"];
const PERSPECTIVE_TITLES = [
  "CORE BUSINESS/MANDATE PERSPECTIVE",
  "CUSTOMER PERSPECTIVE",
  "FINANCE PERSPECTIVE",
  "INNOVATION AND LEARNING PERSPECTIVE",
  "INTERNAL PROCESS",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export const scoreFor = (weight: number | null, target: number | null, actual: number | null) => {
  if (weight === null || actual === null || !target) return null;
  return round2(weight * Math.min(actual / target, 1));
};

interface ScheduleRow {
  objectiveId: string;
  rank: number;
  letter: string;
  number: number | null;
  code: string;
  name: string;
  unit: string;
  weight: number | null;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  score: number | null;
  remarks: string | null;
  gradedByName: string | null;
  gradedByRole: string | null;
  gradedAt: string | null;
  examinerId: string | null;
  examinerName: string | null;
  canGrade: boolean;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Loads the full Schedule 1 with grades; canGrade is computed for the requesting user. */
async function loadSchedule(user: { id: string; role: string }) {
  const { rows } = await pool.query(
    `SELECT so.id              AS "objectiveId",
            ${perspectiveRankSql("sp.perspective")} AS rank,
            so.sort_order      AS number,
            COALESCE(so.schedule_name, so.title) AS name,
            COALESCE(so.unit_of_measure, '%')   AS unit,
            so.weight, so.baseline, so.target,
            g.actual, g.remarks, g.graded_by_role AS "gradedByRole", g.updated_at AS "gradedAt",
            gu.name            AS "gradedByName",
            efa.examiner_id    AS "examinerId",
            eu.name            AS "examinerName"
     FROM strategic_objectives so
     JOIN strategic_plans sp                   ON sp.id = so.plan_id
     LEFT JOIN objective_grades g              ON g.objective_id = so.id
     LEFT JOIN users gu                        ON gu.id = g.graded_by
     LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
     LEFT JOIN users eu                        ON eu.id = efa.examiner_id
     ORDER BY rank, so.sort_order NULLS LAST, so.title`
  );

  const gradesAll = user.role === "superadmin";
  const schedule: ScheduleRow[] = rows.map((r) => {
    const letter = LETTERS[(r.rank ?? 9) - 1] ?? "?";
    const weight = num(r.weight), target = num(r.target), actual = num(r.actual);
    return {
      objectiveId: r.objectiveId,
      rank: r.rank,
      letter,
      number: r.number,
      code: r.number ? `${letter}.${r.number}` : letter,
      name: r.name,
      unit: r.unit,
      weight,
      baseline: num(r.baseline),
      target,
      actual,
      score: scoreFor(weight, target, actual),
      remarks: r.remarks,
      gradedByName: r.gradedByName,
      gradedByRole: r.gradedByRole,
      gradedAt: r.gradedAt,
      examinerId: r.examinerId,
      examinerName: r.examinerName,
      canGrade: gradesAll,
    };
  });

  // Sections A–E with subtotals computed from the rows themselves
  const sections = LETTERS.map((letter, i) => {
    const sectionRows = schedule.filter((r) => r.letter === letter);
    return {
      letter,
      title: PERSPECTIVE_TITLES[i],
      rows: sectionRows,
      weight: round2(sectionRows.reduce((s, r) => s + (r.weight ?? 0), 0)),
      score: round2(sectionRows.reduce((s, r) => s + (r.score ?? 0), 0)),
      graded: sectionRows.filter((r) => r.actual !== null).length,
    };
  }).filter((s) => s.rows.length > 0);

  const totals = {
    weight: round2(sections.reduce((s, x) => s + x.weight, 0)),
    score: round2(sections.reduce((s, x) => s + x.score, 0)),
    graded: schedule.filter((r) => r.actual !== null).length,
    rows: schedule.length,
  };

  return { sections, totals };
}

/* GET /grading/schedule */
export const getSchedule = asyncHandler(async (req: Request, res: Response) => {
  const data = await loadSchedule((req as any).user);
  res.status(200).json({ success: true, data });
});

/* PUT /grading/objectives/:objectiveId   body: { actual, remarks } */
export const gradeObjective = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user as { id: string; role: string };
  const objectiveId = String(req.params.objectiveId);
  const actual = Number(req.body?.actual);
  const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 2000) : null;

  if (!Number.isFinite(actual) || actual < 0 || actual > 100000) {
    throw new AppError("Enter a valid Actual value (0 or more).", 400);
  }

  const { rows: objRows } = await pool.query(
    `SELECT so.id, so.weight, so.target, efa.examiner_id
     FROM strategic_objectives so
     LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
     WHERE so.id = $1`,
    [objectiveId]
  );
  if (objRows.length === 0) throw new AppError("Objective not found.", 404);

  if (user.role !== "superadmin") {
    throw new AppError("Only the super admin can fill in Schedule 1.", 403);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO objective_grades (objective_id, actual, remarks, graded_by, graded_by_role, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (objective_id) DO UPDATE SET
         actual = EXCLUDED.actual, remarks = EXCLUDED.remarks,
         graded_by = EXCLUDED.graded_by, graded_by_role = EXCLUDED.graded_by_role, updated_at = NOW()`,
      [objectiveId, actual, remarks || null, user.id, user.role]
    );
    await client.query(
      `INSERT INTO objective_grade_history (objective_id, actual, remarks, graded_by, graded_by_role)
       VALUES ($1, $2, $3, $4, $5)`,
      [objectiveId, actual, remarks || null, user.id, user.role]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const score = scoreFor(num(objRows[0].weight), num(objRows[0].target), actual);
  res.status(200).json({ success: true, message: "Grade saved.", data: { objectiveId, actual, remarks, score } });
});

/* GET /grading/objectives/:objectiveId/history */
export const getGradeHistory = asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT h.actual, h.remarks, h.graded_by_role AS "gradedByRole", h.graded_at AS "gradedAt", u.name AS "gradedByName"
     FROM objective_grade_history h LEFT JOIN users u ON u.id = h.graded_by
     WHERE h.objective_id = $1 ORDER BY h.graded_at DESC LIMIT 50`,
    [String(req.params.objectiveId)]
  );
  res.status(200).json({ success: true, data: rows });
});

/* PATCH /grading/objectives/:objectiveId/weights   (super admin)  body: { weight?, baseline?, target?, unit? } */
export const updateScheduleValues = asyncHandler(async (req: Request, res: Response) => {
  const objectiveId = String(req.params.objectiveId);
  const pick = (k: string) => (req.body?.[k] === undefined || req.body[k] === "" ? null : Number(req.body[k]));
  const weight = pick("weight"), baseline = pick("baseline"), target = pick("target");
  for (const [k, v] of [["weight", weight], ["baseline", baseline], ["target", target]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new AppError(`Invalid ${k}.`, 400);
  }
  if (target === 0) throw new AppError("Target must be greater than 0.", 400);
  const unit = typeof req.body?.unit === "string" && req.body.unit.trim() ? req.body.unit.trim().slice(0, 10) : null;

  const { rowCount } = await pool.query(
    `UPDATE strategic_objectives SET
       weight = COALESCE($2, weight), baseline = COALESCE($3, baseline),
       target = COALESCE($4, target), unit_of_measure = COALESCE($5, unit_of_measure)
     WHERE id = $1`,
    [objectiveId, weight, baseline, target, unit]
  );
  if (!rowCount) throw new AppError("Objective not found.", 404);
  res.status(200).json({ success: true, message: "Schedule values updated." });
});

/* ─── PDF: Schedule 1 exactly as in the signed PMMU, with Actual filled in ─── */

/** Subtotals and Grand Total exactly as printed in the signed Schedule 1. */
export const PRINTED_SUBTOTALS: Record<string, { label: string; value: number }> = {
  A: { label: "", value: 70 },
  B: { label: "SUBTOTAL", value: 10 },
  C: { label: "SUBTOTAL", value: 5 },
  D: { label: "SUBTOTAL", value: 6 },
  E: { label: "SUBTOTAL", value: 9 },
};
export const PRINTED_GRAND_TOTAL = 100;

const fmt = (v: number | null) =>
  v === null ? "" : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);

/* GET /grading/report.pdf */
export const downloadScheduleReport = asyncHandler(async (req: Request, res: Response) => {
  const { sections } = await loadSchedule((req as any).user);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="ORHC-PMMU-Schedule-1.pdf"');
  doc.pipe(res);

  const HEAD_BG = "#dbe5f1", SECTION_BG = "#0b9be0", TOTAL_BG = "#dbe5f1", LINE = "#4a4a4a", TEXT = "#111111";
  // INDICATORS | Unit of Measure | Weight | Baseline 2024/2025 (Actual | %) | Target 2025/2026
  const cols = [
    { key: "indicator", w: 255, align: "left"   as const },
    { key: "unit",      w: 50,  align: "center" as const },
    { key: "weight",    w: 45,  align: "center" as const },
    { key: "actual",    w: 62,  align: "center" as const },
    { key: "pct",       w: 50,  align: "center" as const },
    { key: "target",    w: 53,  align: "center" as const },
  ];
  const left = doc.page.margins.left;
  const tableW = cols.reduce((sum, c) => sum + c.w, 0);
  const xOf = (i: number) => left + cols.slice(0, i).reduce((sum, c) => sum + c.w, 0);
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;

  const cell = (i: number, y: number, h: number, text: string, o: { bold?: boolean; color?: string; align?: "left" | "center"; span?: number } = {}) => {
    const span = o.span ?? 1;
    const w = cols.slice(i, i + span).reduce((sum, c) => sum + c.w, 0);
    doc.rect(xOf(i), y, w, h).lineWidth(0.6).strokeColor(LINE).stroke();
    if (!text) return;
    doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(o.color ?? TEXT);
    const th = doc.heightOfString(text, { width: w - 8 });
    doc.text(text, xOf(i) + 4, y + Math.max(3, (h - th) / 2), { width: w - 8, align: o.align ?? cols[i].align });
  };

  const header = () => {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(TEXT)
      .text("Schedule 1: Performance Targets Matrix, Registrar, High Court", left, doc.page.margins.top);
    doc.moveDown(0.5);
    const y = doc.y, h1 = 34, h2 = 16;
    doc.rect(left, y, tableW, h1 + h2).fill(HEAD_BG);
    cell(0, y, h1 + h2, "INDICATORS", { bold: true, align: "left" });
    cell(1, y, h1 + h2, "Unit of Measure", { bold: true });
    cell(2, y, h1 + h2, "Weight", { bold: true });
    cell(3, y, h1 + h2, "Baseline 2024/2025", { bold: true, span: 2 });
    cell(5, y, h1 + h2, "Target 2025/2026", { bold: true });
    doc.y = y + h1 + h2;
  };

  const row = (cells: string[], o: { fill?: string; bold?: boolean; color?: string; minH?: number } = {}) => {
    doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    const h = Math.max(o.minH ?? 15, ...cells.map((t, i) => (t ? doc.heightOfString(t, { width: cols[i].w - 8 }) + 6 : 0)));
    if (doc.y + h > bottom()) { doc.addPage(); header(); }
    const y = doc.y;
    if (o.fill) doc.rect(left, y, tableW, h).fill(o.fill);
    cells.forEach((t, i) => cell(i, y, h, t, { bold: o.bold, color: o.color }));
    doc.y = y + h;
  };

  header();
  for (const sec of sections) {
    // Section heading row carries the "Actual" / "%" sub-headings, as printed
    row([`${sec.letter}. ${sec.title}`, "", "", "Actual", "%", ""], { fill: SECTION_BG, bold: true, color: "white" });
    for (const r of sec.rows) {
      row([
        `${r.number}. ${r.name}`,
        r.unit,
        fmt(r.weight),
        fmt(r.actual),     // ← the only field filled in through the system
        fmt(r.baseline),
        fmt(r.target),
      ]);
    }
    const sub = PRINTED_SUBTOTALS[sec.letter];
    if (sub) row([sub.label, "", String(sub.value), "", "", ""], { fill: TOTAL_BG, bold: true });
  }
  row(["GRAND TOTAL", "", String(PRINTED_GRAND_TOTAL), "", "", ""], { fill: TOTAL_BG, bold: true });

  doc.moveDown(0.8).font("Helvetica").fontSize(7).fillColor("#555555")
    .text(`OFFICE OF THE REGISTRAR, HIGH COURT, 2025/2026 PMMU  ·  Actual figures as recorded in the PMMU system on ${new Date().toLocaleString("en-GB")}`, left);
  doc.end();
});
