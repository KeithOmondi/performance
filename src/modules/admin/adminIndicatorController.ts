import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import sendMail from "../../utils/sendMail";
import {
  submissionRejectedTemplate,
  superAdminReviewNeededTemplate,
} from "../../utils/mailTemplates";

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Recalculate indicator status based on its submissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines the correct indicator-level status by examining all submissions.
 * Rules:
 * - If any submission is in 'Pending' and indicator is not already approved, status = 'Awaiting Admin Approval'
 * - Else if any submission is in 'Correction Needed' (partial rejection), status = 'Correction Needed'
 * - Else if all submissions are 'Verified' and at least one exists, status = 'Awaiting Super Admin'
 * - Else if all submissions are 'Rejected', status = 'Rejected by Admin'
 * - Else if indicator has no submissions, status remains as is (should be 'Draft' or 'Assigned')
 */
async function recalcIndicatorStatus(client: any, indicatorId: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT review_status FROM submissions WHERE indicator_id = $1`,
    [indicatorId]
  );

  if (rows.length === 0) {
    const { rows: indRows } = await client.query(
      `SELECT status FROM indicators WHERE id = $1`,
      [indicatorId]
    );
    return indRows[0]?.status || "Assigned";
  }

  const statuses: string[] = rows.map((r: any) => r.review_status);
  const hasPending = statuses.includes("Pending");
  const hasCorrection = statuses.includes("Correction Needed");
  const hasVerified = statuses.includes("Verified");
  const allRejected = statuses.every((s: string) => s === "Rejected");

  if (hasPending) return "Awaiting Admin Approval";
  if (hasCorrection) return "Correction Needed";
  if (allRejected) return "Rejected by Admin";
  if (hasVerified && !hasPending && !hasCorrection && !allRejected) return "Awaiting Super Admin";

  return "Awaiting Admin Approval";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Fetch indicator with assignee details and lock row
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAndLockIndicator(client: any, id: string) {
  const { rows } = await client.query(
    `SELECT i.*,
            COALESCE(u.name, t.name) AS assignee_name,
            COALESCE(u.email, t.email) AS assignee_email,
            i.active_quarter AS "activeQuarter",
            i.reporting_cycle AS "reportingCycle",
            i.instructions
     FROM indicators i
     LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
     LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [id]
  );

  const indicator = rows[0];
  if (!indicator) throw new AppError("Indicator not found.", 404);

  // Allow review for indicators that have pending or correction-needed submissions
  const allowedStatuses = ["Awaiting Admin Approval", "Correction Needed", "Rejected by Admin"];
  if (!allowedStatuses.includes(indicator.status)) {
    throw new AppError(
      `Indicator not reviewable (current status: ${indicator.status}).`,
      400
    );
  }
  return indicator;
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Fetch All Indicators for Admin (with proper submission aggregation)
// ─────────────────────────────────────────────────────────────────────────────

