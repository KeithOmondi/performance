// src/validators/spot-check.validator.ts
//
// Request validators for the Spot Check module.
// No third-party validation library — plain functions that throw AppError
// on failure, so they slot straight into your existing asyncHandler flow.

import { AppError } from "../../utils/AppError";



/* ────────────────────────────────────────────────────────────────────────────
   PRIMITIVES
   ──────────────────────────────────────────────────────────────────────────── */

const isUUID = (val: unknown): boolean =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

const isDate = (val: unknown): boolean => {
  if (typeof val !== "string") return false;
  // Accept YYYY-MM-DD strictly (what the client sends)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(val);
  return !isNaN(d.getTime());
};

const isNonEmptyString = (val: unknown): val is string =>
  typeof val === "string" && val.trim().length > 0;

const MAX_DESCRIPTION = 5000;
const MAX_STATION = 200;
const MAX_FILE_DESCRIPTION = 500;
const MAX_BATCH = 50;

/* ────────────────────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Normalize a query param that may arrive as string, array, or undefined.
 * Express can give us any of those depending on how the client sends it.
 */
const asString = (val: unknown): string | undefined => {
  if (Array.isArray(val)) return val[0]?.toString();
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  return undefined;
};

const asStringArray = (val: unknown): string[] => {
  if (Array.isArray(val)) return val.map((v) => String(v));
  if (typeof val === "string") return [val];
  return [];
};

const asNumber = (val: unknown, fallback?: number): number | undefined => {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
};

/* ────────────────────────────────────────────────────────────────────────────
   1. CREATE SPOT CHECK
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedCreateSpotCheck {
  station: string;
  visitDate: string;
  description: string;
  documentDescriptions: string[];
}

/**
 * Validates the body of POST /spot-checks.
 *
 * Files are validated separately by multer's `requireFiles` middleware,
 * so we assume `req.files` exists and has >= 1 item by the time this runs.
 * We do validate that `documentDescriptions` (if provided) matches that count.
 */
export function validateCreateSpotCheck(
  body: any,
  fileCount: number
): ValidatedCreateSpotCheck {
  const errors: string[] = [];

  const station = typeof body.station === "string" ? body.station.trim() : "";
  if (!isNonEmptyString(station)) {
    errors.push("station is required.");
  } else if (station.length > MAX_STATION) {
    errors.push(`station must be at most ${MAX_STATION} characters.`);
  }

  const visitDate = typeof body.visitDate === "string" ? body.visitDate.trim() : "";
  if (!isNonEmptyString(visitDate)) {
    errors.push("visitDate is required.");
  } else if (!isDate(visitDate)) {
    errors.push("visitDate must be a valid date in YYYY-MM-DD format.");
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!isNonEmptyString(description)) {
    errors.push("description is required.");
  } else if (description.length > MAX_DESCRIPTION) {
    errors.push(`description must be at most ${MAX_DESCRIPTION} characters.`);
  }

  // documentDescriptions is optional, but if present must align with files
  let documentDescriptions: string[] = [];
  if (body.documentDescriptions !== undefined) {
    const raw = asStringArray(body.documentDescriptions);
    documentDescriptions = raw.map((d) => d.trim()).filter(Boolean);

    if (documentDescriptions.length !== fileCount) {
      errors.push(
        `documentDescriptions length (${documentDescriptions.length}) must match uploaded file count (${fileCount}).`
      );
    }

    for (const d of documentDescriptions) {
      if (d.length > MAX_FILE_DESCRIPTION) {
        errors.push(
          `each document description must be at most ${MAX_FILE_DESCRIPTION} characters.`
        );
        break;
      }
    }
  } else {
    // Default to empty strings, one per file
    documentDescriptions = new Array(fileCount).fill("");
  }

  if (errors.length > 0) {
    throw new AppError(`Validation failed: ${errors.join(" ")}`, 400);
  }

  return { station, visitDate, description, documentDescriptions };
}

