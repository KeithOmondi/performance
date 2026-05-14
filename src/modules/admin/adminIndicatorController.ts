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

/**
 * Fetches full indicator detail with camelCase aliases and grouped submissions.
 * Handles both quarterly and annual reporting cycles appropriately.
 * Includes document descriptions and metadata.
 * Supports both User and Team assignees via COALESCE on name and email.
 *
 * NOTE: teams.email exists as a varchar column — COALESCE(u.email, t.email)
 * is valid. If you ever see "column t.email does not exist" it means the
 * migration has not been applied to that environment yet.
 */
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

    -- Submissions grouped by period key, respecting reporting cycle
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
                'id',                s.id,
                'indicatorId',       s.indicator_id,
                'quarter',           s.quarter,
                'year',              s.year,
                'reviewStatus',      s.review_status,
                'adminComment',      s.admin_comment,
                'resubmissionCount', s.resubmission_count,
                'achievedValue',     s.achieved_value,
                'notes',             s.notes,
                'submittedAt',       s.submitted_at,
                'isReviewed',        s.is_reviewed,
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

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Validates submission quarter based on reporting cycle.
 */
const validateSubmissionPeriod = (
  reportingCycle: string,
  quarter: number,
  year: number
): void => {
  if (!year || year < 2000 || year > 2100) {
    throw new AppError("Invalid year provided", 400);
  }

  if (reportingCycle === "Annual") {
    if (quarter !== 1) {
      throw new AppError("Annual submissions must use quarter 1", 400);
    }
  } else if (reportingCycle === "Quarterly") {
    if (quarter < 1 || quarter > 4) {
      throw new AppError(
        "Quarter must be between 1 and 4 for quarterly indicators",
        400
      );
    }
  }
};

/**
 * Determines the next active quarter for an indicator.
 */
const getNextPeriod = (
  currentQuarter: number,
  reportingCycle: string
): number => {
  if (reportingCycle === "Annual") return 1;
  return currentQuarter + 1;
};

/**
 * Returns true when the indicator has no further periods to submit.
 */
const isFinalPeriod = (
  currentQuarter: number,
  reportingCycle: string
): boolean => {
  if (reportingCycle === "Annual") return true;
  return currentQuarter >= 4;
};

// ─── 1. Create / Resubmit Submission (User) ───────────────────────────────────

export const createSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const { indicatorId, achievedValue, notes, quarter, year } = req.body;
    const userId = (req as any).user?.id;

    if (!indicatorId || achievedValue === undefined || !year) {
      throw new AppError(
        "Missing required fields: indicatorId, achievedValue, year",
        400
      );
    }

    // ── Fetch indicator ──────────────────────────────────────────────────────
    const { rows: indicatorRows } = await pool.query(
      `SELECT id, status, reporting_cycle, active_quarter, assignee_id
       FROM indicators
       WHERE id = $1`,
      [indicatorId]
    );

    if (!indicatorRows[0]) {
      throw new AppError("Indicator not found", 404);
    }

    const indicator = indicatorRows[0];

    // ── Authorisation ────────────────────────────────────────────────────────
    if (indicator.assignee_id !== userId) {
      throw new AppError(
        "You are not authorized to submit for this indicator",
        403
      );
    }

    if (indicator.status !== "Pending") {
      throw new AppError(
        `Cannot submit for indicator with status: ${indicator.status}`,
        400
      );
    }

    // ── Normalise quarter for Annual cycle ───────────────────────────────────
    const submissionQuarter =
      indicator.reporting_cycle === "Annual" ? 1 : quarter;

    validateSubmissionPeriod(indicator.reporting_cycle, submissionQuarter, year);

    // ── Check for an existing submission in this period ──────────────────────
    let existingQuery = `
      SELECT id, review_status, resubmission_count
      FROM submissions
      WHERE indicator_id = $1 AND year = $2
    `;
    const queryParams: any[] = [indicatorId, year];

    if (indicator.reporting_cycle === "Quarterly") {
      existingQuery += ` AND quarter = $3`;
      queryParams.push(submissionQuarter);
    }

    const { rows: existingSubmissions } = await pool.query(
      existingQuery,
      queryParams
    );

    let submissionId: string;
    let resubmissionCount = 0;
    let isResubmission = false;

    if (existingSubmissions.length > 0) {
      const existing = existingSubmissions[0];

      if (
        existing.review_status === "Pending" ||
        existing.review_status === "Verified"
      ) {
        throw new AppError(
          "Cannot resubmit while current submission is under review",
          400
        );
      }

      isResubmission = true;
      resubmissionCount = existing.resubmission_count + 1;

      await pool.query(
        `UPDATE submissions
         SET achieved_value     = $1,
             notes              = $2,
             review_status      = 'Pending',
             is_reviewed        = false,
             resubmission_count = $3,
             submitted_at       = NOW(),
             admin_comment      = NULL
         WHERE id = $4`,
        [achievedValue, notes, resubmissionCount, existing.id]
      );

      submissionId = existing.id;
    } else {
      const { rows: inserted } = await pool.query(
        `INSERT INTO submissions (
           indicator_id, quarter, year, achieved_value, notes,
           submitted_at, review_status, resubmission_count
         ) VALUES ($1, $2, $3, $4, $5, NOW(), 'Pending', 0)
         RETURNING id`,
        [indicatorId, submissionQuarter, year, achievedValue, notes]
      );

      submissionId = inserted[0].id;
    }

    // ── Update indicator status ──────────────────────────────────────────────
    await pool.query(
      `UPDATE indicators
       SET status = 'Awaiting Admin Approval', updated_at = NOW()
       WHERE id = $1`,
      [indicatorId]
    );

    res.status(201).json({
      success: true,
      message: isResubmission ? "Resubmission successful" : "Submission successful",
      data: {
        submissionId,
        isResubmission,
        resubmissionCount,
        quarter: submissionQuarter,
        year,
      },
    });
  }
);

