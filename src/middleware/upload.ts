import multer, { FileFilterCallback } from "multer";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/AppError";

/**
 * memoryStorage is fastest for processing but uses Server RAM.
 * With 50 files @ 55MB, one request could peak at ~2.7GB RAM.
 */
const storage = multer.memoryStorage();

const allowedTypes: Record<string, string[]> = {
  // --- Images ---
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/svg+xml": ["svg"],
  "image/heic": ["heic"], // Common for iPhone photos

  // --- Documents (PDF & Microsoft Office) ---
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],

  // --- OpenDocument Formats (LibreOffice/OpenOffice) ---
  "application/vnd.oasis.opendocument.text": ["odt"],
  "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
  "application/vnd.oasis.opendocument.presentation": ["odp"],

  // --- Data & Text ---
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  "application/rtf": ["rtf"],
  "text/html": ["html", "htm"],

  // --- Archives (If needed for multiple docs) ---
  "application/zip": ["zip"],
  "application/x-7z-compressed": ["7z"],
  "application/x-rar-compressed": ["rar"],

  // --- Videos ---
  "video/mp4": ["mp4"],
  "video/mpeg": ["mpeg"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
  "video/x-msvideo": ["avi"],
};

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
) => {
  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    // Using AppError to maintain consistency with your error handling
    cb(new AppError("Unsupported file format. Please upload images, PDFs, Docs, or Videos.", 400) as any, false);
  }
};

// 1. Export the base multer instance as 'upload' 
// This fixes the "Cannot read properties of undefined (reading 'array')" error
export const upload = multer({
  storage,
  limits: {
    fileSize: 55 * 1024 * 1024, // 55MB per file
    files: 50,                  // Maximum 50 files per request
  },
  fileFilter,
});

/**
 * 2. Pre-configured middleware for bulk uploads.
 * Use this in your route for cleaner syntax:
 * router.post('/path', uploadBulkEvidence, requireFiles, controller)
 */
export const uploadBulkEvidence = upload.array("documents", 50);

/**
 * 3. Validation middleware to ensure files actually reached the controller
 */
export const requireFiles = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return next(new AppError("At least one document is required for this submission.", 400));
  }
  next();
};