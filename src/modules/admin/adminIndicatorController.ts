import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import sendMail from "../../utils/sendMail";
import {
  submissionRejectedTemplate,
  superAdminReviewNeededTemplate,
} from "../../utils/mailTemplates";
import { deleteFromCloudinary } from "../../config/cloudinary";

// ─────────────────────────────────────────────────────────────────────────────
//  Shared document subquery
//  ✅ FIX: AND d.deleted_at IS NULL added to every occurrence so soft-deleted
//  documents are never returned to admins (fixes broken-URL errors and leaking
//  deleted evidence).
// ─────────────────────────────────────────────────────────────────────────────

const DOCUMENTS_SUBQUERY = `
  (
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id',                d.id,
          'submissionId',      d.submission_id,
          'evidenceUrl',       d.evidence_url,
          'evidencePublicId',  d.evidence_public_id,
          'fileType',          d.file_type,
          'fileName',          d.file_name,
          'description',       d.description,
          'status',            d.status,
          'rejectionReason',   d.rejection_reason,
          'uploadedAt',        d.uploaded_at
        ) ORDER BY d.uploaded_at DESC
      ),
      '[]'::json
    )
    FROM submission_documents d
    WHERE d.submission_id = s.id
      AND d.deleted_at IS NULL     -- ✅ FIX: exclude soft-deleted documents
  ) AS documents
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared submissions SELECT block (reused across multiple endpoints)
// ─────────────────────────────────────────────────────────────────────────────

const SUBMISSIONS_SELECT = `
  SELECT
    s.id,
    s.indicator_id                    AS "indicatorId",
    s.quarter,
    s.year,
    s.achieved_value                  AS "achievedValue",
    s.notes,
    s.review_status                   AS "reviewStatus",
    s.admin_comment                   AS "adminComment",
    s.resubmission_count              AS "resubmissionCount",
    s.submitted_at                    AS "submittedAt",
    s.is_reviewed                     AS "isReviewed",
    s.submitted_by                    AS "submittedById",
    s.previous_rejection_reason       AS "previousRejectionReason",
    su.name                           AS "submittedByName",
    ${DOCUMENTS_SUBQUERY}
  FROM submissions s
  LEFT JOIN users su ON su.id = s.submitted_by
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: group a flat submissions array into { periodKey: submission[] }
// ─────────────────────────────────────────────────────────────────────────────

