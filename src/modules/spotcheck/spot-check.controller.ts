// src/controllers/spot-check.controller.ts
//
// HTTP layer for the Spot Check module.
//
// Responsibilities:
//   1. Read req.body / req.params / req.files
//   2. Validate via spot-check.validator
//   3. Upload new files to Cloudinary (via utils/cloudinary)
//   4. Call into spot-check.service
//   5. Shape the JSON response
//
// No SQL lives here. No Cloudinary config lives here. The controller is
// intentionally a thin orchestration layer.

import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  uploadMultipleToCloudinary,
  deleteFromCloudinary,
} from "../../config/cloudinary";
import {
  createSpotCheck as createSpotCheckService,
  getSpotCheckById,
  listSpotChecks,
  updateSpotCheck as updateSpotCheckService,
  softDeleteSpotCheck,
  softDeleteSpotCheckDocument,
  listLibrary,
  linkSpotCheckDocumentsToSubmission,
  unlinkSpotCheckDocumentsFromSubmission,
  listSubmissionSpotCheckLinks,
} from "./spot-check.service";
import {
  validateCreateSpotCheck,
  validateUpdateSpotCheck,
  validateDeleteSpotCheckDocument,
  validateLibraryFilters,
  validateSpotCheckListFilters,
  validateLinkSpotCheckDocuments,
  validateUnlinkSpotCheckDocuments,
  validateUUIDParam,
} from "./spot-check.validator";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";

/* ────────────────────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Classify a mimetype into our coarse `fileType` field used by the UI
 * to pick an icon and decide how to preview the file.
 */
function deriveFileType(mimetype: string): string {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  return "document";
}

/**
 * The Cloudinary folder layout for a spot check.
 * Grouped by station + date so the Cloudinary console stays navigable.
 * Sanitize to keep the path URL-safe.
 */
function buildCloudinaryFolder(station: string, visitDate: string): string {
  const safeStation = station
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return `spot-checks/${safeStation || "unknown"}/${visitDate}`;
}

/**
 * Upload files and return the shape the service expects.
 * Throws if there are no files — the validator already enforces this
 * for create, but we keep the guard for update too.
 */
async function uploadFiles(
  files: Express.Multer.File[],
  folder: string
) {
  if (files.length === 0) return [];

  const uploaded = await uploadMultipleToCloudinary(files, folder);

  return uploaded.map((result, i) => {
    const original = files[i];
    return {
      evidenceUrl: result.secure_url,
      evidencePublicId: result.public_id,
      fileType: deriveFileType(original.mimetype),
      fileName: original.originalname,
      mimeType: original.mimetype,
      sizeBytes: original.size,
    };
  });
}

/**
 * Ensure a submission exists for the given (indicator, quarter, year) tuple.
 * Called by the link endpoint when the client wants to attach spot-check
 * documents to a submission that hasn't been created yet.
 *
 * Returns the submission ID.
 */
async function ensureSubmissionForLink(input: {
  indicatorId: string;
  quarter: number;
  year: number;
  userId: string;
}): Promise<string> {
  const { indicatorId, quarter, year, userId } = input;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* If a submission already exists for this period, return it. */
    const existing = await client.query(
      `SELECT id FROM submissions
       WHERE indicator_id = $1 AND quarter = $2 AND year = $3
       ORDER BY submitted_at DESC
       LIMIT 1
       FOR UPDATE`,
      [indicatorId, quarter, year]
    );

    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return existing.rows[0].id as string;
    }

    /* Verify the indicator exists and get its status. */
    const indRes = await client.query(
      `SELECT id, status FROM indicators WHERE id = $1 FOR UPDATE`,
      [indicatorId]
    );

    if (indRes.rows.length === 0) {
      throw new AppError("Indicator not found.", 404);
    }

    const indicator = indRes.rows[0] as { id: string; status: string };

    /* Create an empty submission with achieved_value = 0 (NOT NULL safe). */
    const inserted = await client.query(
      `INSERT INTO submissions
         (indicator_id, quarter, year, achieved_value, notes,
          review_status, submitted_by, resubmission_count, is_reviewed)
       VALUES ($1, $2, $3, 0, NULL, 'Pending', $4, 0, false)
       RETURNING id`,
      [indicatorId, quarter, year, userId]
    );

    const submissionId = inserted.rows[0].id as string;

    /* Nudge the indicator into a review state so it surfaces in queues. */
    if (indicator.status !== "Completed") {
      await client.query(
        `UPDATE indicators
         SET status = 'Awaiting Admin Approval', updated_at = NOW()
         WHERE id = $1`,
        [indicatorId]
      );
    }

    await client.query("COMMIT");
    return submissionId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   1. POST /spot-checks
      Create a new spot check with attached files.
   ──────────────────────────────────────────────────────────────────────────── */