export const fetchIndicatorsForAdmin = asyncHandler(async (req: Request, res: Response) => {
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
      u.pj_number ILIKE $${values.length}
    )`;
  }

  // Main indicator query with simple aggregation (no nested JSON mess)
  const { rows: indicators } = await pool.query(
    `
    SELECT
      i.id,
      i.name,
      i.status,
      i.progress,
      i.weight,
      i.unit,
      i.target,
      i.reporting_cycle AS "reportingCycle",
      i.active_quarter AS "activeQuarter",
      i.deadline,
      i.updated_at AS "updatedAt",
      i.admin_overall_comments AS "adminOverallComments",
      i.instructions,
      COALESCE(u.name, t.name) AS "assigneeName",
      COALESCE(u.email, t.email) AS "assigneeEmail",
      u.pj_number AS "pjNumber",
      sp.perspective,
      json_build_object('title', so.title) AS objective,
      json_build_object('description', sa.description) AS activity
    FROM indicators i
    LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
    LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    LEFT JOIN strategic_objectives so ON i.objective_id = so.id
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    ${whereClause}
    ORDER BY i.updated_at DESC
    `,
    values
  );

  if (indicators.length === 0) {
    return res.status(200).json({ success: true, data: [] });
  }

  // Fetch submissions for all indicators in one go
  const indicatorIds = indicators.map((ind: any) => ind.id);
  const { rows: submissions } = await pool.query(
    `
    SELECT
      s.id,
      s.indicator_id AS "indicatorId",
      s.quarter,
      s.year,
      s.achieved_value AS "achievedValue",
      s.notes,
      s.review_status AS "reviewStatus",
      s.admin_comment AS "adminComment",
      s.resubmission_count AS "resubmissionCount",
      s.submitted_at AS "submittedAt",
      s.is_reviewed AS "isReviewed",
      s.submitted_by AS "submittedById",
      s.previous_rejection_reason AS "previousRejectionReason",
      su.name AS "submittedByName",
      (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'id', d.id,
              'submissionId', d.submission_id,
              'evidenceUrl', d.evidence_url,
              'evidencePublicId', d.evidence_public_id,
              'fileType', d.file_type,
              'fileName', d.file_name,
              'description', d.description,
              'status', d.status,
              'rejectionReason', d.rejection_reason,
              'uploadedAt', d.uploaded_at
            ) ORDER BY d.uploaded_at DESC
          ),
          '[]'::json
        )
        FROM submission_documents d
        WHERE d.submission_id = s.id
      ) AS documents
    FROM submissions s
    LEFT JOIN users su ON su.id = s.submitted_by
    WHERE s.indicator_id = ANY($1)
    ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC
    `,
    [indicatorIds]
  );

  // Group submissions by indicator and then by period
  const submissionsByIndicator = new Map();
  for (const sub of submissions) {
    const indId = sub.indicatorId;
    if (!submissionsByIndicator.has(indId)) submissionsByIndicator.set(indId, []);
    submissionsByIndicator.get(indId).push(sub);
  }

  // Build final response with submissions grouped by period
  const result = indicators.map((ind: any) => {
    const indSubmissions = submissionsByIndicator.get(ind.id) || [];
    const grouped: Record<string, any[]> = {};
    for (const sub of indSubmissions) {
      const periodKey =
        ind.reportingCycle === "Annual" || !sub.quarter || sub.quarter === 0
          ? `Annual_${sub.year}`
          : `Q${sub.quarter}_${sub.year}`;
      if (!grouped[periodKey]) grouped[periodKey] = [];
      grouped[periodKey].push(sub);
    }
    return { ...ind, submissions: grouped };
  });

  res.status(200).json({ success: true, data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Get Indicator By ID (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const getIndicatorByIdAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows: indicators } = await pool.query(
    `
    SELECT
      i.id, i.name, i.status, i.progress, i.weight, i.unit, i.target,
      i.reporting_cycle AS "reportingCycle", i.active_quarter AS "activeQuarter",
      i.deadline, i.updated_at AS "updatedAt", i.admin_overall_comments AS "adminOverallComments",
      i.instructions,
      COALESCE(u.name, t.name) AS "assigneeName", COALESCE(u.email, t.email) AS "assigneeEmail",
      u.pj_number AS "pjNumber", sp.perspective,
      json_build_object('title', so.title) AS objective,
      json_build_object('description', sa.description) AS activity
    FROM indicators i
    LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
    LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    LEFT JOIN strategic_objectives so ON i.objective_id = so.id
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    WHERE i.id = $1
    `,
    [id]
  );

  const indicator = indicators[0];
  if (!indicator) throw new AppError("Indicator not found.", 404);

  // Fetch submissions
  const { rows: submissions } = await pool.query(
    `
    SELECT
      s.id, s.quarter, s.year, s.achieved_value AS "achievedValue", s.notes,
      s.review_status AS "reviewStatus", s.admin_comment AS "adminComment",
      s.resubmission_count AS "resubmissionCount", s.submitted_at AS "submittedAt",
      s.is_reviewed AS "isReviewed", s.submitted_by AS "submittedById",
      s.previous_rejection_reason AS "previousRejectionReason", su.name AS "submittedByName",
      (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'id', d.id, 'submissionId', d.submission_id, 'evidenceUrl', d.evidence_url,
              'evidencePublicId', d.evidence_public_id, 'fileType', d.file_type,
              'fileName', d.file_name, 'description', d.description, 'status', d.status,
              'rejectionReason', d.rejection_reason, 'uploadedAt', d.uploaded_at
            ) ORDER BY d.uploaded_at DESC
          ),
          '[]'::json
        )
        FROM submission_documents d
        WHERE d.submission_id = s.id
      ) AS documents
    FROM submissions s
    LEFT JOIN users su ON su.id = s.submitted_by
    WHERE s.indicator_id = $1
    ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC
    `,
    [id]
  );

  const grouped: Record<string, any[]> = {};
  for (const sub of submissions) {
    const periodKey =
      indicator.reportingCycle === "Annual" || !sub.quarter || sub.quarter === 0
        ? `Annual_${sub.year}`
        : `Q${sub.quarter}_${sub.year}`;
    if (!grouped[periodKey]) grouped[periodKey] = [];
    grouped[periodKey].push(sub);
  }
  indicator.submissions = grouped;

  // Fetch review history
  const { rows: reviewHistory } = await pool.query(
    `
    SELECT h.*, h.reviewer_role AS "reviewerRole", u.name AS "reviewerName"
    FROM review_history h
    LEFT JOIN users u ON h.reviewed_by = u.id
    WHERE h.indicator_id = $1
    ORDER BY h.at DESC
    `,
    [id]
  );
  indicator.reviewHistory = reviewHistory;

  res.status(200).json({ success: true, data: indicator });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Approve Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const approveSubmission = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { submissionUpdates, adminOverallComments } = req.body;
  const adminId = (req as any).user.id;
  const adminName = (req as any).user.name;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const indicator = await fetchAndLockIndicator(client, id);

    // Mark each submission as Verified
    if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
      for (const update of submissionUpdates) {
        if (!update.submissionId) continue;
        await client.query(
          `UPDATE submissions
           SET review_status = 'Verified',
               admin_comment = COALESCE($1, $2),
               is_reviewed = true,
               updated_at = NOW()
           WHERE id = $3 AND review_status IN ('Pending', 'Correction Needed')`,
          [update.adminComment?.trim(), adminOverallComments?.trim() || "Approved.", update.submissionId]
        );
      }
    }

    // Update indicator status
    const newStatus = "Awaiting Super Admin";
    await client.query(
      `UPDATE indicators
       SET status = $1,
           admin_overall_comments = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [newStatus, adminOverallComments?.trim() || "Approved by admin.", id]
    );

    // Log action
    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, 'Verified', $2, 'admin', $3)`,
      [id, adminOverallComments?.trim() || "Approved by admin.", adminId]
    );

    await client.query("COMMIT");

    // Notify super admins
    const taskTitle = indicator.instructions || "Performance Indicator";
    const year = new Date().getFullYear();
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

    res.status(200).json({ success: true, message: "Submission approved and forwarded to Super Admin." });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Overall Reject Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectSubmission = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { submissionUpdates, adminOverallComments } = req.body;
  const adminId = (req as any).user.id;

  if (!adminOverallComments?.trim()) {
    throw new AppError("An overall comment is required when rejecting a submission.", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const indicator = await fetchAndLockIndicator(client, id);

    // Update each submission to Rejected
    if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
      for (const update of submissionUpdates) {
        if (!update.submissionId) continue;
        await client.query(
          `UPDATE submissions
           SET review_status = 'Rejected',
               admin_comment = $1,
               is_reviewed = true,
               updated_at = NOW()
           WHERE id = $2 AND review_status IN ('Pending', 'Correction Needed')`,
          [update.adminComment?.trim() || adminOverallComments, update.submissionId]
        );
      }
    }

    // Recalculate indicator status
    const newStatus = await recalcIndicatorStatus(client, id);

    await client.query(
      `UPDATE indicators
       SET status = $1,
           admin_overall_comments = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [newStatus, adminOverallComments, id]
    );

    // Log
    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, 'Correction Requested', $2, 'admin', $3)`,
      [id, adminOverallComments, adminId]
    );

    await client.query("COMMIT");

    // Notify assignee
    const taskTitle = indicator.instructions || "Performance Indicator";
    const year = new Date().getFullYear();
    sendMail({
      to: indicator.assignee_email,
      subject: "Submission Returned for Correction",
      html: submissionRejectedTemplate(
        indicator.name,
        taskTitle,
        indicator.reporting_cycle,
        indicator.active_quarter,
        year,
        "Admin",
        adminOverallComments
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
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Reject Single Document (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectDocument = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { documentId, submissionId, reason } = req.body;
  const adminId = (req as any).user.id;

  if (!documentId) throw new AppError("documentId is required.", 400);
  if (!submissionId) throw new AppError("submissionId is required.", 400);
  if (!reason?.trim()) throw new AppError("A rejection reason is required.", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock indicator and verify ownership
    const { rows: ownership } = await client.query(
      `SELECT sd.id
       FROM submission_documents sd
       JOIN submissions s ON s.id = sd.submission_id
       JOIN indicators i ON i.id = s.indicator_id
       WHERE sd.id = $1 AND s.id = $2 AND i.id = $3
       FOR UPDATE OF i`,
      [documentId, submissionId, id]
    );
    if (!ownership.length) throw new AppError("Document not found for this indicator.", 404);

    // Reject the document
    await client.query(
      `UPDATE submission_documents
       SET status = 'Rejected', rejection_reason = $1
       WHERE id = $2`,
      [reason.trim(), documentId]
    );

    // Re-evaluate parent submission status
    const { rows: allDocs } = await client.query(
      `SELECT status FROM submission_documents WHERE submission_id = $1`,
      [submissionId]
    );
    const allRejected = allDocs.length > 0 && allDocs.every(d => d.status === "Rejected");
    const newSubmissionStatus = allRejected ? "Rejected" : "Correction Needed";

    await client.query(
      `UPDATE submissions
       SET review_status = $1,
           is_reviewed = true,
           updated_at = NOW()
       WHERE id = $2`,
      [newSubmissionStatus, submissionId]
    );

    // Recalculate indicator status
    const newIndicatorStatus = await recalcIndicatorStatus(client, id);

    await client.query(
      `UPDATE indicators SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newIndicatorStatus, id]
    );

    // Log
    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, 'Document Rejected', $2, 'admin', $3)`,
      [id, `Document ${documentId}: ${reason.trim()}`, adminId]
    );

    await client.query("COMMIT");

    res.status(200).json({
      success: true,
      message: "Document rejected and submission flagged for correction.",
      data: { indicatorStatus: newIndicatorStatus, submissionStatus: newSubmissionStatus },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. Fetch Resubmitted Indicators (indicators with pending resubmissions)
// ─────────────────────────────────────────────────────────────────────────────

export const fetchResubmittedIndicators = asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT i.id
    FROM indicators i
    JOIN submissions s ON s.indicator_id = i.id
    WHERE s.resubmission_count > 0 AND s.review_status = 'Pending'
    `
  );
  const ids = rows.map(r => r.id);
  if (ids.length === 0) return res.status(200).json({ success: true, count: 0, data: [] });

  // Reuse the same detailed fetch logic (could refactor to a shared function)
  const { rows: indicators } = await pool.query(
    `
    SELECT i.id, i.name, i.status, i.progress, i.weight, i.unit, i.target,
           i.reporting_cycle AS "reportingCycle", i.active_quarter AS "activeQuarter",
           i.deadline, i.updated_at AS "updatedAt", i.admin_overall_comments AS "adminOverallComments",
           i.instructions,
           COALESCE(u.name, t.name) AS "assigneeName", COALESCE(u.email, t.email) AS "assigneeEmail",
           u.pj_number AS "pjNumber", sp.perspective,
           json_build_object('title', so.title) AS objective,
           json_build_object('description', sa.description) AS activity
    FROM indicators i
    LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
    LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    LEFT JOIN strategic_objectives so ON i.objective_id = so.id
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    WHERE i.id = ANY($1)
    `,
    [ids]
  );

  // Fetch submissions for these indicators (same as fetchIndicatorsForAdmin)
  const { rows: submissions } = await pool.query(
    `
    SELECT s.id, s.indicator_id AS "indicatorId", s.quarter, s.year,
           s.achieved_value AS "achievedValue", s.notes, s.review_status AS "reviewStatus",
           s.admin_comment AS "adminComment", s.resubmission_count AS "resubmissionCount",
           s.submitted_at AS "submittedAt", s.is_reviewed AS "isReviewed",
           s.submitted_by AS "submittedById", s.previous_rejection_reason AS "previousRejectionReason",
           su.name AS "submittedByName",
           COALESCE(
             (SELECT json_agg(json_build_object('id', d.id, 'submissionId', d.submission_id, 'evidenceUrl', d.evidence_url, 'evidencePublicId', d.evidence_public_id, 'fileType', d.file_type, 'fileName', d.file_name, 'description', d.description, 'status', d.status, 'rejectionReason', d.rejection_reason, 'uploadedAt', d.uploaded_at) ORDER BY d.uploaded_at DESC)
              FROM submission_documents d WHERE d.submission_id = s.id),
             '[]'::json
           ) AS documents
    FROM submissions s
    LEFT JOIN users su ON su.id = s.submitted_by
    WHERE s.indicator_id = ANY($1)
    `,
    [ids]
  );

  const submissionsByIndicator = new Map();
  for (const sub of submissions) {
    const indId = sub.indicatorId;
    if (!submissionsByIndicator.has(indId)) submissionsByIndicator.set(indId, []);
    submissionsByIndicator.get(indId).push(sub);
  }

  const result = indicators.map((ind: any) => {
    const indSubmissions = submissionsByIndicator.get(ind.id) || [];
    const grouped: Record<string, any[]> = {};
    for (const sub of indSubmissions) {
      const periodKey = ind.reportingCycle === "Annual" || !sub.quarter || sub.quarter === 0
        ? `Annual_${sub.year}`
        : `Q${sub.quarter}_${sub.year}`;
      if (!grouped[periodKey]) grouped[periodKey] = [];
      grouped[periodKey].push(sub);
    }
    return { ...ind, submissions: grouped };
  });

  res.status(200).json({ success: true, count: result.length, data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. Get Submissions for an Indicator
// ─────────────────────────────────────────────────────────────────────────────

export const getIndicatorSubmissions = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `
    SELECT s.id, s.indicator_id AS "indicatorId", s.quarter, s.year,
           s.achieved_value AS "achievedValue", s.notes, s.review_status AS "reviewStatus",
           s.admin_comment AS "adminComment", s.resubmission_count AS "resubmissionCount",
           s.submitted_at AS "submittedAt", s.is_reviewed AS "isReviewed",
           s.submitted_by AS "submittedById", s.previous_rejection_reason AS "previousRejectionReason",
           su.name AS "submittedByName",
           COALESCE(
             (SELECT json_agg(json_build_object('id', d.id, 'submissionId', d.submission_id, 'evidenceUrl', d.evidence_url, 'evidencePublicId', d.evidence_public_id, 'fileType', d.file_type, 'fileName', d.file_name, 'description', d.description, 'status', d.status, 'rejectionReason', d.rejection_reason, 'uploadedAt', d.uploaded_at) ORDER BY d.uploaded_at DESC)
              FROM submission_documents d WHERE d.submission_id = s.id),
             '[]'::json
           ) AS documents
    FROM submissions s
    LEFT JOIN users su ON su.id = s.submitted_by
    WHERE s.indicator_id = $1
    ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC
    `,
    [id]
  );
  res.status(200).json({ success: true, data: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. Get Admin-Approved Indicators
// ─────────────────────────────────────────────────────────────────────────────

export const getAdminApprovedIndicators = asyncHandler(async (_req: Request, res: Response) => {
  const { rows: indicators } = await pool.query(
    `
    SELECT DISTINCT i.id, i.name, i.status, i.progress, i.weight, i.unit, i.target,
       i.reporting_cycle AS "reportingCycle", i.active_quarter AS "activeQuarter",
       i.deadline, i.updated_at AS "updatedAt", i.admin_overall_comments AS "adminOverallComments",
       i.instructions,
       COALESCE(u.name, t.name) AS "assigneeName", COALESCE(u.email, t.email) AS "assigneeEmail",
       u.pj_number AS "pjNumber", sp.perspective,
       jsonb_build_object('title', so.title) AS objective,
       jsonb_build_object('description', sa.description) AS activity
FROM indicators i
JOIN review_history rh ON rh.indicator_id = i.id
LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
LEFT JOIN strategic_objectives so ON i.objective_id = so.id
LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
WHERE rh.action = 'Verified' AND rh.reviewer_role = 'admin'
ORDER BY i.updated_at DESC
    `
  );

  if (indicators.length === 0) return res.status(200).json({ success: true, data: [] });

  const ids = indicators.map((ind: any) => ind.id);
  const { rows: submissions } = await pool.query(
    `
    SELECT s.id, s.indicator_id AS "indicatorId", s.quarter, s.year,
           s.achieved_value AS "achievedValue", s.notes, s.review_status AS "reviewStatus",
           s.admin_comment AS "adminComment", s.resubmission_count AS "resubmissionCount",
           s.submitted_at AS "submittedAt", s.is_reviewed AS "isReviewed",
           s.submitted_by AS "submittedById", s.previous_rejection_reason AS "previousRejectionReason",
           su.name AS "submittedByName",
           COALESCE(
             (SELECT json_agg(json_build_object('id', d.id, 'submissionId', d.submission_id, 'evidenceUrl', d.evidence_url, 'evidencePublicId', d.evidence_public_id, 'fileType', d.file_type, 'fileName', d.file_name, 'description', d.description, 'status', d.status, 'rejectionReason', d.rejection_reason, 'uploadedAt', d.uploaded_at) ORDER BY d.uploaded_at DESC)
              FROM submission_documents d WHERE d.submission_id = s.id),
             '[]'::json
           ) AS documents
    FROM submissions s
    LEFT JOIN users su ON su.id = s.submitted_by
    WHERE s.indicator_id = ANY($1)
    `,
    [ids]
  );

  const historyMap = new Map();
  const { rows: historyRows } = await pool.query(
    `SELECT rh.*, rh.reviewer_role AS "reviewerRole", u.name AS "reviewedByName"
     FROM review_history rh
     LEFT JOIN users u ON rh.reviewed_by = u.id
     WHERE rh.indicator_id = ANY($1)
     ORDER BY rh.at DESC`,
    [ids]
  );
  historyRows.forEach((h: any) => {
    if (!historyMap.has(h.indicator_id)) historyMap.set(h.indicator_id, []);
    historyMap.get(h.indicator_id).push(h);
  });

  const submissionsByIndicator = new Map();
  for (const sub of submissions) {
    const indId = sub.indicatorId;
    if (!submissionsByIndicator.has(indId)) submissionsByIndicator.set(indId, []);
    submissionsByIndicator.get(indId).push(sub);
  }

  const result = indicators.map((ind: any) => {
    const indSubmissions = submissionsByIndicator.get(ind.id) || [];
    const grouped: Record<string, any[]> = {};
    for (const sub of indSubmissions) {
      const periodKey = ind.reportingCycle === "Annual" || !sub.quarter || sub.quarter === 0
        ? `Annual_${sub.year}`
        : `Q${sub.quarter}_${sub.year}`;
      if (!grouped[periodKey]) grouped[periodKey] = [];
      grouped[periodKey].push(sub);
    }
    return {
      ...ind,
      submissions: grouped,
      reviewHistory: historyMap.get(ind.id) || [],
    };
  });

  res.status(200).json({ success: true, data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
//  9. Delete a Single Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const deleteSubmission = asyncHandler(async (req: Request, res: Response) => {
  // Explicitly cast params to strings – they are always strings in practice
  const indicatorId = req.params.indicatorId as string;
  const submissionId = req.params.submissionId as string;

  // Safety check: if either is an array, throw an error
  if (Array.isArray(indicatorId) || Array.isArray(submissionId)) {
    throw new AppError("Invalid parameter format. Expected single IDs.", 400);
  }

  const adminId = (req as any).user.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock and verify the indicator exists
    const indicator = await fetchAndLockIndicator(client, indicatorId);

    // 2. Check submission exists, belongs to indicator, and is deletable
    const { rows: subRows } = await client.query(
      `SELECT id, review_status, resubmission_count
       FROM submissions
       WHERE id = $1 AND indicator_id = $2
       FOR UPDATE`,
      [submissionId, indicatorId]
    );
    if (subRows.length === 0) {
      throw new AppError("Submission not found for this indicator.", 404);
    }
    const submission = subRows[0];
    if (!["Rejected", "Pending"].includes(submission.review_status)) {
      throw new AppError(
        `Cannot delete a submission with status: ${submission.review_status}. Only rejected or pending submissions can be deleted.`,
        400
      );
    }

    // 3. Get Cloudinary public IDs (for optional cleanup)
    const { rows: docRows } = await client.query(
      `SELECT evidence_public_id FROM submission_documents WHERE submission_id = $1`,
      [submissionId]
    );
    const publicIds = docRows.map(r => r.evidence_public_id).filter(Boolean);

    // 4. Delete documents and submission (hard delete)
    await client.query(
      `DELETE FROM submission_documents WHERE submission_id = $1`,
      [submissionId]
    );
    await client.query(
      `DELETE FROM submissions WHERE id = $1`,
      [submissionId]
    );

    // 5. Recalculate indicator status
    const newStatus = await recalcIndicatorStatus(client, indicatorId);
    await client.query(
      `UPDATE indicators SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, indicatorId]
    );

    // 6. Log the action
    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, 'Submission Deleted', $2, 'admin', $3)`,
      [indicatorId, `Submission ${submissionId} (${submission.review_status}) deleted by admin.`, adminId]
    );

    await client.query("COMMIT");

    // 7. (Optional) Delete from Cloudinary asynchronously
    if (publicIds.length > 0) {
      // Uncomment if you have a deleteFromCloudinary helper:
      // publicIds.forEach(pid => deleteFromCloudinary(pid).catch(console.error));
    }

    res.status(200).json({
      success: true,
      message: "Submission and associated documents have been deleted.",
      data: { indicatorStatus: newStatus }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});