import multer, { FileFilterCallback } from "multer";
import { NextFunction, Request } from "express";
import { AppError } from "../utils/AppError";

const storage = multer.memoryStorage();

const allowedTypes: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "video/mp4": ["mp4"],
  "video/mpeg": ["mpeg"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
};

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
) => {
  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        "Unsupported file format. Allowed: JPG, PNG, WEBP, PDF, DOC, DOCX, MP4, MOV, WEBM.",
        400
      ) as any,
      false
    );
  }
};

// Single file upload (evidence, attachment)
export const upload = multer({
  storage,
  limits: { fileSize: 55 * 1024 * 1024 }, // 55MB
  fileFilter,
});

// Multiple files upload (up to 5 files per submission)
export const uploadMultiple = multer({
  storage,
  limits: {
    fileSize: 55 * 1024 * 1024, // 55MB per file
    files: 5,                    // max 5 files at once
  },
  fileFilter,
});

// Helper to validate file exists on req after upload
export const requireFile = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.file && (!req.files || (req.files as Express.Multer.File[]).length === 0)) {
    throw new AppError("At least one file is required for this submission.", 400);
  }
  next();
};