function groupSubmissionsByPeriod(
  submissions: any[],
  reportingCycle: string,
): Record<string, any[]> {
  const grouped: Record<string, any[]> = {};
  for (const sub of submissions) {
    const isAnnual =
      reportingCycle === "Annual" || !sub.quarter || sub.quarter === 0;
    const periodKey = isAnnual
      ? `Annual_${sub.year}`
      : `Q${sub.quarter}_${sub.year}`;
    if (!grouped[periodKey]) grouped[periodKey] = [];
    grouped[periodKey].push(sub);
  }
  return grouped;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Recalculate indicator status based on its submissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines the correct indicator-level status by examining all submissions.
 * Rules (in priority order):
 *   1. Any Pending                           → "Awaiting Admin Approval"
 *   2. Any "Correction Needed"               → "Correction Needed"
 *   3. All Rejected                          → "Rejected by Admin"
 *   4. Any Verified (and nothing above)      → "Awaiting Super Admin"
 *   5. No submissions                        → keep current status
 */
async function recalcIndicatorStatus(
  client: any,
  indicatorId: string,
): Promise<string> {
  const { rows } = await client.query(
    `SELECT review_status FROM submissions WHERE indicator_id = $1`,
    [indicatorId],
  );

  if (rows.length === 0) {
    const { rows: indRows } = await client.query(
      `SELECT status FROM indicators WHERE id = $1`,
      [indicatorId],
    );
    return indRows[0]?.status || "Assigned";
  }

  const statuses: string[] = rows.map((r: any) => r.review_status);
  const hasPending    = statuses.includes("Pending");
  const hasCorrection = statuses.includes("Correction Needed");
  const hasVerified   = statuses.includes("Verified");
  const allRejected   = statuses.every((s: string) => s === "Rejected");

  if (hasPending)    return "Awaiting Admin Approval";
  if (hasCorrection) return "Correction Needed";
  if (allRejected)   return "Rejected by Admin";
  if (hasVerified)   return "Awaiting Super Admin";

  return "Awaiting Admin Approval";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Fetch indicator with assignee details and row-level lock
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAndLockIndicator(client: any, id: string) {
  const { rows } = await client.query(
    `SELECT i.*,
            COALESCE(u.name,  t.name)  AS assignee_name,
            COALESCE(u.email, t.email) AS assignee_email,
            i.active_quarter           AS "activeQuarter",
            i.reporting_cycle          AS "reportingCycle",
            i.instructions
     FROM indicators i
     LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
     LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [id],
  );

  const indicator = rows[0];
  if (!indicator) throw new AppError("Indicator not found.", 404);

  const allowedStatuses = [
    "Awaiting Admin Approval",
    "Correction Needed",
    "Rejected by Admin",
  ];
  if (!allowedStatuses.includes(indicator.status)) {
    throw new AppError(
      `Indicator not reviewable (current status: ${indicator.status}).`,
      400,
    );
  }

  return indicator;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared indicator SELECT columns (no submissions — those are fetched separately)
// ─────────────────────────────────────────────────────────────────────────────

const INDICATOR_SELECT = `
  SELECT
    i.id,
    i.name,
    i.status,
    i.progress,
    i.weight,
    i.unit,
    i.target,
    i.reporting_cycle                 AS "reportingCycle",
    i.active_quarter                  AS "activeQuarter",
    i.deadline,
    i.updated_at                      AS "updatedAt",
    i.admin_overall_comments          AS "adminOverallComments",
    i.instructions,
    COALESCE(u.name,  t.name)         AS "assigneeName",
    COALESCE(u.email, t.email)        AS "assigneeEmail",
    u.pj_number                       AS "pjNumber",
    sp.perspective,
    json_build_object('title',       so.title)       AS objective,
    json_build_object('description', sa.description) AS activity
  FROM indicators i
  LEFT JOIN users u              ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t              ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN strategic_plans sp   ON i.strategic_plan_id = sp.id
  LEFT JOIN strategic_objectives so ON i.objective_id = so.id
  LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: attach grouped submissions (and optional review history) to indicators
// ─────────────────────────────────────────────────────────────────────────────

async function attachSubmissionsToIndicators(
  indicators: any[],
  opts: { includeReviewHistory?: boolean } = {},
): Promise<any[]> {
  if (indicators.length === 0) return indicators;

  const ids = indicators.map((i: any) => i.id);

  const { rows: submissions } = await pool.query(
    `${SUBMISSIONS_SELECT}
     WHERE s.indicator_id = ANY($1)
     ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC`,
    [ids],
  );

  // Index submissions by indicator id
  const submissionsByIndicator = new Map<string, any[]>();
  for (const sub of submissions) {
    const list = submissionsByIndicator.get(sub.indicatorId) ?? [];
    list.push(sub);
    submissionsByIndicator.set(sub.indicatorId, list);
  }

  // Optionally fetch review history
  let historyMap: Map<string, any[]> | null = null;
  if (opts.includeReviewHistory) {
    const { rows: historyRows } = await pool.query(
      `SELECT rh.*,
              rh.reviewer_role AS "reviewerRole",
              u.name           AS "reviewedByName"
       FROM review_history rh
       LEFT JOIN users u ON rh.reviewed_by = u.id
       WHERE rh.indicator_id = ANY($1)
       ORDER BY rh.at DESC`,
      [ids],
    );
    historyMap = new Map<string, any[]>();
    for (const h of historyRows) {
      const list = historyMap.get(h.indicator_id) ?? [];
      list.push(h);
      historyMap.set(h.indicator_id, list);
    }
  }

  return indicators.map((ind: any) => {
    const indSubmissions = submissionsByIndicator.get(ind.id) ?? [];
    const grouped = groupSubmissionsByPeriod(indSubmissions, ind.reportingCycle);
    const result: any = { ...ind, submissions: grouped };
    if (historyMap) result.reviewHistory = historyMap.get(ind.id) ?? [];
    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Fetch All Indicators for Admin
// ─────────────────────────────────────────────────────────────────────────────

export const fetchIndicatorsForAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const values: any[] = [];
    let whereClause = "WHERE 1=1";

    if (status && status !== "all") {
      values.push(status);
      whereClause += ` AND i.status = $${values.length}`;
    }

    if (search) {
      values.push(`%${search}%`);
      whereClause += ` AND (
        COALESCE(u.name, t.name) ILIKE $${values.length} OR
        u.pj_number              ILIKE $${values.length}
      )`;
    }

    const { rows: indicators } = await pool.query(
      `${INDICATOR_SELECT} ${whereClause} ORDER BY i.updated_at DESC`,
      values,
    );

    const data = await attachSubmissionsToIndicators(indicators);
    res.status(200).json({ success: true, data });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  2. Get Indicator By ID (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const getIndicatorByIdAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { rows: indicators } = await pool.query(
      `${INDICATOR_SELECT} WHERE i.id = $1`,
      [id],
    );

    if (!indicators[0]) throw new AppError("Indicator not found.", 404);

    // Fetch submissions for this single indicator
    const { rows: submissions } = await pool.query(
      `${SUBMISSIONS_SELECT}
       WHERE s.indicator_id = $1
       ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC`,
      [id],
    );

    // Fetch review history
    const { rows: reviewHistory } = await pool.query(
      `SELECT h.*,
              h.reviewer_role AS "reviewerRole",
              u.name          AS "reviewerName"
       FROM review_history h
       LEFT JOIN users u ON h.reviewed_by = u.id
       WHERE h.indicator_id = $1
       ORDER BY h.at DESC`,
      [id],
    );

    const indicator = indicators[0];
    indicator.submissions  = groupSubmissionsByPeriod(submissions, indicator.reportingCycle);
    indicator.reviewHistory = reviewHistory;

    res.status(200).json({ success: true, data: indicator });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  3. Approve Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX: Recalculate indicator status instead of forcing "Awaiting Super Admin"
export const approveSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id           = req.params.id as string;
    const { submissionUpdates, adminOverallComments } = req.body;
    const adminId   = (req as any).user.id;
    const adminName = (req as any).user.name;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indicator = await fetchAndLockIndicator(client, id);

      // Mark each provided submission as Verified
      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          if (!update.submissionId) continue;
          await client.query(
            `UPDATE submissions
             SET review_status = 'Verified',
                 admin_comment = COALESCE($1, $2),
                 is_reviewed   = true,
                 updated_at    = NOW()
             WHERE id = $3
               AND review_status IN ('Pending', 'Correction Needed')`,
            [
              update.adminComment?.trim(),
              adminOverallComments?.trim() || "Approved.",
              update.submissionId,
            ],
          );
        }
      }

      // ✅ FIX: Use recalcIndicatorStatus to get the correct overall status
      const newStatus = await recalcIndicatorStatus(client, id);
      await client.query(
        `UPDATE indicators
         SET status                 = $1,
             admin_overall_comments = $2,
             updated_at             = NOW()
         WHERE id = $3`,
        [newStatus, adminOverallComments?.trim() || "Approved by admin.", id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Verified', $2, 'admin', $3)`,
        [id, adminOverallComments?.trim() || "Approved by admin.", adminId],
      );

      await client.query("COMMIT");

      // Notify super admins only if the whole indicator is now fully approved
      if (newStatus === "Awaiting Super Admin") {
        const taskTitle = indicator.instructions || "Performance Indicator";
        const year      = new Date().getFullYear();
        const { rows: superAdmins } = await pool.query(
          `SELECT email FROM users WHERE role = 'superadmin' AND is_active = true`,
        );
        superAdmins.forEach(({ email }: { email: string }) => {
          sendMail({
            to:      email,
            subject: "Submission Ready for Final Approval",
            html:    superAdminReviewNeededTemplate(
              taskTitle,
              indicator.name,
              adminName,
              indicator.reporting_cycle,
              indicator.active_quarter,
              year,
            ),
          }).catch(console.error);
        });
      }

      res.status(200).json({
        success: true,
        message: "Submission(s) approved.",
        data: { indicatorStatus: newStatus },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  4. Overall Reject Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { submissionUpdates, adminOverallComments } = req.body;
    const adminId = (req as any).user.id;

    if (!adminOverallComments?.trim()) {
      throw new AppError(
        "An overall comment is required when rejecting a submission.",
        400,
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indicator = await fetchAndLockIndicator(client, id);

      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          if (!update.submissionId) continue;
          await client.query(
            `UPDATE submissions
             SET review_status = 'Rejected',
                 admin_comment = $1,
                 is_reviewed   = true,
                 updated_at    = NOW()
             WHERE id = $2
               AND review_status IN ('Pending', 'Correction Needed')`,
            [
              update.adminComment?.trim() || adminOverallComments,
              update.submissionId,
            ],
          );
        }
      }

      const newStatus = await recalcIndicatorStatus(client, id);
      await client.query(
        `UPDATE indicators
         SET status                 = $1,
             admin_overall_comments = $2,
             updated_at             = NOW()
         WHERE id = $3`,
        [newStatus, adminOverallComments, id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Correction Requested', $2, 'admin', $3)`,
        [id, adminOverallComments, adminId],
      );

      await client.query("COMMIT");

      // Notify assignee
      const taskTitle = indicator.instructions || "Performance Indicator";
      const year      = new Date().getFullYear();
      sendMail({
        to:      indicator.assignee_email,
        subject: "Submission Returned for Correction",
        html:    submissionRejectedTemplate(
          indicator.name,
          taskTitle,
          indicator.reporting_cycle,
          indicator.active_quarter,
          year,
          "Admin",
          adminOverallComments,
        ),
      }).catch(console.error);

      res.status(200).json({
        success: true,
        message: "Submission returned for correction.",
        data: { indicatorStatus: newStatus },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  5. Reject Single Document (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { documentId, submissionId, reason } = req.body;
    const adminId = (req as any).user.id;

    if (!documentId)    throw new AppError("documentId is required.", 400);
    if (!submissionId)  throw new AppError("submissionId is required.", 400);
    if (!reason?.trim()) throw new AppError("A rejection reason is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Verify document belongs to the given submission and indicator
      const { rows: ownership } = await client.query(
        `SELECT sd.id
         FROM submission_documents sd
         JOIN submissions  s ON s.id  = sd.submission_id
         JOIN indicators   i ON i.id  = s.indicator_id
         WHERE sd.id = $1
           AND s.id  = $2
           AND i.id  = $3
           AND sd.deleted_at IS NULL     -- ✅ FIX: ignore soft-deleted docs
         FOR UPDATE OF i`,
        [documentId, submissionId, id],
      );
      if (!ownership.length) {
        throw new AppError("Document not found for this indicator.", 404);
      }

      // Reject the document
      await client.query(
        `UPDATE submission_documents
         SET status = 'Rejected', rejection_reason = $1
         WHERE id = $2`,
        [reason.trim(), documentId],
      );

      // ✅ FIX: exclude soft-deleted docs when determining submission status
      const { rows: allDocs } = await client.query(
        `SELECT status
         FROM submission_documents
         WHERE submission_id = $1
           AND deleted_at IS NULL`,     // ✅ FIX
        [submissionId],
      );

      const allRejected =
        allDocs.length > 0 && allDocs.every((d: any) => d.status === "Rejected");
      const newSubmissionStatus = allRejected ? "Rejected" : "Correction Needed";

      await client.query(
        `UPDATE submissions
         SET review_status = $1,
             is_reviewed   = true,
             updated_at    = NOW()
         WHERE id = $2`,
        [newSubmissionStatus, submissionId],
      );

      const newIndicatorStatus = await recalcIndicatorStatus(client, id);
      await client.query(
        `UPDATE indicators SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newIndicatorStatus, id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Document Rejected', $2, 'admin', $3)`,
        [id, `Document ${documentId}: ${reason.trim()}`, adminId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: "Document rejected and submission flagged for correction.",
        data: {
          indicatorStatus:  newIndicatorStatus,
          submissionStatus: newSubmissionStatus,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  6. Fetch Resubmitted Indicators (pending resubmissions)
// ─────────────────────────────────────────────────────────────────────────────

export const fetchResubmittedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT i.id
       FROM indicators  i
       JOIN submissions s ON s.indicator_id = i.id
       WHERE s.resubmission_count > 0
         AND s.review_status = 'Pending'`,
    );

    const ids = rows.map((r: any) => r.id);
    if (ids.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const { rows: indicators } = await pool.query(
      `${INDICATOR_SELECT} WHERE i.id = ANY($1)`,
      [ids],
    );

    const data  = await attachSubmissionsToIndicators(indicators);
    res.status(200).json({ success: true, count: data.length, data });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  7. Get Submissions for an Indicator
// ─────────────────────────────────────────────────────────────────────────────

export const getIndicatorSubmissions = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { rows } = await pool.query(
      `${SUBMISSIONS_SELECT}
       WHERE s.indicator_id = $1
       ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC`,
      [id],
    );

    res.status(200).json({ success: true, data: rows });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  8. Get Admin-Approved Indicators
// ─────────────────────────────────────────────────────────────────────────────

export const getAdminApprovedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows: indicators } = await pool.query(
      `SELECT DISTINCT
         i.id,
         i.name,
         i.status,
         i.progress,
         i.weight,
         i.unit,
         i.target,
         i.reporting_cycle                 AS "reportingCycle",
         i.active_quarter                  AS "activeQuarter",
         i.deadline,
         i.updated_at                      AS "updatedAt",
         i.admin_overall_comments          AS "adminOverallComments",
         i.instructions,
         COALESCE(u.name,  t.name)         AS "assigneeName",
         COALESCE(u.email, t.email)        AS "assigneeEmail",
         u.pj_number                       AS "pjNumber",
         sp.perspective,
         jsonb_build_object('title',       so.title)       AS objective,
         jsonb_build_object('description', sa.description) AS activity
       FROM indicators i
       JOIN review_history rh             ON rh.indicator_id = i.id
       LEFT JOIN users u                  ON i.assignee_id = u.id  AND i.assignee_model = 'User'
       LEFT JOIN teams t                  ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp       ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so  ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa  ON i.activity_id = sa.id
       WHERE rh.action = 'Verified'
         AND rh.reviewer_role = 'admin'
       ORDER BY i.updated_at DESC`,
    );

    if (indicators.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const data = await attachSubmissionsToIndicators(indicators, {
      includeReviewHistory: true,
    });

    res.status(200).json({ success: true, data });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  9. Delete a Single Submission (Admin — hard delete)
// ─────────────────────────────────────────────────────────────────────────────

export const deleteSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const indicatorId  = req.params.indicatorId as string;
    const submissionId = req.params.submissionId as string;

    if (Array.isArray(indicatorId) || Array.isArray(submissionId)) {
      throw new AppError("Invalid parameter format. Expected single IDs.", 400);
    }

    const adminId = (req as any).user.id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock and verify the indicator exists and is in a reviewable state
      await fetchAndLockIndicator(client, indicatorId);

      // Check submission exists and is deletable
      const { rows: subRows } = await client.query(
        `SELECT id, review_status, resubmission_count
         FROM submissions
         WHERE id = $1 AND indicator_id = $2
         FOR UPDATE`,
        [submissionId, indicatorId],
      );
      if (subRows.length === 0) {
        throw new AppError("Submission not found for this indicator.", 404);
      }

      const submission = subRows[0];
      if (!["Rejected", "Pending"].includes(submission.review_status)) {
        throw new AppError(
          `Cannot delete a submission with status: ${submission.review_status}. Only rejected or pending submissions can be deleted.`,
          400,
        );
      }

      // Collect all Cloudinary public IDs before deleting
      const { rows: docRows } = await client.query(
        `SELECT evidence_public_id
         FROM submission_documents
         WHERE submission_id = $1`,
        [submissionId],
      );
      const publicIds = docRows
        .map((r: any) => r.evidence_public_id)
        .filter(Boolean);

      // Hard-delete documents then submission
      await client.query(
        `DELETE FROM submission_documents WHERE submission_id = $1`,
        [submissionId],
      );
      await client.query(`DELETE FROM submissions WHERE id = $1`, [
        submissionId,
      ]);

      // Recalculate indicator status
      const newStatus = await recalcIndicatorStatus(client, indicatorId);
      await client.query(
        `UPDATE indicators SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, indicatorId],
      );

      // Audit log
      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Submission Deleted', $2, 'admin', $3)`,
        [
          indicatorId,
          `Submission ${submissionId} (${submission.review_status}) deleted by admin.`,
          adminId,
        ],
      );

      await client.query("COMMIT");

      // Cloudinary cleanup
      if (publicIds.length > 0) {
        publicIds.forEach((pid: string) =>
          deleteFromCloudinary(pid).catch((err: Error) =>
            console.error(
              `[deleteSubmission] Cloudinary cleanup failed for ${pid}:`,
              err,
            ),
          ),
        );
      }

      res.status(200).json({
        success: true,
        message: "Submission and associated documents have been deleted.",
        data: { indicatorStatus: newStatus },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  10. NEW: Admin soft‑deletes (marks as 'Deleted') a single document with a reason
//     The document remains visible to the user with status 'Deleted' and reason.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteDocumentAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { documentId, reason } = req.body;
    const adminId = (req as any).user.id;

    if (!documentId) throw new AppError("documentId is required.", 400);
    if (!reason?.trim()) throw new AppError("A deletion reason is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Verify document exists and belongs to an indicator (with row lock on indicator)
      const { rows: docRows } = await client.query(
        `SELECT sd.id, sd.submission_id, s.indicator_id
         FROM submission_documents sd
         JOIN submissions s ON s.id = sd.submission_id
         WHERE sd.id = $1
           AND sd.deleted_at IS NULL
         FOR UPDATE OF s`,
        [documentId],
      );

      if (docRows.length === 0) {
        throw new AppError("Document not found or already deleted.", 404);
      }

      const doc = docRows[0];
      const indicatorId = doc.indicator_id;

      // Lock the indicator
      await fetchAndLockIndicator(client, indicatorId);

      // Mark document as 'Deleted' with reason (no soft delete, just status change)
      await client.query(
        `UPDATE submission_documents
         SET status = 'Deleted',
             rejection_reason = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [reason.trim(), documentId],
      );

      // (Optional) Check if all documents in this submission are now Deleted?
      // If yes, you might want to update submission status to 'Rejected' or similar.
      // We'll leave the submission status unchanged; admin can manually reject if needed.

      // Audit log
      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Document Deleted', $2, 'admin', $3)`,
        [indicatorId, `Document ${documentId} deleted: ${reason.trim()}`, adminId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: "Document marked as deleted. The user will see the reason.",
        data: { documentId, status: 'Deleted', reason: reason.trim() },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);