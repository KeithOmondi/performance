import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import sendMail from "../../utils/sendMail";
import {
  submissionRejectedTemplate,
  superAdminReviewNeededTemplate,
} from "../../utils/mailTemplates";

// ─── Shared Query Base ────────────────────────────────────────────────────────

const INDICATOR_DETAIL_QUERY = `
  SELECT
    i.*,
    i.active_quarter      AS "activeQuarter",
    i.reporting_cycle     AS "reportingCycle",
    i.strategic_plan_id   AS "strategicPlanId",
    i.objective_id        AS "objectiveId",
    i.activity_id         AS "activityId",
    i.assignee_id         AS "assigneeId",
    i.updated_at          AS "updatedAt",
    COALESCE(u.name,  t.name)  AS "assigneeName",
    COALESCE(u.email, t.email) AS "assigneeEmail",
    u.pj_number                AS "pjNumber",
    ab.name                    AS "assignedByName",
    sp.perspective,

    (
      SELECT json_build_object('title', title)
      FROM strategic_objectives
      WHERE id = i.objective_id
    ) AS objective,

    (
      SELECT json_build_object('description', description)
      FROM strategic_activities
      WHERE id = i.activity_id
    ) AS activity,

    COALESCE(
      (
        SELECT json_object_agg(period_key, period_submissions)
        FROM (
          SELECT
            CASE
              WHEN i.reporting_cycle = 'Annual'
                THEN 'Annual_' || s.year
              ELSE CONCAT('Q', s.quarter, '_', s.year)
            END AS period_key,
            json_agg(
              json_build_object(
                'id',                      s.id,
                'indicatorId',             s.indicator_id,
                'quarter',                 s.quarter,
                'year',                    s.year,
                'reviewStatus',            s.review_status,
                'adminComment',            s.admin_comment,
                'resubmissionCount',       s.resubmission_count,
                'achievedValue',           s.achieved_value,
                'notes',                   s.notes,
                'submittedAt',             s.submitted_at,
                'isReviewed',              s.is_reviewed,
                'submittedById',           s.submitted_by,
                'submittedByName',         su.name,
                'previousRejectionReason', s.previous_rejection_reason,
                'documents', (
                  SELECT COALESCE(
                    json_agg(
                      json_build_object(
                        'id',               d.id,
                        'submissionId',     d.submission_id,
                        'evidenceUrl',      d.evidence_url,
                        'evidencePublicId', d.evidence_public_id,
                        'fileType',         d.file_type,
                        'fileName',         d.file_name,
                        'description',      d.description,
                        'status',           d.status,
                        'rejectionReason',  d.rejection_reason,
                        'uploadedAt',       d.uploaded_at
                      ) ORDER BY d.uploaded_at DESC
                    ),
                    '[]'::json
                  )
                  FROM submission_documents d
                  WHERE d.submission_id = s.id
                )
              ) ORDER BY s.submitted_at DESC
            ) AS period_submissions
          FROM submissions s
          LEFT JOIN users su ON su.id = s.submitted_by
          WHERE s.indicator_id = i.id
          GROUP BY
            CASE
              WHEN i.reporting_cycle = 'Annual'
                THEN 'Annual_' || s.year
              ELSE CONCAT('Q', s.quarter, '_', s.year)
            END
        ) grouped
      ),
      '{}'::json
    ) AS submissions

  FROM indicators i
  LEFT JOIN users u         ON i.assignee_id = u.id  AND i.assignee_model = 'User'
  LEFT JOIN teams t         ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
  LEFT JOIN users ab        ON i.assigned_by = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

// ─── Shared: fetch & lock indicator with assignee ─────────────────────────────

async function fetchAndLockIndicator(client: any, id: string) {
  const { rows } = await client.query(
    `SELECT
       i.*,
       i.active_quarter  AS "activeQuarter",
       i.reporting_cycle AS "reportingCycle",
       COALESCE(u.name,  t.name)  AS name,
       COALESCE(u.email, t.email) AS email
     FROM indicators i
     LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
     LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [id]
  );

  const indicator = rows[0];
  if (!indicator) throw new AppError("Indicator not found.", 404);

  if (indicator.status !== "Awaiting Admin Approval") {
    throw new AppError(
      `Indicator is not awaiting admin review (current status: ${indicator.status}).`,
      400
    );
  }

  return indicator;
}

