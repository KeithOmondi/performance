// src/services/spot-check.service.ts
//
// Data-access layer for the Spot Check module.
// The controller calls these functions; nothing here touches req/res.
// All functions take and return plain shapes so the controller can decide
// how to serialize them.

import { pool } from "../../config/db";
import { AppError } from "../../utils/AppError";
import {
  type ISpotCheck,
  type ISpotCheckLibraryItem,
  type ISubmissionSpotCheckLink,
  type SpotCheckRow,
  type SpotCheckDocumentRow,
  type SubmissionSpotCheckLinkRow,
  mapSpotCheckRow,
  mapSubmissionSpotCheckLinkRow,
} from "./spot-check.types";
import {
  type ValidatedCreateSpotCheck,
  type ValidatedUpdateSpotCheck,
  type ValidatedLibraryFilters,
  type ValidatedSpotCheckListFilters,
} from "./spot-check.validator";

/* ────────────────────────────────────────────────────────────────────────────
   SHARED SQL FRAGMENTS
   ──────────────────────────────────────────────────────────────────────────── */

const SPOT_CHECK_SELECT = `
  SELECT
    sc.id,
    sc.station,
    sc.station_id,
    sc.visit_date,
    sc.description,
    sc.status,
    sc.created_by,
    u.name    AS created_by_name,
    sc.created_at,
    sc.updated_at,
    sc.deleted_at
  FROM spot_checks sc
  LEFT JOIN users u ON u.id = sc.created_by
`;

const SPOT_CHECK_DOCUMENT_SELECT = `
  SELECT
    d.id,
    d.spot_check_id,
    d.evidence_url,
    d.evidence_public_id,
    d.file_type,
    d.file_name,
    d.mime_type,
    d.size_bytes,
    d.description,
    d.uploaded_at,
    d.uploaded_by,
    d.status,
    d.deleted_at
  FROM spot_check_documents d
`;

const SUBMISSION_LINK_SELECT = `
  SELECT
    l.id,
    l.submission_id,
    l.spot_check_document_id,
    l.evidence_url,
    l.evidence_public_id,
    l.file_name,
    l.file_type,
    l.description,
    l.linked_at,
    l.linked_by
  FROM submission_spot_check_links l
`;

/* ────────────────────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Group a flat list of documents by their parent spot_check_id.
 */
function groupDocumentsByCheck(
  docs: SpotCheckDocumentRow[]
): Map<string, SpotCheckDocumentRow[]> {
  const map = new Map<string, SpotCheckDocumentRow[]>();
  for (const d of docs) {
    const list = map.get(d.spot_check_id) ?? [];
    list.push(d);
    map.set(d.spot_check_id, list);
  }
  return map;
}

/* ────────────────────────────────────────────────────────────────────────────
   1. LIBRARY — CREATE
   ──────────────────────────────────────────────────────────────────────────── */