/* ────────────────────────────────────────────────────────────────────────────
   2. UPDATE SPOT CHECK
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedUpdateSpotCheck {
  station?: string;
  visitDate?: string;
  description?: string;
  documentDescriptions?: string[];
}

export function validateUpdateSpotCheck(
  body: any,
  newFileCount: number
): ValidatedUpdateSpotCheck {
  const errors: string[] = [];
  const result: ValidatedUpdateSpotCheck = {};

  if (body.station !== undefined) {
    const station = typeof body.station === "string" ? body.station.trim() : "";
    if (!isNonEmptyString(station)) {
      errors.push("station cannot be empty when provided.");
    } else if (station.length > MAX_STATION) {
      errors.push(`station must be at most ${MAX_STATION} characters.`);
    } else {
      result.station = station;
    }
  }

  if (body.visitDate !== undefined) {
    const visitDate =
      typeof body.visitDate === "string" ? body.visitDate.trim() : "";
    if (!isDate(visitDate)) {
      errors.push("visitDate must be a valid date in YYYY-MM-DD format.");
    } else {
      result.visitDate = visitDate;
    }
  }

  if (body.description !== undefined) {
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    if (!isNonEmptyString(description)) {
      errors.push("description cannot be empty when provided.");
    } else if (description.length > MAX_DESCRIPTION) {
      errors.push(`description must be at most ${MAX_DESCRIPTION} characters.`);
    } else {
      result.description = description;
    }
  }

  if (body.documentDescriptions !== undefined) {
    if (newFileCount === 0) {
      errors.push(
        "documentDescriptions was provided but no new files were uploaded."
      );
    } else {
      const raw = asStringArray(body.documentDescriptions);
      const cleaned = raw.map((d) => d.trim()).filter(Boolean);

      if (cleaned.length !== newFileCount) {
        errors.push(
          `documentDescriptions length (${cleaned.length}) must match new uploaded file count (${newFileCount}).`
        );
      } else {
        result.documentDescriptions = cleaned;
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(`Validation failed: ${errors.join(" ")}`, 400);
  }

  return result;
}

/* ────────────────────────────────────────────────────────────────────────────
   3. DELETE SPOT CHECK DOCUMENT
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedDeleteSpotCheckDocument {
  documentId: string;
  reason?: string;
}

export function validateDeleteSpotCheckDocument(
  body: any
): ValidatedDeleteSpotCheckDocument {
  const errors: string[] = [];

  const documentId =
    typeof body.documentId === "string" ? body.documentId.trim() : "";
  if (!isNonEmptyString(documentId)) {
    errors.push("documentId is required.");
  } else if (!isUUID(documentId)) {
    errors.push("documentId must be a valid UUID.");
  }

  let reason: string | undefined;
  if (body.reason !== undefined) {
    const r = typeof body.reason === "string" ? body.reason.trim() : "";
    if (r.length > MAX_FILE_DESCRIPTION) {
      errors.push(
        `reason must be at most ${MAX_FILE_DESCRIPTION} characters.`
      );
    } else if (r.length > 0) {
      reason = r;
    }
  }

  if (errors.length > 0) {
    throw new AppError(`Validation failed: ${errors.join(" ")}`, 400);
  }

  return { documentId, reason };
}

/* ────────────────────────────────────────────────────────────────────────────
   4. LIBRARY FILTERS (GET /spot-checks/library)
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedLibraryFilters {
  station?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page: number;
  pageSize: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

export function validateLibraryFilters(
  query: any
): ValidatedLibraryFilters {
  const errors: string[] = [];
  const result: ValidatedLibraryFilters = {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  const station = asString(query.station);
  if (station !== undefined && station.trim().length > 0) {
    if (station.length > MAX_STATION) {
      errors.push(`station filter must be at most ${MAX_STATION} characters.`);
    } else {
      result.station = station.trim();
    }
  }

  const fromDate = asString(query.fromDate);
  if (fromDate !== undefined && fromDate.length > 0) {
    if (!isDate(fromDate)) {
      errors.push("fromDate must be a valid date in YYYY-MM-DD format.");
    } else {
      result.fromDate = fromDate;
    }
  }

  const toDate = asString(query.toDate);
  if (toDate !== undefined && toDate.length > 0) {
    if (!isDate(toDate)) {
      errors.push("toDate must be a valid date in YYYY-MM-DD format.");
    } else {
      result.toDate = toDate;
    }
  }

  if (
    result.fromDate &&
    result.toDate &&
    result.fromDate > result.toDate
  ) {
    errors.push("fromDate cannot be after toDate.");
  }

  const search = asString(query.search);
  if (search !== undefined && search.trim().length > 0) {
    if (search.length > 200) {
      errors.push("search must be at most 200 characters.");
    } else {
      result.search = search.trim();
    }
  }

  const page = asNumber(query.page, 1)!;
  if (!Number.isInteger(page) || page < 1) {
    errors.push("page must be a positive integer.");
  } else {
    result.page = page;
  }

  const pageSize = asNumber(query.pageSize, DEFAULT_PAGE_SIZE)!;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    errors.push("pageSize must be a positive integer.");
  } else if (pageSize > MAX_PAGE_SIZE) {
    errors.push(`pageSize cannot exceed ${MAX_PAGE_SIZE}.`);
  } else {
    result.pageSize = pageSize;
  }

  if (errors.length > 0) {
    throw new AppError(`Validation failed: ${errors.join(" ")}`, 400);
  }

  return result;
}

/* ────────────────────────────────────────────────────────────────────────────
   5. LIST SPOT CHECKS (GET /spot-checks) — library-side filters
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedSpotCheckListFilters {
  station?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page: number;
  pageSize: number;
}

/**
 * Same shape as library filters, but used for the admin-side list of
 * spot check *entries* (not documents). Kept separate so we can diverge
 * them later if needed (e.g. filter by createdBy on the admin side).
 */
