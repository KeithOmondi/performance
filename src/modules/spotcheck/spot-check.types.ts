// src/types/spot-check.types.ts
//
// Spot Check module types.
//
// Two distinct concerns live here:
//
//   1. The SPOT CHECK LIBRARY — a persistent collection of files uploaded
//      by admins, grouped by station + visit date. These files are reused
//      across submissions; they are never copied.
//
//   2. The LINK between a submission and one or more spot-check documents.
//      When a user selects files from the library on the submission page,
//      we record a link row — we do NOT duplicate the file itself.

/* ────────────────────────────────────────────────────────────────────────────
   PART 1 — SPOT CHECK LIBRARY
   ──────────────────────────────────────────────────────────────────────────── */

export type SpotCheckDocumentStatus = "Active" | "Deleted";

export type SpotCheckStatus = "Draft" | "Submitted" | "Reviewed";

/** A single evidence file inside the spot check library. */
export interface ISpotCheckDocument {
  id: string;
  spotCheckId: string;

  /* Cloudinary pointers — same shape as submission_documents so the
     existing deleteFromCloudinary() helper works without adaptation. */
  evidenceUrl: string;
  evidencePublicId: string;

  fileType: string;       // "image" | "video" | "document" | ...
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;

  description?: string;
  uploadedAt: string;     // ISO timestamp
  uploadedBy: string;     // user id

  status: SpotCheckDocumentStatus;
  deletedAt?: string | null;
}

/** A spot check visit — one entry in the library. */
export interface ISpotCheck {
  id: string;

  /* Location */
  station: string;
  stationId?: string | null;

  /* Visit */
  visitDate: string;          // YYYY-MM-DD
  description: string;

  /* Meta */
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  status?: SpotCheckStatus;
  deletedAt?: string | null;

  /* Documents attached to this spot check */
  documents: ISpotCheckDocument[];
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 2 — SUBMISSION ↔ SPOT CHECK LINK
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Records that a submission has attached one or more spot-check documents
 * as evidence. One row per (submission, document) pair.
 */
export interface ISubmissionSpotCheckLink {
  id: string;
  submissionId: string;
  spotCheckDocumentId: string;

  /** Denormalized snapshot of the document at link time, so the
   *  submission can still render the evidence even if the source
   *  document is later soft-deleted. Populated by the server. */
  evidenceUrl: string;
  evidencePublicId: string;
  fileName: string;
  fileType: string;
  description?: string;

  linkedAt: string;
  linkedBy: string;         // user id
}

/**
 * Payload the client sends when linking spot-check documents to a
 * submission. The IDs are spot-check DOCUMENT ids (not spot-check ids),
 * because the user is picking individual files.
 */
export interface ILinkSpotCheckDocumentsPayload {
  submissionId: string;
  spotCheckDocumentIds: string[];
}

/** Payload to unlink one or more documents from a submission. */
export interface IUnlinkSpotCheckDocumentsPayload {
  submissionId: string;
  spotCheckDocumentIds: string[];
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 3 — LIBRARY QUERY / FILTERS (client → server)
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Used on the submission page to list available spot-check files the user
 * can pick from. Filter by station and/or date range to narrow the list.
 */
export interface ISpotCheckLibraryFilters {
  station?: string;         // substring match
  fromDate?: string;        // YYYY-MM-DD inclusive
  toDate?: string;          // YYYY-MM-DD inclusive
  search?: string;          // full-text over description + file name
  page?: number;
  pageSize?: number;
}

/**
 * Response shape for the library listing endpoint. Returns documents
 * directly (flat), each tagged with its parent spot check's station and
 * date — this is what the user sees in the picker.
 */
export interface ISpotCheckLibraryItem {
  /* Document */
  documentId: string;
  evidenceUrl: string;
  evidencePublicId: string;
  fileName: string;
  fileType: string;
  description?: string;
  uploadedAt: string;