export const createSpotCheck = asyncHandler(
  async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const validated = validateCreateSpotCheck(req.body, files.length);

    const folder = buildCloudinaryFolder(
      validated.station,
      validated.visitDate
    );

    const uploadedFiles = await uploadFiles(files, folder);

    try {
      const data = await createSpotCheckService({
        validated,
        uploadedBy: (req as any).user.id,
        files: uploadedFiles,
      });

      res.status(201).json({
        success: true,
        message: "Spot check created successfully.",
        data,
      });
    } catch (err) {
      /* If the DB write fails, best-effort cleanup of the just-uploaded
         Cloudinary assets so we don't leave orphans behind. */
      await Promise.allSettled(
        uploadedFiles.map((f) => deleteFromCloudinary(f.evidencePublicId))
      );
      throw err;
    }
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   2. GET /spot-checks
      List spot checks with filters + pagination.
   ──────────────────────────────────────────────────────────────────────────── */

export const getSpotChecks = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = validateSpotCheckListFilters(req.query);

    const { count, data } = await listSpotChecks(filters);

    res.status(200).json({
      success: true,
      count,
      page: filters.page,
      pageSize: filters.pageSize,
      data,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   3. GET /spot-checks/:id
      Fetch one spot check with its documents.
   ──────────────────────────────────────────────────────────────────────────── */

export const getSpotCheck = asyncHandler(
  async (req: Request, res: Response) => {
    const id = validateUUIDParam(req.params.id, "spotCheckId");

    const data = await getSpotCheckById(id);

    res.status(200).json({
      success: true,
      data,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   4. PATCH /spot-checks/:id
      Update metadata and optionally append new files.
   ──────────────────────────────────────────────────────────────────────────── */

export const updateSpotCheck = asyncHandler(
  async (req: Request, res: Response) => {
    const id = validateUUIDParam(req.params.id, "spotCheckId");

    const files = (req.files as Express.Multer.File[]) ?? [];
    const validated = validateUpdateSpotCheck(req.body, files.length);

    /* If neither metadata nor new files were provided, there's nothing to do. */
    const hasMetadata =
      validated.station !== undefined ||
      validated.visitDate !== undefined ||
      validated.description !== undefined;

    if (!hasMetadata && files.length === 0) {
      throw new AppError(
        "No changes provided. Send at least one field or upload a file.",
        400
      );
    }

    /* Fetch the existing record so we can derive the Cloudinary folder
       from its station + date (which is what the original used). */
    const existing = await getSpotCheckById(id);

    const folder = buildCloudinaryFolder(
      validated.station ?? existing.station,
      validated.visitDate ?? existing.visitDate
    );

    const uploadedFiles = await uploadFiles(files, folder);

    try {
      const data = await updateSpotCheckService({
        id,
        validated,
        updatedBy: (req as any).user.id,
        newFiles: uploadedFiles,
      });

      res.status(200).json({
        success: true,
        message: "Spot check updated successfully.",
        data,
      });
    } catch (err) {
      await Promise.allSettled(
        uploadedFiles.map((f) => deleteFromCloudinary(f.evidencePublicId))
      );
      throw err;
    }
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   5. DELETE /spot-checks/:id
      Soft-delete a spot check and all its documents.
      Refuses if any document is linked to a submission.
   ──────────────────────────────────────────────────────────────────────────── */

export const deleteSpotCheck = asyncHandler(
  async (req: Request, res: Response) => {
    const id = validateUUIDParam(req.params.id, "spotCheckId");

    const result = await softDeleteSpotCheck(id, (req as any).user.id);

    res.status(200).json({
      success: true,
      message: "Spot check deleted.",
      data: result,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   6. DELETE /spot-checks/documents/:documentId
      Soft-delete one document.
      Refuses if the document is linked to a submission.
   ──────────────────────────────────────────────────────────────────────────── */

export const deleteSpotCheckDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const documentId = validateUUIDParam(
      req.params.documentId,
      "documentId"
    );

    const { reason } = validateDeleteSpotCheckDocument({
      documentId,
      reason: req.body?.reason,
    });

    const result = await softDeleteSpotCheckDocument(
      documentId,
      reason,
      (req as any).user.id
    );

    res.status(200).json({
      success: true,
      message: "Document removed from the library.",
      data: result,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   7. GET /spot-checks/library
      Flat list for the submission-page picker.
   ──────────────────────────────────────────────────────────────────────────── */

export const getSpotCheckLibrary = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = validateLibraryFilters(req.query);

    const { count, data } = await listLibrary(filters);

    res.status(200).json({
      success: true,
      count,
      page: filters.page,
      pageSize: filters.pageSize,
      data,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   8. POST /submissions/:submissionId/spot-check-links
      Attach selected library documents to a submission.

      If `submissionId` is not a valid UUID, or the body carries
      `indicatorId` + `quarter` + `year` and the submission does not yet
      exist, we create an empty submission on the fly. This lets the
      frontend call this endpoint as the *only* step when the user picked
      spot-check docs without uploading any files.
   ──────────────────────────────────────────────────────────────────────────── */

export const linkSpotCheckDocuments = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;

    /* Validate the picked document IDs first — cheap failure if bad. */
    const { spotCheckDocumentIds } = validateLinkSpotCheckDocuments(
      req.body
    );

    /* Resolve the target submission ID.
       Path param may be a real UUID, or the literal "new". If it's not a
       UUID and the caller provided the indicator coordinates, we create
       the submission ourselves. */
    let submissionId = String(req.params.submissionId ?? "").trim();
    let createdNew = false;

    const looksLikeUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        submissionId
      );

    if (!looksLikeUUID) {
      const { indicatorId, quarter, year } = req.body;

      if (!indicatorId || quarter === undefined || year === undefined) {
        throw new AppError(
          "submissionId must be a valid UUID, or provide indicatorId, quarter, and year to create one.",
          400
        );
      }

      submissionId = await ensureSubmissionForLink({
        indicatorId: validateUUIDParam(indicatorId, "indicatorId"),
        quarter: Number(quarter),
        year: Number(year),
        userId,
      });

      createdNew = true;
    }

    /* Insert the links. */
    const result = await linkSpotCheckDocumentsToSubmission({
      submissionId,
      spotCheckDocumentIds,
      linkedBy: userId,
    });

    /* Fetch the full, merged submission so the client can render it
       immediately without a second round-trip. */
    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.indicator_id     AS "indicatorId",
         s.quarter,
         s.year,
         s.notes,
         s.achieved_value   AS "achievedValue",
         s.review_status    AS "reviewStatus",
         s.admin_comment    AS "adminComment",
         s.resubmission_count AS "resubmissionCount",
         s.submitted_at     AS "submittedAt",
         s.is_reviewed      AS "isReviewed",
         (
           SELECT COALESCE(
             json_agg(doc_row.doc_json ORDER BY doc_row.uploaded_at DESC),
             '[]'::json
           )
           FROM (
             SELECT
               json_build_object(
                 'id',              d.id,
                 'evidenceUrl',     d.evidence_url,
                 'fileType',        d.file_type,
                 'fileName',        d.file_name,
                 'description',     d.description,
                 'status',          d.status,
                 'rejectionReason', d.rejection_reason,
                 'source',          'own'
               ) AS doc_json,
               d.uploaded_at
             FROM submission_documents d
             WHERE d.submission_id = s.id AND d.deleted_at IS NULL

             UNION ALL

             SELECT
               json_build_object(
                 'id',              l.id,
                 'evidenceUrl',     l.evidence_url,
                 'fileType',        l.file_type,
                 'fileName',        l.file_name,
                 'description',     l.description,
                 'status',          'Approved',
                 'rejectionReason', NULL,
                 'source',          'spot-check',
                 'linkedAt',        l.linked_at
               ) AS doc_json,
               l.linked_at AS uploaded_at
             FROM submission_spot_check_links l
             WHERE l.submission_id = s.id
           ) doc_row
         ) AS documents
       FROM submissions s
       WHERE s.id = $1`,
      [submissionId]
    );

    const submission = rows[0] ?? null;

    res.status(200).json({
      success: true,
      message:
        result.linked.length === 0
          ? "No new documents linked (all were already attached)."
          : createdNew
            ? `Submission created and ${result.linked.length} document(s) linked.`
            : `${result.linked.length} document(s) linked to submission.`,
      submissionId,
      data: {
        ...result,
        submission,
      },
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   9. DELETE /submissions/:submissionId/spot-check-links
      Detach selected documents from a submission.
   ──────────────────────────────────────────────────────────────────────────── */

export const unlinkSpotCheckDocuments = asyncHandler(
  async (req: Request, res: Response) => {
    const submissionId = validateUUIDParam(
      req.params.submissionId,
      "submissionId"
    );

    const { spotCheckDocumentIds } = validateUnlinkSpotCheckDocuments(
      req.body
    );

    const result = await unlinkSpotCheckDocumentsFromSubmission({
      submissionId,
      spotCheckDocumentIds,
    });

    res.status(200).json({
      success: true,
      message:
        result.unlinked === 0
          ? "No documents were linked to this submission."
          : `${result.unlinked} document(s) unlinked from submission.`,
      data: result,
    });
  }
);

/* ────────────────────────────────────────────────────────────────────────────
   10. GET /submissions/:submissionId/spot-check-links
       List all library documents currently attached to a submission.
   ──────────────────────────────────────────────────────────────────────────── */

export const getSubmissionSpotCheckLinks = asyncHandler(
  async (req: Request, res: Response) => {
    const submissionId = validateUUIDParam(
      req.params.submissionId,
      "submissionId"
    );

    const data = await listSubmissionSpotCheckLinks(submissionId);

    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  }
);