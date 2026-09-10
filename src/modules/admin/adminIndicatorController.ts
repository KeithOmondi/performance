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
//  Helper: Ensure param is a string
// ─────────────────────────────────────────────────────────────────────────────

function getParamString(param: string | string[] | undefined): string {
  if (!param) throw new AppError("Missing required parameter.", 400);
  return Array.isArray(param) ? param[0] : param;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared document subquery
//
//  Returns BOTH own submission documents AND linked spot-check documents.
//  Each entry carries a `source` field ('own' | 'spot-check') so the
//  frontend can distinguish them if needed.
// ─────────────────────────────────────────────────────────────────────────────

const DOCUMENTS_SUBQUERY = `
  (
    SELECT COALESCE(
      json_agg(doc_row.doc_json ORDER BY doc_row.uploaded_at DESC),
      '[]'::json
    )
    FROM (
      /* Own uploaded documents */
      SELECT
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
          'uploadedAt',        d.uploaded_at,
          'source',            'own'
        ) AS doc_json,
        d.uploaded_at
      FROM submission_documents d
      WHERE d.submission_id = s.id
        AND d.deleted_at IS NULL

      UNION ALL

      /* Linked spot-check library documents */
      SELECT
        json_build_object(
          'id',                l.id,
          'submissionId',      l.submission_id,
          'evidenceUrl',       l.evidence_url,
          'evidencePublicId',  l.evidence_public_id,
          'fileType',          l.file_type,
          'fileName',          l.file_name,
          'description',       l.description,
          'status',            'Approved',
          'rejectionReason',   NULL,
          'uploadedAt',        l.linked_at,
          'source',            'spot-check'
        ) AS doc_json,
        l.linked_at AS uploaded_at
      FROM submission_spot_check_links l
      WHERE l.submission_id = s.id
    ) doc_row
  ) AS documents
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared submissions SELECT block
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
//  Helper: Get quarter status summary for an indicator
// ─────────────────────────────────────────────────────────────────────────────

interface QuarterStatus {
  submissionId: string;
  quarter: number;
  year: number;
  achievedValue: number;
  reviewStatus: string;
  isComplete: boolean;
  isPartial: boolean;
  isPending: boolean;
  isRejected: boolean;
  isSentBack: boolean;
  documents: any[];
}

async function getQuarterStatuses(
  client: any,
  indicatorId: string
): Promise<QuarterStatus[]> {
  const { rows } = await client.query(
    `SELECT 
       s.id as "submissionId",
       s.quarter,
       s.year,
       s.achieved_value as "achievedValue",
       s.review_status as "reviewStatus",
       s.is_reviewed as "isReviewed",
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', d.id,
               'status', d.status,
               'rejectionReason', d.rejection_reason
             )
           )
           FROM submission_documents d
           WHERE d.submission_id = s.id
             AND d.deleted_at IS NULL
         ),
         '[]'::json
       ) as documents
     FROM submissions s
     WHERE s.indicator_id = $1
     ORDER BY s.year ASC, s.quarter ASC`,
    [indicatorId]
  );

  return rows.map((row: any) => {
    const docs = row.documents || [];
    const allApproved = docs.length > 0 && docs.every((d: any) => d.status === 'Approved' || d.status === 'Accepted');
    const hasRejected = docs.some((d: any) => d.status === 'Rejected');
    const hasPending = docs.some((d: any) => d.status === 'Pending' || d.status === 'Resubmitted');

    return {
      submissionId: row.submissionId,
      quarter: row.quarter,
      year: row.year,
      achievedValue: row.achievedValue || 0,
      reviewStatus: row.reviewStatus,
      isComplete: row.reviewStatus === 'Accepted' || row.reviewStatus === 'Verified',
      isPartial: row.reviewStatus === 'Partially Approved',
      isPending: row.reviewStatus === 'Pending' || hasPending,
      isRejected: row.reviewStatus === 'Rejected' || hasRejected,
      isSentBack: row.reviewStatus === 'Sent Back to Admin',
      documents: docs,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Recalculate indicator status based on quarter statuses
// ─────────────────────────────────────────────────────────────────────────────

async function recalcIndicatorStatusFromQuarters(
  client: any,
  indicatorId: string,
): Promise<{
  indicatorStatus: string;
  overallProgress: number;
  quarterStatuses: QuarterStatus[];
}> {
  const quarterStatuses = await getQuarterStatuses(client, indicatorId);
  
  if (quarterStatuses.length === 0) {
    const { rows } = await client.query(
      `SELECT status FROM indicators WHERE id = $1`,
      [indicatorId]
    );
    return {
      indicatorStatus: rows[0]?.status || "Pending",
      overallProgress: 0,
      quarterStatuses: [],
    };
  }

  const hasPending = quarterStatuses.some(q => q.isPending);
  const hasRejected = quarterStatuses.some(q => q.isRejected);
  const hasPartial = quarterStatuses.some(q => q.isPartial);
  const hasSentBack = quarterStatuses.some(q => q.isSentBack);
  const allComplete = quarterStatuses.every(q => q.isComplete);
  const anyComplete = quarterStatuses.some(q => q.isComplete);

  let indicatorStatus: string;
  if (allComplete) {
    indicatorStatus = "Completed";
  } else if (hasSentBack) {
    indicatorStatus = "Awaiting Admin Approval";
  } else if (hasRejected) {
    indicatorStatus = "Correction Needed";
  } else if (hasPending) {
    indicatorStatus = "Awaiting Admin Approval";
  } else if (hasPartial) {
    indicatorStatus = "Partially Approved";
  } else if (anyComplete) {
    indicatorStatus = "Partially Approved";
  } else {
    indicatorStatus = "Awaiting Admin Approval";
  }

  const totalQuarters = quarterStatuses.length;
  const completedQuarters = quarterStatuses.filter(q => q.isComplete).length;
  const overallProgress = totalQuarters > 0 ? Math.round((completedQuarters / totalQuarters) * 100) : 0;

  return {
    indicatorStatus,
    overallProgress,
    quarterStatuses,
  };
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

  return indicator;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Resolve assignee name/email for an indicator WITHOUT locking.
//  Used by quarter-approve/reject to send notification emails.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveIndicatorAssignee(id: string): Promise<{
  assigneeName: string;
  assigneeEmail: string | null;
}> {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(u.name,  t.name)  AS "assigneeName",
       COALESCE(u.email, t.email) AS "assigneeEmail"
     FROM indicators i
     LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
     LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
     WHERE i.id = $1`,
    [id],
  );

  return {
    assigneeName: rows[0]?.assigneeName ?? "User",
    assigneeEmail: rows[0]?.assigneeEmail ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared indicator SELECT columns
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
//  Helper: attach grouped submissions to indicators
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

  const submissionsByIndicator = new Map<string, any[]>();
  for (const sub of submissions) {
    const list = submissionsByIndicator.get(sub.indicatorId) ?? [];
    list.push(sub);
    submissionsByIndicator.set(sub.indicatorId, list);
  }

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
    const id = getParamString(req.params.id);

    const { rows: indicators } = await pool.query(
      `${INDICATOR_SELECT} WHERE i.id = $1`,
      [id],
    );

    if (!indicators[0]) throw new AppError("Indicator not found.", 404);

    const { rows: submissions } = await pool.query(
      `${SUBMISSIONS_SELECT}
       WHERE s.indicator_id = $1
       ORDER BY s.year DESC, s.quarter DESC, s.submitted_at DESC`,
      [id],
    );

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
    indicator.submissions = groupSubmissionsByPeriod(submissions, indicator.reportingCycle);
    indicator.reviewHistory = reviewHistory;

    res.status(200).json({ success: true, data: indicator });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  3. Approve Individual Document (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const approveDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const { documentId, submissionId, adminComment } = req.body;
    const adminId = (req as any).user.id;

    if (!documentId) throw new AppError("documentId is required.", 400);
    if (!submissionId) throw new AppError("submissionId is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: submissionRows } = await client.query(
        `SELECT id, review_status, indicator_id, quarter, year
         FROM submissions
         WHERE id = $1
         FOR UPDATE`,
        [submissionId],
      );

      if (submissionRows.length === 0) {
        throw new AppError("Submission not found.", 404);
      }

      const submission = submissionRows[0];

      const { rows: ownership } = await client.query(
        `SELECT sd.id, s.indicator_id, s.quarter, s.year
         FROM submission_documents sd
         JOIN submissions s ON s.id = sd.submission_id
         WHERE sd.id = $1
           AND s.id = $2
           AND sd.deleted_at IS NULL
         FOR UPDATE OF s`,
        [documentId, submissionId],
      );

      if (!ownership.length) {
        throw new AppError("Document not found for this submission.", 404);
      }

      const indicatorId = ownership[0].indicator_id;

      await fetchAndLockIndicator(client, indicatorId);

      await client.query(
        `UPDATE submission_documents
         SET status = 'Approved',
             rejection_reason = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [documentId],
      );

      const { rows: allDocs } = await client.query(
        `SELECT status
         FROM submission_documents
         WHERE submission_id = $1
           AND deleted_at IS NULL`,
        [submissionId],
      );

      const allApproved = allDocs.length > 0 && allDocs.every((d: any) => d.status === 'Approved');
      const hasRejected = allDocs.some((d: any) => d.status === 'Rejected');
      const hasPending = allDocs.some((d: any) => d.status === 'Pending' || d.status === 'Resubmitted');

      let newQuarterStatus: string;
      if (allApproved) {
        newQuarterStatus = 'Accepted';
      } else if (hasRejected) {
        newQuarterStatus = 'Correction Needed';
      } else if (hasPending) {
        newQuarterStatus = 'Pending';
      } else {
        // No approved-not-all, no rejected, no pending: the remaining
        // combinations are mixed approved+additional. Treat as partial.
        newQuarterStatus = 'Partially Approved';
      }

      await client.query(
        `UPDATE submissions
         SET review_status = $1,
             admin_comment = COALESCE($2, admin_comment),
             is_reviewed = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [newQuarterStatus, adminComment?.trim(), allApproved, submissionId],
      );

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, indicatorId);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [indicatorStatus, overallProgress, indicatorId],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Document Approved', $2, 'admin', $3)`,
        [indicatorId, adminComment?.trim() || 'Document approved by admin.', adminId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: 'Document approved successfully.',
        data: {
          documentId,
          submissionId,
          quarterStatus: newQuarterStatus,
          indicatorStatus,
          overallProgress,
          quarterStatuses,
          allDocumentsApproved: allApproved,
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
//  4. Reject Individual Document (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const { documentId, submissionId, reason } = req.body;
    const adminId = (req as any).user.id;

    if (!documentId) throw new AppError("documentId is required.", 400);
    if (!submissionId) throw new AppError("submissionId is required.", 400);
    if (!reason?.trim()) throw new AppError("A rejection reason is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: ownership } = await client.query(
        `SELECT sd.id, s.indicator_id, s.quarter, s.year
         FROM submission_documents sd
         JOIN submissions s ON s.id = sd.submission_id
         WHERE sd.id = $1
           AND s.id = $2
           AND sd.deleted_at IS NULL
         FOR UPDATE OF s`,
        [documentId, submissionId],
      );

      if (!ownership.length) {
        throw new AppError("Document not found for this submission.", 404);
      }

      const indicatorId = ownership[0].indicator_id;

      await fetchAndLockIndicator(client, indicatorId);

      await client.query(
        `UPDATE submission_documents
         SET status = 'Rejected',
             rejection_reason = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [reason.trim(), documentId],
      );

      await client.query(
        `UPDATE submissions
         SET review_status = 'Correction Needed',
             admin_comment = COALESCE(admin_comment, 'One or more documents require corrections.'),
             is_reviewed = true,
             updated_at = NOW()
         WHERE id = $1`,
        [submissionId],
      );

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, indicatorId);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [indicatorStatus, overallProgress, indicatorId],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Document Rejected', $2, 'admin', $3)`,
        [indicatorId, `Document ${documentId}: ${reason.trim()}`, adminId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: "Document rejected and quarter flagged for correction.",
        data: {
          documentId,
          submissionId,
          quarterStatus: 'Correction Needed',
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  5. Approve Entire Quarter (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const approveQuarter = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);
    const { submissionId, adminComment } = req.body;
    const adminId = (req as any).user.id;
    const adminName = (req as any).user.name;

    if (!submissionId) throw new AppError("submissionId is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await fetchAndLockIndicator(client, id);

      const { rows: subRows } = await client.query(
        `SELECT id, quarter, year, indicator_id
         FROM submissions
         WHERE id = $1 AND indicator_id = $2
         FOR UPDATE`,
        [submissionId, id],
      );

      if (subRows.length === 0) {
        throw new AppError("Submission not found for this indicator.", 404);
      }

      const submission = subRows[0];

      const { rows: docRows } = await client.query(
        `SELECT status
         FROM submission_documents
         WHERE submission_id = $1
           AND deleted_at IS NULL`,
        [submissionId],
      );

      const hasRejected = docRows.some((d: any) => d.status === 'Rejected');
      const hasPending = docRows.some((d: any) => d.status === 'Pending' || d.status === 'Resubmitted');

      if (hasRejected) {
        throw new AppError(
          "Cannot approve this quarter because it has rejected documents. Please resolve them first.",
          400,
        );
      }

      if (hasPending) {
        throw new AppError(
          "Cannot approve this quarter because it has pending documents. Please review them first.",
          400,
        );
      }

      if (docRows.length === 0) {
        throw new AppError(
          "Cannot approve this quarter because it has no documents.",
          400,
        );
      }

      await client.query(
        `UPDATE submissions
         SET review_status = 'Accepted',
             admin_comment = COALESCE($1, admin_comment, 'Quarter approved by admin.'),
             is_reviewed = true,
             updated_at = NOW()
         WHERE id = $2`,
        [adminComment?.trim() || 'Quarter approved by admin.', submissionId],
      );

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, id);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [indicatorStatus, overallProgress, id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Quarter Approved', $2, 'admin', $3)`,
        [id, adminComment?.trim() || 'Quarter approved by admin.', adminId],
      );

      await client.query("COMMIT");

      /* ── Notification email ────────────────────────────────────────
         Resolve the assignee email from the users/teams join, since
         the `indicators` table doesn't have an `assignee_email` column. */
      const quarterLabel = submission.quarter === 0 ? 'Annual' : `Q${submission.quarter}`;
      const { assigneeName, assigneeEmail } = await resolveIndicatorAssignee(id);

      if (assigneeEmail) {
        sendMail({
          to: assigneeEmail,
          subject: `✅ ${quarterLabel} ${submission.year} Approved`,
          html: `
            <h2>Quarter Approved</h2>
            <p>Hello ${assigneeName},</p>
            <p>The quarter <strong>${quarterLabel} ${submission.year}</strong> has been approved.</p>
            <p>Approved by: ${adminName ?? 'Admin'}</p>
            ${adminComment ? `<p>Comment: ${adminComment}</p>` : ''}
          `,
        }).catch((err) =>
          console.error(`[approveQuarter] Failed to send email to ${assigneeEmail}:`, err),
        );
      } else {
        console.warn(`[approveQuarter] No assignee email found for indicator ${id}`);
      }

      res.status(200).json({
        success: true,
        message: `Quarter ${quarterLabel} ${submission.year} approved successfully.`,
        data: {
          submissionId,
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  6. Reject Entire Quarter (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectQuarter = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);
    const { submissionId, reason } = req.body;
    const adminId = (req as any).user.id;
    const adminName = (req as any).user.name;

    if (!submissionId) throw new AppError("submissionId is required.", 400);
    if (!reason?.trim()) throw new AppError("A rejection reason is required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await fetchAndLockIndicator(client, id);

      const { rows: subRows } = await client.query(
        `SELECT id, quarter, year, indicator_id
         FROM submissions
         WHERE id = $1 AND indicator_id = $2
         FOR UPDATE`,
        [submissionId, id],
      );

      if (subRows.length === 0) {
        throw new AppError("Submission not found for this indicator.", 404);
      }

      const submission = subRows[0];

      await client.query(
        `UPDATE submissions
         SET review_status = 'Rejected',
             admin_comment = $1,
             is_reviewed = true,
             updated_at = NOW()
         WHERE id = $2`,
        [reason.trim(), submissionId],
      );

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, id);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [indicatorStatus, overallProgress, id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Quarter Rejected', $2, 'admin', $3)`,
        [id, reason.trim(), adminId],
      );

      await client.query("COMMIT");

      /* ── Notification email ────────────────────────────────────────
         Same fix as approveQuarter: resolve assignee from the join. */
      const quarterLabel = submission.quarter === 0 ? 'Annual' : `Q${submission.quarter}`;
      const { assigneeName, assigneeEmail } = await resolveIndicatorAssignee(id);

      if (assigneeEmail) {
        sendMail({
          to: assigneeEmail,
          subject: `❌ ${quarterLabel} ${submission.year} Rejected`,
          html: `
            <h2>Quarter Rejected</h2>
            <p>Hello ${assigneeName},</p>
            <p>The quarter <strong>${quarterLabel} ${submission.year}</strong> has been rejected.</p>
            <p>Rejected by: ${adminName ?? 'Admin'}</p>
            <p><strong>Reason:</strong> ${reason.trim()}</p>
            <p>Please review the feedback and resubmit.</p>
          `,
        }).catch((err) =>
          console.error(`[rejectQuarter] Failed to send email to ${assigneeEmail}:`, err),
        );
      } else {
        console.warn(`[rejectQuarter] No assignee email found for indicator ${id}`);
      }

      res.status(200).json({
        success: true,
        message: `Quarter ${quarterLabel} ${submission.year} rejected.`,
        data: {
          submissionId,
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  7. Get Quarter Statuses for an Indicator (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const getQuarterStatusesForIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);

    const client = await pool.connect();
    try {
      const quarterStatuses = await getQuarterStatuses(client, id);
      
      res.status(200).json({
        success: true,
        data: quarterStatuses,
      });
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  8. Fetch Resubmitted Indicators
// ─────────────────────────────────────────────────────────────────────────────

export const fetchResubmittedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT i.id
       FROM indicators i
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

    const data = await attachSubmissionsToIndicators(indicators);
    res.status(200).json({ success: true, count: data.length, data });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  9. Get Submissions for an Indicator
// ─────────────────────────────────────────────────────────────────────────────

export const getIndicatorSubmissions = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);

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
//  10. Get Admin-Approved Indicators
// ─────────────────────────────────────────────────────────────────────────────

export const getAdminApprovedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    /* ── Broaden the filter ────────────────────────────────────────
       Previously this only matched `rh.action = 'Verified'`, which is
       emitted by the legacy overall-approve path. Documents approved
       via the newer document-level or quarter-level flows emit
       'Document Approved' / 'Quarter Approved' instead, so those
       indicators were silently excluded. Now we accept all admin
       approval actions. */
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
       JOIN review_history rh ON rh.indicator_id = i.id
       LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
       LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
       WHERE rh.reviewer_role = 'admin'
         AND rh.action IN (
           'Verified',
           'Approved',
           'Document Approved',
           'Quarter Approved'
         )
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
//  11. Delete a Single Submission (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const deleteSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const indicatorId = getParamString(req.params.indicatorId);
    const submissionId = getParamString(req.params.submissionId);

    if (!indicatorId || !submissionId) {
      throw new AppError("Invalid parameter format. Expected single IDs.", 400);
    }

    const adminId = (req as any).user.id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await fetchAndLockIndicator(client, indicatorId);

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

      const { rows: docRows } = await client.query(
        `SELECT evidence_public_id
         FROM submission_documents
         WHERE submission_id = $1`,
        [submissionId],
      );
      const publicIds = docRows
        .map((r: any) => r.evidence_public_id)
        .filter(Boolean);

      /* ── Delete dependents in FK order ───────────────────────────
         submission_spot_check_links references submissions with
         ON DELETE RESTRICT (per the schema script), so it must be
         cleared before deleting the submission row itself. Otherwise
         the DELETE below can fail with a foreign key violation. */
      await client.query(
        `DELETE FROM submission_spot_check_links WHERE submission_id = $1`,
        [submissionId],
      );

      await client.query(
        `DELETE FROM submission_documents WHERE submission_id = $1`,
        [submissionId],
      );

      await client.query(`DELETE FROM submissions WHERE id = $1`, [
        submissionId,
      ]);

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, indicatorId);

      await client.query(
        `UPDATE indicators SET status = $1, progress = $2, updated_at = NOW() WHERE id = $3`,
        [indicatorStatus, overallProgress, indicatorId],
      );

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
        data: { 
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  12. Admin soft-deletes (marks as 'Deleted') a single document with a reason
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

      await fetchAndLockIndicator(client, indicatorId);

      await client.query(
        `UPDATE submission_documents
         SET status = 'Deleted',
             rejection_reason = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [reason.trim(), documentId],
      );

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

// ─────────────────────────────────────────────────────────────────────────────
//  13. Overall Approve Submission (Legacy - kept for compatibility)
// ─────────────────────────────────────────────────────────────────────────────

export const approveSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);
    const { submissionUpdates, adminOverallComments } = req.body;
    const adminId = (req as any).user.id;
    const adminName = (req as any).user.name;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indicator = await fetchAndLockIndicator(client, id);

      if (Array.isArray(submissionUpdates) && submissionUpdates.length > 0) {
        for (const update of submissionUpdates) {
          if (!update.submissionId) continue;
          await client.query(
            `UPDATE submissions
             SET review_status = 'Verified',
                 admin_comment = COALESCE($1, $2),
                 is_reviewed = true,
                 updated_at = NOW()
             WHERE id = $3
               AND review_status IN ('Pending', 'Correction Needed', 'Partially Approved')`,
            [
              update.adminComment?.trim(),
              adminOverallComments?.trim() || "Approved.",
              update.submissionId,
            ],
          );
        }
      }

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, id);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             admin_overall_comments = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [indicatorStatus, overallProgress, adminOverallComments?.trim() || "Approved by admin.", id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Verified', $2, 'admin', $3)`,
        [id, adminOverallComments?.trim() || "Approved by admin.", adminId],
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: "Submission(s) approved.",
        data: { 
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  14. Overall Reject Submission (Legacy - kept for compatibility)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const id = getParamString(req.params.id);
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
                 is_reviewed = true,
                 updated_at = NOW()
             WHERE id = $2
               AND review_status IN ('Pending', 'Correction Needed', 'Partially Approved')`,
            [
              update.adminComment?.trim() || adminOverallComments,
              update.submissionId,
            ],
          );
        }
      }

      const { indicatorStatus, overallProgress, quarterStatuses } = 
        await recalcIndicatorStatusFromQuarters(client, id);

      await client.query(
        `UPDATE indicators
         SET status = $1,
             progress = $2,
             admin_overall_comments = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [indicatorStatus, overallProgress, adminOverallComments, id],
      );

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Correction Requested', $2, 'admin', $3)`,
        [id, adminOverallComments, adminId],
      );

      await client.query("COMMIT");

      const taskTitle = indicator.instructions || "Performance Indicator";
      const year = new Date().getFullYear();
      const { assigneeName, assigneeEmail } = await resolveIndicatorAssignee(id);

      if (assigneeEmail) {
        sendMail({
          to: assigneeEmail,
          subject: "Submission Returned for Correction",
          html: submissionRejectedTemplate(
            assigneeName,
            taskTitle,
            indicator.reporting_cycle,
            indicator.active_quarter,
            year,
            "Admin",
            adminOverallComments,
          ),
        }).catch((err) =>
          console.error(`[rejectSubmission] Failed to send email to ${assigneeEmail}:`, err),
        );
      }

      res.status(200).json({
        success: true,
        message: "Submission returned for correction.",
        data: { 
          indicatorStatus,
          overallProgress,
          quarterStatuses,
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
//  15. GET Indicators Sent Back to Admin
// ─────────────────────────────────────────────────────────────────────────────

export const getSentBackIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
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
         jsonb_build_object('description', sa.description) AS activity,
         rh.at                             AS "sentBackAt",
         rh.reason                         AS "sentBackReason"
       FROM indicators i
       JOIN review_history rh ON rh.indicator_id = i.id
       LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
       LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
       WHERE rh.action = 'Sent Back to Admin'
         AND i.status = 'Awaiting Admin Approval'
       ORDER BY rh.at DESC`,
    );

    const ids = rows.map((r: any) => r.id);
    if (ids.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const data = await attachSubmissionsToIndicators(rows, {
      includeReviewHistory: true,
    });

    res.status(200).json({ success: true, count: data.length, data });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  16. GET Returned/Rejected Indicators (Admin)
// ─────────────────────────────────────────────────────────────────────────────

export const getReturnedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
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
         jsonb_build_object('description', sa.description) AS activity,
         s.review_status                   AS "submissionReviewStatus",
         s.submitted_at                    AS "lastSubmittedAt"
       FROM indicators i
       JOIN submissions s ON s.indicator_id = i.id
       LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
       LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
       WHERE s.review_status IN ('Rejected', 'Correction Needed')
          OR i.status IN ('Correction Needed', 'Rejected by Admin')
       ORDER BY s.submitted_at DESC`,
    );

    const ids = rows.map((r: any) => r.id);
    if (ids.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const data = await attachSubmissionsToIndicators(rows, {
      includeReviewHistory: true,
    });

    res.status(200).json({ success: true, count: data.length, data });
  },
);