  /* Parent spot check (denormalized for display) */
  spotCheckId: string;
  station: string;
  visitDate: string;
  spotCheckDescription: string;
}

export interface ISpotCheckLibraryResponse {
  success: true;
  count: number;
  data: ISpotCheckLibraryItem[];
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 4 — CREATE / UPDATE PAYLOADS
   ──────────────────────────────────────────────────────────────────────────── */

/** Fields for creating a spot check entry in the library. */
export interface ICreateSpotCheckPayload {
  station: string;
  visitDate: string;          // YYYY-MM-DD
  description: string;
  /** One description per uploaded file, in upload order. Optional. */
  documentDescriptions?: string[];
}

/** Update an existing spot check entry. */
export interface IUpdateSpotCheckPayload {
  station?: string;
  visitDate?: string;
  description?: string;
  documentDescriptions?: string[];
}

/** Soft-delete a single document from the library. */
export interface IDeleteSpotCheckDocumentPayload {
  documentId: string;
  reason?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 5 — RESPONSE SHAPES
   ──────────────────────────────────────────────────────────────────────────── */

export interface ISpotCheckListResponse {
  success: true;
  count: number;
  data: ISpotCheck[];
}

export interface ISpotCheckDetailResponse {
  success: true;
  data: ISpotCheck;
}

export interface ISpotCheckDeleteResponse {
  success: true;
  message: string;
  data: { id: string };
}

export interface ISubmissionSpotCheckLinkResponse {
  success: true;
  count: number;
  data: ISubmissionSpotCheckLink[];
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 6 — DB ROW SHAPES (what pg returns before mapping)
   ──────────────────────────────────────────────────────────────────────────── */

export interface SpotCheckRow {
  id: string;
  station: string;
  station_id: string | null;
  visit_date: string;
  description: string;
  status: string | null;
  created_by: string;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SpotCheckDocumentRow {
  id: string;
  spot_check_id: string;
  evidence_url: string;
  evidence_public_id: string;
  file_type: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  description: string | null;
  uploaded_at: string;
  uploaded_by: string;
  status: string;
  deleted_at: string | null;
}

export interface SubmissionSpotCheckLinkRow {
  id: string;
  submission_id: string;
  spot_check_document_id: string;
  evidence_url: string;
  evidence_public_id: string;
  file_name: string;
  file_type: string;
  description: string | null;
  linked_at: string;
  linked_by: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   PART 7 — MAPPERS
   ──────────────────────────────────────────────────────────────────────────── */

export function mapSpotCheckDocumentRow(
  row: SpotCheckDocumentRow
): ISpotCheckDocument {
  return {
    id: row.id,
    spotCheckId: row.spot_check_id,
    evidenceUrl: row.evidence_url,
    evidencePublicId: row.evidence_public_id,
    fileType: row.file_type,
    fileName: row.file_name,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    description: row.description ?? undefined,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    status: row.status as SpotCheckDocumentStatus,
    deletedAt: row.deleted_at,
  };
}

export function mapSpotCheckRow(
  row: SpotCheckRow,
  documents: SpotCheckDocumentRow[] = []
): ISpotCheck {
  return {
    id: row.id,
    station: row.station,
    stationId: row.station_id,
    visitDate: row.visit_date,
    description: row.description,
    status: (row.status as SpotCheckStatus) ?? undefined,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    documents: documents.map(mapSpotCheckDocumentRow),
  };
}

export function mapSubmissionSpotCheckLinkRow(
  row: SubmissionSpotCheckLinkRow
): ISubmissionSpotCheckLink {
  return {
    id: row.id,
    submissionId: row.submission_id,
    spotCheckDocumentId: row.spot_check_document_id,
    evidenceUrl: row.evidence_url,
    evidencePublicId: row.evidence_public_id,
    fileName: row.file_name,
    fileType: row.file_type,
    description: row.description ?? undefined,
    linkedAt: row.linked_at,
    linkedBy: row.linked_by,
  };
}