// ─── 1. Fetch All Indicators for Admin ───────────────────────────────────────

export const fetchIndicatorsForAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const values: (string | number)[] = [];
    let whereClause = "WHERE 1=1";

    if (status && status !== "all") {
      values.push(status as string);
      whereClause += ` AND i.status = $${values.length}`;
    }

    if (search) {
      values.push(`%${search}%`);
      whereClause += ` AND (
        u.name       ILIKE $${values.length} OR
        t.name       ILIKE $${values.length} OR
        u.pj_number  ILIKE $${values.length}
      )`;
    }

    const { rows } = await pool.query(
      `${INDICATOR_DETAIL_QUERY} ${whereClause} ORDER BY i.updated_at DESC`,
      values
    );

    res.status(200).json({ success: true, data: rows });
  }
);

// ─── 2. Get Indicator By ID (Admin) ──────────────────────────────────────────

export const getIndicatorByIdAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { rows } = await pool.query(
      `${INDICATOR_DETAIL_QUERY} WHERE i.id = $1 LIMIT 1`,
      [id]
    );

    const indicator = rows[0];
    if (!indicator) throw new AppError("Indicator not found.", 404);

    const { rows: reviewHistory } = await pool.query(
      `SELECT
         h.*,
         h.reviewer_role AS "reviewerRole",
         u.name          AS "reviewerName"
       FROM review_history h
       LEFT JOIN users u ON h.reviewed_by = u.id
       WHERE h.indicator_id = $1
       ORDER BY h.at DESC`,
      [id]
    );

    indicator.reviewHistory = reviewHistory;

    res.status(200).json({ success: true, data: indicator });
  }
);

// ─── 3. Approve Submission (Admin) ───────────────────────────────────────────

