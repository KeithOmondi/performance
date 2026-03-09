import multer, { FileFilterCallback } from "multer";
import { Request } from "express";

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    // Increased to 55MB to accommodate larger video files
    fileSize: 55 * 1024 * 1024, 
  },
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
  ) => {
    const allowedTypes = [
      // Images
      "image/jpeg",
      "image/png",
      "image/webp",
      // Documents
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      // Videos
      "video/mp4",
      "video/mpeg",
      "video/quicktime", // .mov
      "video/webm",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file format. Allowed: JPG, PNG, WEBP, PDF, DOCX, and common Video formats (MP4, MOV, WEBM).",
        ) as any,
        false,
      );
    }
  },
});