export function validateSpotCheckListFilters(
  query: any
): ValidatedSpotCheckListFilters {
  return validateLibraryFilters(query);
}

/* ────────────────────────────────────────────────────────────────────────────
   6. LINK / UNLINK SPOT CHECK DOCUMENTS TO A SUBMISSION
   ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedLinkPayload {
  spotCheckDocumentIds: string[];
}

function validateDocumentIdArray(val: unknown, fieldName: string): string[] {
  const errors: string[] = [];
  const raw = asStringArray(val);

  if (raw.length === 0) {
    errors.push(`${fieldName} must contain at least one document ID.`);
  }

  if (raw.length > MAX_BATCH) {
    errors.push(`${fieldName} cannot contain more than ${MAX_BATCH} IDs.`);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    const trimmed = id.trim();
    if (!isUUID(trimmed)) {
      errors.push(`Invalid UUID in ${fieldName}: "${trimmed}".`);
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      deduped.push(trimmed);
    }
  }

  if (errors.length > 0) {
    throw new AppError(`Validation failed: ${errors.join(" ")}`, 400);
  }

  return deduped;
}

export function validateLinkSpotCheckDocuments(
  body: any
): ValidatedLinkPayload {
  return {
    spotCheckDocumentIds: validateDocumentIdArray(
      body.spotCheckDocumentIds,
      "spotCheckDocumentIds"
    ),
  };
}

export function validateUnlinkSpotCheckDocuments(
  body: any
): ValidatedLinkPayload {
  return {
    spotCheckDocumentIds: validateDocumentIdArray(
      body.spotCheckDocumentIds,
      "spotCheckDocumentIds"
    ),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   7. ROUTE PARAM HELPERS
   ──────────────────────────────────────────────────────────────────────────── */

/** Validate an :id route param that must be a UUID. */
export function validateUUIDParam(
  value: unknown,
  name = "id"
): string {
  const s = asString(value)?.trim() ?? "";
  if (!isUUID(s)) {
    throw new AppError(`Invalid ${name}: must be a valid UUID.`, 400);
  }
  return s;
}