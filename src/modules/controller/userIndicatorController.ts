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
  // 1. Get My Assignments
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const teamRes = await pool.query("SELECT team_id FROM team_members WHERE user_id = $1", [userId]);
    const teamIds = teamRes.rows.map((r) => r.team_id);

    const query = `
      ${USER_INDICATOR_BASE_QUERY}
      WHERE (i.assignee_id = $1 AND i.assignee_model = 'User')
      ${teamIds.length > 0 ? `OR (i.assignee_id = ANY($2) AND i.assignee_model = 'Team')` : ""}
      ORDER BY i.updated_at DESC
    `;

    const params = teamIds.length > 0 ? [userId, teamIds] : [userId];
    const { rows } = await pool.query(query, params);

    res.status(200).json({ success: true, results: rows.length, data: rows });
  }),

 submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { notes, achievedValue } = req.body;
    const userId = (req as any).user.id;
    const files = req.files as Express.Multer.File[];

    if (!notes?.trim()) throw new AppError("Notes are required.", 400);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indRes = await client.query("SELECT * FROM indicators WHERE id = $1", [id]);
      const indicator = indRes.rows[0];
      if (!indicator) throw new AppError("Indicator not found.", 404);
      
      const targetQuarter = indicator.reporting_cycle === "Annual" ? 1 : indicator.active_quarter;

      const subRes = await client.query(
        "SELECT * FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [id, targetQuarter]
      );
      const existingSub = subRes.rows[0];

      // 1. Upload files and ensure secure_url exists
      let newDocs: any[] = [];
      if (files?.length) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        
        newDocs = uploads.map((upload, i) => {
          // Safeguard: Check for the URL before proceeding
          if (!upload.secure_url) {
            throw new AppError(`Failed to get URL for file: ${files[i].originalname}`, 500);
          }

          return {
            url: upload.secure_url,
            public_id: upload.public_id,
            file_type: upload.resource_type === "video" ? "video" : files[i].mimetype === "application/pdf" ? "raw" : "image",
            file_name: files[i].originalname
          };
        });
      }

      // 2. Insert/Update Submission
      let submissionId: string;
      if (existingSub) {
        submissionId = existingSub.id;
        await client.query(
          `UPDATE submissions SET notes = $1, achieved_value = $2, review_status = 'Pending', 
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

      // 3. Bulk Document Insert
      if (newDocs.length > 0) {
        const docInsertPromises = newDocs.map(doc => 
          client.query(
            `INSERT INTO submission_documents (submission_id, evidence_url, evidence_public_id, file_type, file_name)
             VALUES ($1, $2, $3, $4, $5)`,
            [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name]
          )
        );
        await Promise.all(docInsertPromises);
      }

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, $2, $3, 'user', $4)`,
        [id, existingSub ? 'Resubmitted' : 'Submitted', `Filing for Q${targetQuarter}`, userId]
      );

      await client.query("UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1", [id]);
      
      await client.query("COMMIT");

      UserIndicatorController._sendAlerts((req as any).user, indicator, targetQuarter);
      res.status(201).json({ success: true, message: "Filing processed successfully." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  getIndicatorDetails: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).user.id;

    const teamRes = await pool.query("SELECT team_id FROM team_members WHERE user_id = $1", [userId]);
    const teamIds = teamRes.rows.map((r) => r.team_id);

    const query = `
      ${USER_INDICATOR_BASE_QUERY}
      WHERE i.id = $1 AND (
        (i.assignee_id = $2 AND i.assignee_model = 'User')
        ${teamIds.length > 0 ? `OR (i.assignee_id = ANY($3) AND i.assignee_model = 'Team')` : ""}
      ) LIMIT 1
    `;

    const params = teamIds.length > 0 ? [id, userId, teamIds] : [id, userId];
    const { rows } = await pool.query(query, params);

    if (rows.length === 0) throw new AppError("Access denied or record missing.", 404);
    res.status(200).json({ success: true, data: rows[0] });
  }),

  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { quarter } = req.body;
    const userId = (req as any).user.id;
    const files = req.files as Express.Multer.File[];

    if (!files?.length) throw new AppError("No files provided.", 400);

    const teamRes = await pool.query("SELECT team_id FROM team_members WHERE user_id = $1", [userId]);
    const teamIds = teamRes.rows.map(r => r.team_id);

    const checkQuery = `
      SELECT id, active_quarter FROM indicators 
      WHERE id = $1 AND (
        (assignee_id = $2 AND assignee_model = 'User')
        ${teamIds.length > 0 ? `OR (assignee_id = ANY($3) AND i.assignee_model = 'Team')` : ""}
      )
    `;
    const checkParams = teamIds.length > 0 ? [id, userId, teamIds] : [id, userId];
    const indRes = await pool.query(checkQuery, checkParams);
    
    if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);

    const targetQ = Number(quarter) || indRes.rows[0].active_quarter;
    const subRes = await pool.query("SELECT id, review_status FROM submissions WHERE indicator_id = $1 AND quarter = $2", [id, targetQ]);
    const submission = subRes.rows[0];

    if (!submission) throw new AppError("No submission found for this quarter.", 404);
    if (submission.review_status === "Accepted") throw new AppError("Certified records are locked.", 400);

    const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
    
    const docInsertPromises = uploads.map((upload, i) => 
      pool.query(
        `INSERT INTO submission_documents (submission_id, evidence_url, evidence_public_id, file_type, file_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          submission.id,
          upload.secure_url,
          upload.public_id,
          upload.resource_type === "video" ? "video" : files[i].mimetype === "application/pdf" ? "raw" : "image",
          files[i].originalname
        ]
      )
    );

    const results = await Promise.all(docInsertPromises);
    res.status(200).json({ 
      success: true, 
      message: `${files.length} documents attached.`,
      documents: results.map(r => r.rows[0]) 
    });
  }),

  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const url = decodeURIComponent(req.query.url as string);
    if (!url || !url.includes("cloudinary.com")) throw new AppError("Invalid source.", 400);
    const response = await axios({ method: "GET", url, responseType: "stream" });
    res.setHeader("Content-Type", response.headers["content-type"] || "application/octet-stream");
    response.data.pipe(res);
  }),

  _sendAlerts: async (user: any, indicator: any, q: number) => {
    try {
      const year = new Date().getFullYear();
      sendMail({
        to: user.email,
        subject: `Filing Confirmation: Q${q}`,
        html: submissionReceivedTemplate(user.name, indicator.instructions || "Indicator", q, year),
      });

      const admins = await pool.query("SELECT email, name FROM users WHERE role = 'admin' AND is_active = true");
      admins.rows.forEach((admin) => {
        sendMail({
          to: admin.email,
          subject: "Filing Awaiting Review",
          html: adminReviewNeededTemplate(admin.name, user.name, indicator.instructions || "Indicator", q, year),
        });
      });
    } catch (e) {
      console.error("Mail Alert Error:", e);
    }
  },
};