// ─── 2. Fetch All Indicators for Admin ────────────────────────────────────────

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

// ─── 3. Get Indicator By ID (Admin) ───────────────────────────────────────────

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

// ─── 4. Admin Review Process ──────────────────────────────────────────────────

export const adminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const {
      decision,
      adminOverallComments,
      submissionUpdates,
      documentUpdates,
    } = req.body;

    const adminId   = (req as any).user.id;
    const adminName = (req as any).user.name;

    if (!["Verified", "Rejected"].includes(decision)) {
      throw new AppError('Decision must be "Verified" or "Rejected".', 400);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // ── Fetch indicator + assignee (User or Team) ────────────────────────
      const { rows: indRows } = await client.query(
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
         FOR UPDATE`,
        [id]
      );

      const indicator = indRows[0];
      if (!indicator) throw new AppError("Indicator not found.", 404);

      // ── Apply document-level status updates ──────────────────────────────
      let hasRejectedDocument = false;

      if (Array.isArray(documentUpdates) && documentUpdates.length > 0) {
        for (const doc of documentUpdates) {
          if (doc.status === "Rejected") hasRejectedDocument = true;

          await client.query(
            `UPDATE submission_documents
             SET status = $1, rejection_reason = $2
             WHERE id = $3`,
            [doc.status, doc.reason ?? null, doc.documentId]
          );
        }
      }

      // A rejected document overrides a "Verified" decision
      const finalDecision   = hasRejectedDocument ? "Rejected" : decision;
      const isVerified      = finalDecision === "Verified";
      const newIndicatorStatus = isVerified
        ? "Awaiting Super Admin"
        : "Rejected by Admin";

      // ── Update indicator status ──────────────────────────────────────────
      await client.query(
        `UPDATE indicators
         SET status = $1, admin_overall_comments = $2, updated_at = NOW()
         WHERE id = $3`,
        [newIndicatorStatus, adminOverallComments, id]
      );

      // ── Update individual submission review statuses ──────────────────────
      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          await client.query(
            `UPDATE submissions
             SET review_status = $1,
                 admin_comment = $2,
                 is_reviewed   = true
             WHERE id = $3`,
            [
              isVerified ? "Verified" : "Rejected",
              update.adminComment ?? adminOverallComments,
              update.submissionId,
            ]
          );
        }
      }

      // ── Log to review history ─────────────────────────────────────────────
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [
          id,
          isVerified ? "Verified" : "Correction Requested",
          adminOverallComments,
          adminId,
        ]
      );

      await client.query("COMMIT");

      // ── Fire-and-forget email notifications ───────────────────────────────
      const taskTitle = indicator.instructions || "Performance Indicator";
      const year      = new Date().getFullYear();

      if (isVerified) {
        const { rows: superAdmins } = await pool.query(
          `SELECT email FROM users WHERE role = 'superadmin' AND is_active = true`
        );

        superAdmins.forEach(({ email }) => {
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
      } else {
        const comment = hasRejectedDocument
          ? `Specific documents were rejected: ${adminOverallComments}`
          : adminOverallComments;

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
            comment
          ),
        }).catch(console.error);
      }

      res.status(200).json({
        success: true,
        message: isVerified
          ? "Verified successfully."
          : "Rejected for correction.",
        autoRejectedDueToDocs: hasRejectedDocument && decision === "Verified",
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
         s.indicator_id       AS "indicatorId",
         s.quarter,
         s.year,
         s.achieved_value     AS "achievedValue",
         s.notes,
         s.review_status      AS "reviewStatus",
         s.admin_comment      AS "adminComment",
         s.resubmission_count AS "resubmissionCount",
         s.submitted_at       AS "submittedAt",
         s.is_reviewed        AS "isReviewed",
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
       WHERE s.indicator_id = $1
       ORDER BY s.year DESC, s.quarter DESC`,
      [id]
    );

    res.status(200).json({ success: true, data: rows });
  }
);