export const approveSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { submissionUpdates, adminOverallComments } = req.body;

    const adminId   = (req as any).user.id;
    const adminName = (req as any).user.name;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const indicator = await fetchAndLockIndicator(client, id);

      // ── Mark all pending submissions as Verified ──────────────────────────
      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          if (!update.submissionId) continue;

          await client.query(
            `UPDATE submissions
             SET review_status = 'Verified',
                 admin_comment = $1,
                 is_reviewed   = true
             WHERE id = $2
               AND review_status = 'Pending'`,
            [
              update.adminComment?.trim() || adminOverallComments || "Approved.",
              update.submissionId,
            ]
          );
        }
      }

      // ── Advance indicator to next stage ───────────────────────────────────
      await client.query(
        `UPDATE indicators
         SET status = 'Awaiting Super Admin',
             admin_overall_comments = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [adminOverallComments || "Approved by admin.", id]
      );

      // ── Log ───────────────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Verified', $2, 'admin', $3)`,
        [id, adminOverallComments || "Approved by admin.", adminId]
      );

      await client.query("COMMIT");

      // ── Notify super admins ───────────────────────────────────────────────
      const taskTitle = indicator.instructions || "Performance Indicator";
      const year      = new Date().getFullYear();

      const { rows: superAdmins } = await pool.query(
        `SELECT email FROM users WHERE role = 'superadmin' AND is_active = true`
      );

      superAdmins.forEach(({ email }: { email: string }) => {
        sendMail({
          to: email,
          subject: "Submission Ready for Final Approval",
          html: superAdminReviewNeededTemplate(
            taskTitle,
            indicator.name,
            adminName,
            indicator.reporting_cycle,
            indicator.active_quarter,
            year
          ),
        }).catch(console.error);
      });

      res.status(200).json({
        success: true,
        message: "Submission approved and forwarded to Super Admin.",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

// ─── 4. Reject Submission (Admin) ────────────────────────────────────────────

export const rejectSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { submissionUpdates, documentUpdates, adminOverallComments } = req.body;
    const adminId = (req as any).user.id;

    // 🚀 Incoming request logger
    console.log("📥 [rejectSubmission] Incoming Request Details:", {
      indicatorId: id,
      adminId,
      adminOverallComments,
      submissionUpdatesCount: Array.isArray(submissionUpdates) ? submissionUpdates.length : 0,
      documentUpdatesCount: Array.isArray(documentUpdates) ? documentUpdates.length : 0,
      payload: { submissionUpdates, documentUpdates }
    });

    // ── 1. Global Comment Validation ──────────────────────────────────────
    if (!adminOverallComments?.trim()) {
      throw new AppError(
        "An overall comment is required when rejecting a submission.",
        400
      );
    }

    // ── 2. Individual Document Rejection Reason Validation ─────────────────
    if (Array.isArray(documentUpdates) && documentUpdates.length > 0) {
      for (const doc of documentUpdates) {
        if (!doc.documentId) continue;
        
        // If the document is being set to 'Rejected', it MUST have a reason
        if (doc.status === "Rejected" && !doc.reason?.trim()) {
          throw new AppError(
            `A specific rejection reason is required for document ID: ${doc.documentId}`,
            400
          );
        }
      }
    }

    // ── 3. Individual Submission Rejection Reason Validation ───────────────
    if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
      for (const update of submissionUpdates) {
        if (!update.submissionId) continue;

        // If there is no specific comment for this submission, and no global comment, block it
        const finalComment = update.adminComment?.trim() || adminOverallComments?.trim();
        if (!finalComment) {
          throw new AppError(
            `A rejection comment is required for submission ID: ${update.submissionId}`,
            400
          );
        }
      }
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const indicator = await fetchAndLockIndicator(client, id);

      // ── Apply document-level rejections ───────────────────────────────────
      let hasRejectedDocument = false;

      if (Array.isArray(documentUpdates) && documentUpdates.length > 0) {
        for (const doc of documentUpdates) {
          if (!doc.documentId) continue;

          if (doc.status === "Rejected") hasRejectedDocument = true;

          await client.query(
            `UPDATE submission_documents
             SET status = $1, rejection_reason = $2
             WHERE id = $3`,
            [doc.status, doc.reason ?? null, doc.documentId]
          );
        }
      }

      console.log("[rejectSubmission] indicator:", {
        id,
        hasRejectedDocument,
        adminOverallComments,
        submissionUpdates,
        documentUpdates,
      });

      // ── Mark submissions as Rejected ──────────────────────────────────────
      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          if (!update.submissionId) continue;

          await client.query(
            `UPDATE submissions
             SET review_status = 'Rejected',
                 admin_comment = $1,
                 is_reviewed   = true
             WHERE id = $2`,
            [
              update.adminComment?.trim() || adminOverallComments,
              update.submissionId,
            ]
          );
        }
      }

      // ── Set indicator back to rejected ────────────────────────────────────
      await client.query(
        `UPDATE indicators
         SET status = 'Rejected by Admin',
             admin_overall_comments = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [adminOverallComments, id]
      );

      // ── Log ───────────────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Correction Requested', $2, 'admin', $3)`,
        [id, adminOverallComments, adminId]
      );

      await client.query("COMMIT");

      // ── Notify assignee ───────────────────────────────────────────────────
      const taskTitle = indicator.instructions || "Performance Indicator";
      const year      = new Date().getFullYear();

      const rejectionComment = hasRejectedDocument
        ? `Specific documents were rejected. ${adminOverallComments}`.trim()
        : adminOverallComments;

      console.log("[rejectSubmission] sending rejection email to:", indicator.email, {
        rejectionComment,
        hasRejectedDocument,
      });

      sendMail({
        to: indicator.email,
        subject: "Submission Returned for Correction",
        html: submissionRejectedTemplate(
          indicator.name,
          taskTitle,
          indicator.reporting_cycle,
          indicator.active_quarter,
          year,
          "Admin",
          rejectionComment
        ),
      }).catch(console.error);

      res.status(200).json({
        success: true,
        message: "Submission returned for correction.",
        data: {
          autoRejectedDueToDocs: hasRejectedDocument,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

// ─── 5. Fetch Resubmitted Indicators ─────────────────────────────────────────

export const fetchResubmittedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      ${INDICATOR_DETAIL_QUERY}
      WHERE i.status = 'Awaiting Admin Approval'
        AND EXISTS (
          SELECT 1
          FROM submissions s
          WHERE s.indicator_id = i.id
            AND s.review_status = 'Pending'
            AND s.resubmission_count > 0
        )
      ORDER BY i.updated_at DESC
    `);

    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

// ─── 6. Get Submissions for an Indicator ─────────────────────────────────────

export const getIndicatorSubmissions = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.indicator_id              AS "indicatorId",
         s.quarter,
         s.year,
         s.achieved_value            AS "achievedValue",
         s.notes,
         s.review_status             AS "reviewStatus",
         s.admin_comment             AS "adminComment",
         s.resubmission_count        AS "resubmissionCount",
         s.submitted_at              AS "submittedAt",
         s.is_reviewed               AS "isReviewed",
         s.submitted_by              AS "submittedById",
         s.previous_rejection_reason AS "previousRejectionReason",
         su.name                     AS "submittedByName",
         COALESCE(
           (
             SELECT json_agg(
               json_build_object(
                 'id',               d.id,
                 'submissionId',     d.submission_id,
                 'evidenceUrl',      d.evidence_url,
                 'evidencePublicId', d.evidence_public_id,
                 'fileType',         d.file_type,
                 'fileName',         d.file_name,
                 'description',      d.description,
                 'status',           d.status,
                 'rejectionReason',  d.rejection_reason,
                 'uploadedAt',       d.uploaded_at
               ) ORDER BY d.uploaded_at DESC
             )
             FROM submission_documents d
             WHERE d.submission_id = s.id
           ),
           '[]'::json
         ) AS documents
       FROM submissions s
       LEFT JOIN users su ON su.id = s.submitted_by
       WHERE s.indicator_id = $1
       ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC`,
      [id]
    );

    res.status(200).json({ success: true, data: rows });
  }
);

