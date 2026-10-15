import { Request, Response } from "express";
import archiver from "archiver";
import axios from "axios";
import PDFDocument from "pdfkit";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { objectiveOrderSql, activityOrderSql } from "../../utils/pmmuOrder";

/* ─── SHARED SELECT ───────────────────────────────────────────────────────── */

const INDICATOR_SELECT = `
  SELECT
    i.id,
    i.status,
    i.weight,
    i.unit,
    i.target,
    i.progress,
    i.deadline,
    i.instructions,
    i.assignee_id            AS "assigneeId",
    i.assignee_model         AS "assignmentType",
    i.strategic_plan_id      AS "strategicPlanId",
    i.objective_id           AS "objectiveId",
    i.activity_id            AS "activityId",
    i.reporting_cycle        AS "reportingCycle",
    i.active_quarter         AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.created_at             AS "createdAt",
    i.updated_at             AS "updatedAt",
    sp.perspective,
    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE t.name
    END                      AS "assigneeDisplayName",
    sa.description           AS "activityDescription",
    so.title                 AS "objectiveTitle"
  FROM indicators i
  LEFT JOIN users u                ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t                ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN strategic_plans sp     ON i.strategic_plan_id = sp.id
  LEFT JOIN strategic_objectives so ON i.objective_id = so.id
  LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
  WHERE i.deleted_at IS NULL
`;

/* ─── HELPERS ───────────────────────────────────────────────────────────── */

interface FolderRow {
  objectiveId:    string;
  objectiveTitle: string;
  perspective:    string;
  assignedAt:     string | null;
}

/** Superadmin and supervisors see every folder; examiners only their own. */
const seesAllFolders = (role: string) => role === "superadmin" || role === "supervisor";

/**
 * Loads the indicators (with submissions + live documents) for the given folders.
 * Examiners only see completed indicators; supervisors/superadmin see all of them.
 */
const loadFolderContents = async (folders: FolderRow[], completedOnly: boolean) => {
  if (folders.length === 0) return [];

  const objectiveIds = folders.map((f) => f.objectiveId);

  const { rows: indicators } = await pool.query(
    `${INDICATOR_SELECT}
     AND i.objective_id = ANY($1::uuid[])
     ${completedOnly ? "AND i.status = 'Completed'" : ""}
     ORDER BY ${activityOrderSql("sa")}, i.created_at`,
    [objectiveIds]
  );

  const indicatorIds = indicators.map((i: { id: string }) => i.id);
  const { rows: submissions } = indicatorIds.length
    ? await pool.query(
        `SELECT
           s.indicator_id   AS "indicatorId",
           s.id             AS "submissionId",
           s.quarter,
           s.year,
           s.achieved_value AS "achievedValue",
           s.notes,
           s.review_status  AS "reviewStatus",
           s.submitted_at   AS "submittedAt",
           COALESCE(
             (
               SELECT json_agg(
                 json_build_object(
                   'id',               sd.id,
                   'submissionId',     sd.submission_id,
                   'evidenceUrl',      sd.evidence_url,
                   'evidencePublicId', sd.evidence_public_id,
                   'fileType',         sd.file_type,
                   'fileName',         sd.file_name,
                   'description',      sd.description,
                   'status',           sd.status,
                   'rejectionReason',  sd.rejection_reason,
                   'uploadedAt',       sd.uploaded_at
                 ) ORDER BY sd.uploaded_at ASC
               )
               FROM submission_documents sd
               WHERE sd.submission_id = s.id
                 AND sd.deleted_at IS NULL
                 AND sd.status != 'Deleted'
             ),
             '[]'::json
           ) AS documents
         FROM submissions s
         WHERE s.indicator_id = ANY($1::uuid[])
         ORDER BY s.year ASC, s.quarter ASC`,
        [indicatorIds]
      )
    : { rows: [] };

  const subsByIndicator: Record<string, any[]> = {};
  for (const sub of submissions) {
    (subsByIndicator[sub.indicatorId] ??= []).push(sub);
  }

  const indicatorsByObjective: Record<string, any[]> = {};
  for (const ind of indicators) {
    (indicatorsByObjective[ind.objectiveId] ??= []).push({
      ...ind,
      submissions: subsByIndicator[ind.id] ?? [],
    });
  }

  return folders.map((folder) => ({
    ...folder,
    // Name kept for the existing frontend; holds all indicators for supervisors
    completedIndicators: indicatorsByObjective[folder.objectiveId] ?? [],
  }));
};