export interface CreateSpotCheckServiceInput {
  validated: ValidatedCreateSpotCheck;
  uploadedBy: string;
  files: Array<{
    evidenceUrl: string;
    evidencePublicId: string;
    fileType: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
}

/**
 * Insert a spot check and its documents in a single transaction.
 * Returns the fully-hydrated spot check.
 */
export async function createSpotCheck(
  input: CreateSpotCheckServiceInput
): Promise<ISpotCheck> {
  const { validated, uploadedBy, files } = input;

  if (files.length === 0) {
    throw new AppError("At least one document is required.", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Insert the spot check header */
    const { rows: checkRows } = await client.query(
      `INSERT INTO spot_checks
         (station, station_id, visit_date, description, status, created_by)
       VALUES ($1, $2, $3, $4, 'Submitted', $5)
       RETURNING id`,
      [
        validated.station,
        null, // stationId reserved for future lookup table
        validated.visitDate,
        validated.description,
        uploadedBy,
      ]
    );

    const spotCheckId = checkRows[0].id;

    /* Insert each document */
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const description =
        validated.documentDescriptions[i]?.trim() || null;

      await client.query(
        `INSERT INTO spot_check_documents
           (spot_check_id, evidence_url, evidence_public_id,
            file_type, file_name, mime_type, size_bytes,
            description, uploaded_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Active')`,
        [
          spotCheckId,
          f.evidenceUrl,
          f.evidencePublicId,
          f.fileType,
          f.fileName,
          f.mimeType ?? null,
          f.sizeBytes ?? null,
          description,
          uploadedBy,
        ]
      );
    }

    await client.query("COMMIT");

    /* Re-fetch to return the canonical record */
    return await getSpotCheckById(spotCheckId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   2. LIBRARY — READ (single)
   ──────────────────────────────────────────────────────────────────────────── */

export async function getSpotCheckById(id: string): Promise<ISpotCheck> {
  const { rows: checkRows } = await pool.query(
    `${SPOT_CHECK_SELECT} WHERE sc.id = $1 AND sc.deleted_at IS NULL`,
    [id]
  );

  if (checkRows.length === 0) {
    throw new AppError("Spot check not found.", 404);
  }

  const { rows: docRows } = await pool.query(
    `${SPOT_CHECK_DOCUMENT_SELECT}
     WHERE d.spot_check_id = $1
       AND d.deleted_at IS NULL
       AND d.status = 'Active'
     ORDER BY d.uploaded_at ASC`,
    [id]
  );

  return mapSpotCheckRow(
    checkRows[0] as SpotCheckRow,
    docRows as SpotCheckDocumentRow[]
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   3. LIBRARY — READ (list)
   ──────────────────────────────────────────────────────────────────────────── */

export interface ListSpotChecksResult {
  count: number;
  data: ISpotCheck[];
}

export async function listSpotChecks(
  filters: ValidatedSpotCheckListFilters
): Promise<ListSpotChecksResult> {
  const where: string[] = ["sc.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (filters.station) {
    params.push(`%${filters.station}%`);
    where.push(`sc.station ILIKE $${params.length}`);
  }

  if (filters.fromDate) {
    params.push(filters.fromDate);
    where.push(`sc.visit_date >= $${params.length}`);
  }

  if (filters.toDate) {
    params.push(filters.toDate);
    where.push(`sc.visit_date <= $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    where.push(
      `(sc.description ILIKE $${idx} OR sc.station ILIKE $${idx})`
    );
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;

  /* Count */
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM spot_checks sc ${whereClause}`,
    params
  );
  const count = countRows[0]?.count ?? 0;

  /* Page */
  const offset = (filters.page - 1) * filters.pageSize;
  params.push(filters.pageSize, offset);

  const { rows: checkRows } = await pool.query(
    `${SPOT_CHECK_SELECT}
     ${whereClause}
     ORDER BY sc.visit_date DESC, sc.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  if (checkRows.length === 0) {
    return { count, data: [] };
  }

  /* Fetch all documents for the paged checks in one query */
  const ids = checkRows.map((r: SpotCheckRow) => r.id);
  const { rows: docRows } = await pool.query(
    `${SPOT_CHECK_DOCUMENT_SELECT}
     WHERE d.spot_check_id = ANY($1)
       AND d.deleted_at IS NULL
       AND d.status = 'Active'
     ORDER BY d.uploaded_at ASC`,
    [ids]
  );

  const grouped = groupDocumentsByCheck(docRows as SpotCheckDocumentRow[]);

  const data = checkRows.map((row: SpotCheckRow) =>
    mapSpotCheckRow(row, grouped.get(row.id) ?? [])
  );

  return { count, data };
}

/* ────────────────────────────────────────────────────────────────────────────
   4. LIBRARY — UPDATE
   ──────────────────────────────────────────────────────────────────────────── */

export interface UpdateSpotCheckServiceInput {
  id: string;
  validated: ValidatedUpdateSpotCheck;
  updatedBy: string;
  newFiles?: Array<{
    evidenceUrl: string;
    evidencePublicId: string;
    fileType: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
}

export async function updateSpotCheck(
  input: UpdateSpotCheckServiceInput
): Promise<ISpotCheck> {
  const { id, validated, updatedBy, newFiles = [] } = input;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Lock the spot check row */
    const { rows: lockRows } = await client.query(
      `SELECT id FROM spot_checks
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [id]
    );
    if (lockRows.length === 0) {
      throw new AppError("Spot check not found.", 404);
    }

    /* Update metadata only if something changed */
    const sets: string[] = [];
    const params: unknown[] = [];

    if (validated.station !== undefined) {
      params.push(validated.station);
      sets.push(`station = $${params.length}`);
    }
    if (validated.visitDate !== undefined) {
      params.push(validated.visitDate);
      sets.push(`visit_date = $${params.length}`);
    }
    if (validated.description !== undefined) {
      params.push(validated.description);
      sets.push(`description = $${params.length}`);
    }

    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      params.push(id);
      await client.query(
        `UPDATE spot_checks SET ${sets.join(", ")}
         WHERE id = $${params.length}`,
        params
      );
    }

    /* Insert any new files */
    if (newFiles.length > 0) {
      const descriptions = validated.documentDescriptions ?? [];

      for (let i = 0; i < newFiles.length; i++) {
        const f = newFiles[i];
        const description = descriptions[i]?.trim() || null;

        await client.query(
          `INSERT INTO spot_check_documents
             (spot_check_id, evidence_url, evidence_public_id,
              file_type, file_name, mime_type, size_bytes,
              description, uploaded_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Active')`,
          [
            id,
            f.evidenceUrl,
            f.evidencePublicId,
            f.fileType,
            f.fileName,
            f.mimeType ?? null,
            f.sizeBytes ?? null,
            description,
            updatedBy,
          ]
        );
      }
    }

    await client.query("COMMIT");

    return await getSpotCheckById(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   5. LIBRARY — DELETE (soft) SPOT CHECK
   ──────────────────────────────────────────────────────────────────────────── */

export async function softDeleteSpotCheck(
  id: string,
  _deletedBy: string
): Promise<{ id: string; documentsAffected: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: checkRows } = await client.query(
      `SELECT id FROM spot_checks
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [id]
    );
    if (checkRows.length === 0) {
      throw new AppError("Spot check not found.", 404);
    }

    /* Prevent deletion if any document is linked to a submission */
    const { rows: linked } = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM submission_spot_check_links l
       JOIN spot_check_documents d ON d.id = l.spot_check_document_id
       WHERE d.spot_check_id = $1`,
      [id]
    );
    const linkCount = linked[0]?.count ?? 0;
    if (linkCount > 0) {
      throw new AppError(
        `Cannot delete: ${linkCount} document(s) from this spot check are attached to submissions. Unlink them first.`,
        409
      );
    }

    /* Soft-delete the spot check and all its documents */
    await client.query(
      `UPDATE spot_checks SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    const { rowCount: docCount } = await client.query(
      `UPDATE spot_check_documents
       SET status = 'Deleted', deleted_at = NOW()
       WHERE spot_check_id = $1 AND deleted_at IS NULL`,
      [id]
    );

    await client.query("COMMIT");

    return { id, documentsAffected: docCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   6. LIBRARY — SOFT DELETE ONE DOCUMENT
   ──────────────────────────────────────────────────────────────────────────── */

export async function softDeleteSpotCheckDocument(
  documentId: string,
  reason: string | undefined,
  _deletedBy: string
): Promise<{ documentId: string; spotCheckId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: docRows } = await client.query(
      `SELECT id, spot_check_id, status
       FROM spot_check_documents
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [documentId]
    );

    if (docRows.length === 0) {
      throw new AppError("Document not found or already deleted.", 404);
    }

    const doc = docRows[0];

    /* Prevent deletion if linked to a submission */
    const { rows: linked } = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM submission_spot_check_links
       WHERE spot_check_document_id = $1`,
      [documentId]
    );
    if ((linked[0]?.count ?? 0) > 0) {
      throw new AppError(
        "Cannot delete: this document is attached to a submission. Unlink it first.",
        409
      );
    }

    await client.query(
      `UPDATE spot_check_documents
       SET status = 'Deleted',
           deleted_at = NOW(),
           description = COALESCE(description, $1)
       WHERE id = $2`,
      [reason ?? null, documentId]
    );

    await client.query("COMMIT");

    return { documentId, spotCheckId: doc.spot_check_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   7. LIBRARY PICKER — flat list for the submission page
   ──────────────────────────────────────────────────────────────────────────── */

export interface ListLibraryResult {
  count: number;
  data: ISpotCheckLibraryItem[];
}

export async function listLibrary(
  filters: ValidatedLibraryFilters
): Promise<ListLibraryResult> {
  const where: string[] = [
    "sc.deleted_at IS NULL",
    "d.deleted_at IS NULL",
    "d.status = 'Active'",
  ];
  const params: unknown[] = [];

  if (filters.station) {
    params.push(`%${filters.station}%`);
    where.push(`sc.station ILIKE $${params.length}`);
  }

  if (filters.fromDate) {
    params.push(filters.fromDate);
    where.push(`sc.visit_date >= $${params.length}`);
  }

  if (filters.toDate) {
    params.push(filters.toDate);
    where.push(`sc.visit_date <= $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    where.push(
      `(sc.description ILIKE $${idx}
        OR d.file_name ILIKE $${idx}
        OR d.description ILIKE $${idx})`
    );
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;

  /* Count */
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM spot_check_documents d
     JOIN spot_checks sc ON sc.id = d.spot_check_id
     ${whereClause}`,
    params
  );
  const count = countRows[0]?.count ?? 0;

  /* Page */
  const offset = (filters.page - 1) * filters.pageSize;
  params.push(filters.pageSize, offset);

  const { rows } = await pool.query(
    `SELECT
       d.id              AS "documentId",
       d.evidence_url    AS "evidenceUrl",
       d.evidence_public_id AS "evidencePublicId",
       d.file_name       AS "fileName",
       d.file_type       AS "fileType",
       d.description     AS "description",
       d.uploaded_at     AS "uploadedAt",
       sc.id             AS "spotCheckId",
       sc.station        AS "station",
       sc.visit_date     AS "visitDate",
       sc.description    AS "spotCheckDescription"
     FROM spot_check_documents d
     JOIN spot_checks sc ON sc.id = d.spot_check_id
     ${whereClause}
     ORDER BY sc.visit_date DESC, d.uploaded_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    count,
    data: rows as ISpotCheckLibraryItem[],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   8. LINK — attach spot-check documents to a submission
   ──────────────────────────────────────────────────────────────────────────── */

export interface LinkDocumentsResult {
  linked: ISubmissionSpotCheckLink[];
  skipped: string[]; // ids that were already linked
}

export async function linkSpotCheckDocumentsToSubmission(input: {
  submissionId: string;
  spotCheckDocumentIds: string[];
  linkedBy: string;
}): Promise<LinkDocumentsResult> {
  const { submissionId, spotCheckDocumentIds, linkedBy } = input;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Verify submission exists and lock it */
    const { rows: subRows } = await client.query(
      `SELECT id FROM submissions WHERE id = $1 FOR UPDATE`,
      [submissionId]
    );
    if (subRows.length === 0) {
      throw new AppError("Submission not found.", 404);
    }

    /* Load documents in one query, keeping only active ones */
    const { rows: docRows } = await client.query(
      `SELECT
         d.id,
         d.evidence_url,
         d.evidence_public_id,
         d.file_name,
         d.file_type,
         d.description
       FROM spot_check_documents d
       WHERE d.id = ANY($1)
         AND d.deleted_at IS NULL
         AND d.status = 'Active'`,
      [spotCheckDocumentIds]
    );

    const foundIds = new Set(docRows.map((d: any) => d.id));
    const missing = spotCheckDocumentIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new AppError(
        `Some documents were not found or are no longer active: ${missing.join(", ")}`,
        400
      );
    }

    /* Insert links, ignoring ones that already exist */
    const linked: ISubmissionSpotCheckLink[] = [];
    const skipped: string[] = [];

    for (const doc of docRows) {
      const { rows } = await client.query(
        `INSERT INTO submission_spot_check_links
           (submission_id, spot_check_document_id,
            evidence_url, evidence_public_id,
            file_name, file_type, description, linked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (submission_id, spot_check_document_id) DO NOTHING
         RETURNING
           id, submission_id, spot_check_document_id,
           evidence_url, evidence_public_id,
           file_name, file_type, description, linked_at, linked_by`,
        [
          submissionId,
          doc.id,
          doc.evidence_url,
          doc.evidence_public_id,
          doc.file_name,
          doc.file_type,
          doc.description,
          linkedBy,
        ]
      );

      if (rows.length === 0) {
        skipped.push(doc.id);
      } else {
        linked.push(
          mapSubmissionSpotCheckLinkRow(
            rows[0] as SubmissionSpotCheckLinkRow
          )
        );
      }
    }

    await client.query("COMMIT");

    return { linked, skipped };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   9. LINK — detach
   ──────────────────────────────────────────────────────────────────────────── */

export async function unlinkSpotCheckDocumentsFromSubmission(input: {
  submissionId: string;
  spotCheckDocumentIds: string[];
}): Promise<{ unlinked: number }> {
  const { submissionId, spotCheckDocumentIds } = input;

  const { rowCount } = await pool.query(
    `DELETE FROM submission_spot_check_links
     WHERE submission_id = $1
       AND spot_check_document_id = ANY($2)`,
    [submissionId, spotCheckDocumentIds]
  );

  return { unlinked: rowCount ?? 0 };
}

/* ────────────────────────────────────────────────────────────────────────────
   10. LINK — list
   ──────────────────────────────────────────────────────────────────────────── */

export async function listSubmissionSpotCheckLinks(
  submissionId: string
): Promise<ISubmissionSpotCheckLink[]> {
  const { rows } = await pool.query(
    `${SUBMISSION_LINK_SELECT}
     WHERE l.submission_id = $1
     ORDER BY l.linked_at ASC`,
    [submissionId]
  );

  return rows.map((r: SubmissionSpotCheckLinkRow) =>
    mapSubmissionSpotCheckLinkRow(r)
  );
}