export const getAdminApprovedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      WITH admin_approved AS (
        SELECT DISTINCT i.id
        FROM indicators i
        JOIN review_history rh ON rh.indicator_id = i.id
        WHERE rh.action = 'Verified' AND rh.reviewer_role = 'admin'
      )
      ${INDICATOR_DETAIL_QUERY}
      WHERE i.id IN (SELECT id FROM admin_approved)
      ORDER BY i.updated_at DESC
    `);

    // Optionally attach review history for each indicator (single additional query)
    const indicatorIds = rows.map(row => row.id);
    let historyMap = new Map();
    if (indicatorIds.length) {
      const { rows: historyRows } = await pool.query(
        `SELECT
           rh.*,
           rh.reviewer_role AS "reviewerRole",
           u.name AS "reviewedByName"
         FROM review_history rh
         LEFT JOIN users u ON rh.reviewed_by = u.id
         WHERE rh.indicator_id = ANY($1)
         ORDER BY rh.at DESC`,
        [indicatorIds]
      );
      historyRows.forEach(h => {
        if (!historyMap.has(h.indicator_id)) historyMap.set(h.indicator_id, []);
        historyMap.get(h.indicator_id).push(h);
      });
    }

    const enrichedRows = rows.map(row => ({
      ...row,
      reviewHistory: historyMap.get(row.id) || [],
    }));

    res.status(200).json({ success: true, data: enrichedRows });
  }
);