/* ─── 1. GET ALL ASSIGNMENTS (superadmin + supervisor) ───────────────────── */
/**
 * Returns every strategic objective with:
 *   - its assigned examiner (if any)
 *   - count of completed indicators inside it
 * Used to power the ExaminerManagement page.
 */
export const getAllExaminerAssignments = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        so.id                         AS "objectiveId",
        so.title                      AS "objectiveTitle",
        sp.perspective,
        sp.id                         AS "planId",

        -- assigned examiner (NULL if none)
        efa.id                        AS "assignmentId",
        efa.assigned_at               AS "assignedAt",
        e.id                          AS "examinerId",
        e.name                        AS "examinerName",
        e.email                       AS "examinerEmail",

        -- progress counters
        COUNT(DISTINCT sa.id)::int                                    AS "totalActivities",
        COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'Completed')::int AS "completedCount"

      FROM strategic_objectives so
      JOIN  strategic_plans           sp  ON sp.id  = so.plan_id
      LEFT JOIN strategic_activities  sa  ON sa.objective_id = so.id
      LEFT JOIN indicators            i   ON i.activity_id   = sa.id AND i.deleted_at IS NULL
      LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
      LEFT JOIN users                 e   ON e.id = efa.examiner_id

      GROUP BY so.id, so.title, sp.perspective, sp.id,
               efa.id, efa.assigned_at, e.id, e.name, e.email
      ORDER BY ${objectiveOrderSql("sp", "so")}
    `);

    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 2. ASSIGN / REASSIGN EXAMINER TO FOLDER ───────────────────────────── */
/**
 * Upserts: if objective already has an examiner, replaces them.
 * Body: { objectiveId, examinerId }
 */
export const assignExaminerToFolder = asyncHandler(
  async (req: Request, res: Response) => {
    const { objectiveId, examinerId } = req.body;
    const adminId = (req as any).user.id;

    if (!objectiveId || !examinerId) {
      throw new AppError("objectiveId and examinerId are required.", 400);
    }

    /* Verify objective exists */
    const objCheck = await pool.query(
      "SELECT id FROM strategic_objectives WHERE id = $1",
      [objectiveId]
    );
    if (objCheck.rows.length === 0) {
      throw new AppError("Objective not found.", 404);
    }

    /* Verify target user is an examiner */
    const userCheck = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1 AND role = 'examiner'",
      [examinerId]
    );
    if (userCheck.rows.length === 0) {
      throw new AppError("User not found or is not an examiner.", 400);
    }

    /* Upsert — ON CONFLICT replaces the existing examiner */
    const { rows } = await pool.query(
      `INSERT INTO examiner_folder_assignments
         (objective_id, examiner_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (objective_id)
       DO UPDATE SET
         examiner_id = EXCLUDED.examiner_id,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = NOW()
       RETURNING *`,
      [objectiveId, examinerId, adminId]
    );

    res.status(200).json({
      success: true,
      message: `Folder assigned to ${userCheck.rows[0].name}.`,
      data: rows[0],
    });
  }
);

/* ─── 3. UNASSIGN EXAMINER FROM FOLDER ──────────────────────────────────── */

export const unassignExaminerFromFolder = asyncHandler(
  async (req: Request, res: Response) => {
    const { objectiveId } = req.params;

    const { rowCount } = await pool.query(
      "DELETE FROM examiner_folder_assignments WHERE objective_id = $1",
      [objectiveId]
    );

    if (rowCount === 0) {
      throw new AppError("No assignment found for this folder.", 404);
    }

    res.status(200).json({ success: true, message: "Examiner unassigned." });
  }
);

/* ─── 4. MY FOLDERS (examiner / supervisor / superadmin) ─────────────────── */
/**
 * Examiners: only the folders assigned to them, completed indicators only.
 * Supervisors & superadmin: every folder, all indicators (read-only view).
 * Includes submissions and their documents with full document details.
 */
export const getMyExaminerFolders = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId, role } = (req as any).user;
    const allFolders = seesAllFolders(role);

    const { rows: folders } = await pool.query<FolderRow>(
      allFolders
        ? `SELECT
             so.id           AS "objectiveId",
             so.title        AS "objectiveTitle",
             sp.perspective,
             efa.assigned_at AS "assignedAt"
           FROM strategic_objectives so
           JOIN strategic_plans sp ON sp.id = so.plan_id
           LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
           ORDER BY ${objectiveOrderSql("sp", "so")}`
        : `SELECT
             so.id           AS "objectiveId",
             so.title        AS "objectiveTitle",
             sp.perspective,
             efa.assigned_at AS "assignedAt"
           FROM examiner_folder_assignments efa
           JOIN strategic_objectives so ON so.id = efa.objective_id
           JOIN strategic_plans      sp ON sp.id = so.plan_id
           WHERE efa.examiner_id = $1
           ORDER BY ${objectiveOrderSql("sp", "so")}`,
      allFolders ? [] : [userId]
    );

    const data = await loadFolderContents(folders, !allFolders);
    res.status(200).json({ success: true, data });
  }
);

/* ─── 5. GET ALL EXAMINERS (for the assignment dropdown) ─────────────────── */

export const getExaminers = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'examiner' ORDER BY name`
    );
    res.status(200).json({ success: true, data: rows });
  }
);

