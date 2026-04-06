import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { uploadMultipleToCloudinary } from "../../config/cloudinary";
import { sendMail } from "../../utils/sendMail";
import {
  submissionReceivedTemplate,
  adminReviewNeededTemplate,
} from "../../utils/mailTemplates";
import axios from "axios";

/**
 * SQL Fragment for the standard Indicator View with nested Submissions
 */
const USER_INDICATOR_BASE_QUERY = `
  SELECT 
    i.*,
    u.name as "assigneeName",
    ab.name as "assignedByName",
    sp.perspective,
    (SELECT json_build_object('title', title) FROM strategic_objectives WHERE id = i.objective_id) as objective,
    (SELECT json_build_object('description', description) FROM strategic_activities WHERE id = i.activity_id) as activity,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', s.id,
        'quarter', s.quarter,
        'notes', s.notes,
        'achievedValue', s.achieved_value,
        'reviewStatus', s.review_status,
        'submittedAt', s.submitted_at,
        'documents', (SELECT json_agg(d.*) FROM submission_documents d WHERE d.submission_id = s.id)
      )) FROM submissions s WHERE s.indicator_id = i.id), 
    '[]') as submissions
  FROM indicators i
  LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN users ab ON i.assigned_by = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

export const UserIndicatorController = {
  // 1. Get My Assignments (Direct + Team)
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.id;

    // Resolve user's team
    const userRes = await pool.query("SELECT team_id FROM users WHERE id = $1", [userId]);
    const teamId = userRes.rows[0]?.team_id;

    const query = `
      ${USER_INDICATOR_BASE_QUERY}
      WHERE (i.assignee_id = $1 AND i.assignee_model = 'User')
      ${teamId ? `OR (i.assignee_id = $2 AND i.assignee_model = 'Team')` : ""}
      ORDER BY i.updated_at DESC
    `;

    const params = teamId ? [userId, teamId] : [userId];
    const { rows } = await pool.query(query, params);

    res.status(200).json({
      success: true,
      results: rows.length,
      data: rows,
    });
  }),

  // 2. Submit / Resubmit Progress
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { notes, achievedValue } = req.body;
    const userId = (req as any).user.id;

    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Verify ownership and status
      const indRes = await client.query("SELECT * FROM indicators WHERE id = $1", [id]);
      const indicator = indRes.rows[0];

      if (!indicator) throw new AppError("Indicator not found.", 404);
      if (indicator.status === "Completed") throw new AppError("Filing period is closed.", 400);

      const targetQuarter = indicator.reporting_cycle === "Annual" ? 1 : indicator.active_quarter;

      // Check existing submission for this quarter
      const subRes = await client.query(
        "SELECT * FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [id, targetQuarter]
      );
      const existingSub = subRes.rows[0];

      if (existingSub && !["Rejected", "Pending"].includes(existingSub.review_status)) {
        throw new AppError(`Q${targetQuarter} submission is already under review.`, 400);
      }

      // Handle File Uploads
      const files = req.files as Express.Multer.File[];
      let newDocs: any[] = [];
      if (files?.length) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        newDocs = uploads.map((upload, i) => ({
          url: upload.secure_url,
          public_id: upload.public_id,
          file_type: upload.resource_type === "video" ? "video" : files[i].mimetype === "application/pdf" ? "raw" : "image",
          file_name: files[i].originalname
        }));
      }

      let submissionId: string;

      if (existingSub) {
        submissionId = existingSub.id;
        await client.query(
          `UPDATE submissions SET 
            notes = $1, achieved_value = $2, review_status = 'Pending', 
            is_reviewed = false, submitted_at = NOW(), resubmission_count = resubmission_count + 1
           WHERE id = $3`,
          [notes.trim(), achievedValue, submissionId]
        );
      } else {
        const newSub = await client.query(
          `INSERT INTO submissions (indicator_id, quarter, year, notes, achieved_value, review_status)
           VALUES ($1, $2, $3, $4, $5, 'Pending') RETURNING id`,
          [id, targetQuarter, new Date().getFullYear(), notes.trim(), achievedValue]
        );
        submissionId = newSub.rows[0].id;
      }

      // Bulk Insert Documents
      for (const doc of newDocs) {
        await client.query(
          `INSERT INTO submission_documents (submission_id, evidence_url, evidence_public_id, file_type, file_name)
           VALUES ($1, $2, $3, $4, $5)`,
          [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name]
        );
      }

      // Log History
      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, $2, $3, 'user', $4)`,
        [id, existingSub ? 'Resubmitted' : 'Submitted', `Filing for Q${targetQuarter}`, userId]
      );

      // Update indicator status
      await client.query("UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1", [id]);

      await client.query("COMMIT");

      // Async Alerts
      UserIndicatorController._sendAlerts((req as any).user, indicator, targetQuarter);

      res.status(201).json({ success: true, message: "Filing processed successfully." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // 3. Stream File (Proxy)
  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const url = decodeURIComponent(req.query.url as string);
    if (!url || !url.includes("cloudinary.com")) throw new AppError("Invalid file URL.", 400);

    const response = await axios({ method: "GET", url, responseType: "stream" });
    res.setHeader("Content-Type", response.headers["content-type"] || "application/octet-stream");
    res.setHeader("Content-Disposition", "inline");
    response.data.pipe(res);
  }),

  // Internal Helper
  _sendAlerts: async (user: any, indicator: any, q: number) => {
    try {
      const year = new Date().getFullYear();
      sendMail({
        to: user.email,
        subject: `Registry Filing: Q${q}`,
        html: submissionReceivedTemplate(user.name, indicator.instructions || "Indicator", q, year),
      });

      const admins = await pool.query("SELECT email, name FROM users WHERE role = 'admin' AND is_active = true");
      admins.rows.forEach((admin) => {
        sendMail({
          to: admin.email,
          subject: "Verification Required",
          html: adminReviewNeededTemplate(admin.name, user.name, indicator.instructions || "Indicator", q, year),
        });
      });
    } catch (e) {
      console.error("Alert Failure:", e);
    }
  },

  // Add these inside the UserIndicatorController object:

  // 1. Get Single Indicator Details (with User/Team Security)
  getIndicatorDetails: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).user.id;

    // Resolve user's team
    const userRes = await pool.query("SELECT team_id FROM users WHERE id = $1", [userId]);
    const teamId = userRes.rows[0]?.team_id;

    // We use the same base query but restrict by ID and Ownership
    const query = `
      ${USER_INDICATOR_BASE_QUERY}
      WHERE i.id = $1 
      AND (
        (i.assignee_id = $2 AND i.assignee_model = 'User')
        ${teamId ? `OR (i.assignee_id = $3 AND i.assignee_model = 'Team')` : ""}
      )
      LIMIT 1
    `;

    const params = teamId ? [id, userId, teamId] : [id, userId];
    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      throw new AppError("Indicator not found or you do not have access.", 404);
    }

    res.status(200).json({
      success: true,
      data: rows[0],
    });
  }),

  // 2. Add Documents to an existing submission
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { quarter } = req.body;
    const userId = (req as any).user.id;

    const files = req.files as Express.Multer.File[];
    if (!files?.length) throw new AppError("Files required.", 400);

    // 1. Verify indicator ownership
    const userRes = await pool.query("SELECT team_id FROM users WHERE id = $1", [userId]);
    const teamId = userRes.rows[0]?.team_id;

    const checkQuery = `
      SELECT id, active_quarter FROM indicators 
      WHERE id = $1 AND (
        (assignee_id = $2 AND assignee_model = 'User')
        ${teamId ? `OR (assignee_id = $3 AND assignee_model = 'Team')` : ""}
      )
    `;
    const checkParams = teamId ? [id, userId, teamId] : [id, userId];
    const indRes = await pool.query(checkQuery, checkParams);
    
    if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);

    const targetQ = Number(quarter) || indRes.rows[0].active_quarter;

    // 2. Find the submission for that quarter
    const subRes = await pool.query(
      "SELECT id, review_status FROM submissions WHERE indicator_id = $1 AND quarter = $2",
      [id, targetQ]
    );

    const submission = subRes.rows[0];
    if (!submission) throw new AppError("No submission found for that quarter.", 404);
    if (submission.review_status === "Accepted") {
      throw new AppError("Record is certified and cannot be modified.", 400);
    }

    // 3. Upload to Cloudinary and insert to DB
    const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
    const docRecords = [];

    for (const [i, upload] of uploads.entries()) {
      const result = await pool.query(
        `INSERT INTO submission_documents (submission_id, evidence_url, evidence_public_id, file_type, file_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          submission.id,
          upload.secure_url,
          upload.public_id,
          upload.resource_type === "video" ? "video" : files[i].mimetype === "application/pdf" ? "raw" : "image",
          files[i].originalname
        ]
      );
      docRecords.push(result.rows[0]);
    }

    res.status(200).json({ 
      success: true, 
      message: "Documents added successfully.",
      documents: docRecords 
    });
  }),
};