/* ─── 6. DOWNLOAD FOLDER (ZIP of evidence + summary PDF) ─────────────────── */

/** Strips characters that are invalid in file/folder names on Windows/macOS. */
const safeName = (name: string, max = 80) =>
  (name || "untitled")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim() || "untitled";

const periodLabel = (quarter: number, year: number) =>
  quarter === 0 ? `Annual ${year}` : `Q${quarter} ${year}`;

/** Renders a one-file summary of the folder: indicators, submissions, documents. */
const buildSummaryPdf = (folder: any): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#1d3331").font("Helvetica-Bold").fontSize(15).text(folder.objectiveTitle);
    doc.moveDown(0.2).font("Helvetica").fontSize(9).fillColor("#64748b")
      .text(`${folder.perspective}  ·  Generated ${new Date().toLocaleString("en-GB")}`);
    doc.moveDown(0.8);

    const indicators: any[] = folder.completedIndicators;
    if (indicators.length === 0) {
      doc.fillColor("#334155").fontSize(10).text("No indicators in this folder.");
    }

    indicators.forEach((ind, idx) => {
      doc.fillColor("#1d3331").font("Helvetica-Bold").fontSize(11)
        .text(`${idx + 1}. ${ind.activityDescription ?? "Indicator"}`);
      doc.font("Helvetica").fontSize(9).fillColor("#334155")
        .text(
          `Status: ${ind.status}   ·   Assignee: ${ind.assigneeDisplayName ?? "—"}   ·   ` +
          `Progress: ${ind.progress ?? 0}%   ·   Target: ${ind.target ?? "—"} ${ind.unit ?? ""}`
        );

      const subs: any[] = ind.submissions ?? [];
      if (subs.length === 0) {
        doc.fillColor("#94a3b8").text("No submissions.");
      }
      for (const sub of subs) {
        doc.moveDown(0.2).fillColor("#1d3331").font("Helvetica-Bold")
          .text(
            `${periodLabel(sub.quarter, sub.year)}  —  achieved ${sub.achievedValue ?? "—"}  ·  ${sub.reviewStatus}`,
            { indent: 12 }
          );
        doc.font("Helvetica").fillColor("#334155");
        if (sub.notes) doc.text(`Notes: ${sub.notes}`, { indent: 12 });
        const docs: any[] = sub.documents ?? [];
        if (docs.length === 0) doc.fillColor("#94a3b8").text("No documents.", { indent: 24 });
        for (const d of docs) {
          doc.fillColor("#334155")
            .text(`• ${d.fileName}${d.description ? ` — ${d.description}` : ""}`, { indent: 24 });
        }
      }
      doc.moveDown(0.8);
    });

    doc.end();
  });

/**
 * GET /examiner/folders/:objectiveId/download
 * Superadmin & supervisors: any folder. Examiners: only folders assigned to them.
 * Streams a ZIP:  <folder>/00 Folder Summary.pdf
 *                 <folder>/<NN activity>/<period>/<file>
 */
export const downloadFolder = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId, role } = (req as any).user;
    const objectiveId = String(req.params.objectiveId);
    const allFolders = seesAllFolders(role);

    const { rows: folders } = await pool.query<FolderRow>(
      `SELECT
         so.id           AS "objectiveId",
         so.title        AS "objectiveTitle",
         sp.perspective,
         efa.assigned_at AS "assignedAt"
       FROM strategic_objectives so
       JOIN strategic_plans sp ON sp.id = so.plan_id
       LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
       WHERE so.id = $1
         ${allFolders ? "" : "AND efa.examiner_id = $2"}`,
      allFolders ? [objectiveId] : [objectiveId, userId]
    );

    if (folders.length === 0) {
      throw new AppError("Folder not found or not assigned to you.", 404);
    }

    const [folder] = await loadFolderContents(folders, !allFolders);
    const root = safeName(folder.objectiveTitle, 60);
    const summary = await buildSummaryPdf(folder);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(root)}.zip"; filename*=UTF-8''${encodeURIComponent(root)}.zip`
    );

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error("❌ [downloadFolder] archive error:", err);
      res.destroy(err);
    });
    archive.pipe(res);

    /* Append one entry and wait until it is fully written, so only one
       upstream download is open at a time. */
    const appendAndWait = (source: Buffer | NodeJS.ReadableStream, name: string) =>
      new Promise<void>((resolve) => {
        archive.once("entry", () => resolve());
        archive.append(source as any, { name });
      });

    await appendAndWait(summary, `${root}/00 Folder Summary.pdf`);

    const indicators: any[] = folder.completedIndicators;
    for (const [idx, ind] of indicators.entries()) {
      const indDir = `${root}/${String(idx + 1).padStart(2, "0")} ${safeName(ind.activityDescription ?? "Indicator", 60)}`;
      const usedNames = new Set<string>();

      for (const sub of ind.submissions ?? []) {
        const subDir = `${indDir}/${periodLabel(sub.quarter, sub.year)}`;

        for (const d of sub.documents ?? []) {
          // De-duplicate file names within the same period folder
          let name = safeName(d.fileName, 120);
          const dot = name.lastIndexOf(".");
          const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
          for (let n = 2; usedNames.has(`${subDir}/${name}`); n++) name = `${base} (${n})${ext}`;
          usedNames.add(`${subDir}/${name}`);

          try {
            if (!String(d.evidenceUrl).startsWith("https://res.cloudinary.com/")) {
              throw new Error("Unexpected file host");
            }
            const upstream = await axios.get(d.evidenceUrl, {
              responseType: "stream",
              timeout: 30000,
            });
            await appendAndWait(upstream.data, `${subDir}/${name}`);
          } catch (err) {
            console.error(`⚠️ [downloadFolder] could not fetch ${d.evidenceUrl}:`, (err as Error).message);
            await appendAndWait(
              Buffer.from(`This file could not be retrieved from storage when the ZIP was created.\n\nFile: ${d.fileName}\nURL: ${d.evidenceUrl}\n`),
              `${subDir}/MISSING - ${name}.txt`
            );
          }
        }
      }
    }

    await archive.finalize();
  }
);
