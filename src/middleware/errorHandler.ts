import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError";

export const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // Log full error in development, minimal in production
  if (process.env.NODE_ENV === "development") {
    console.error("🔥 Error:", err);
  } else {
    console.error(`🔥 [${err.statusCode || 500}] ${err.message}`);
  }

  // Already an operational AppError — send as-is
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    });
  }

  // Mongoose: invalid ObjectId (e.g. /users/not-an-id)
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: `Invalid ${err.path}: ${err.value}`,
    });
  }

  // Mongoose: duplicate key (e.g. duplicate email)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    return res.status(409).json({
      success: false,
      message: `An account with that ${field} already exists.`,
    });
  }

  // Mongoose: validation error (e.g. missing required fields)
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors as Record<string, any>).map(
      (e: any) => e.message
    );
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: messages,
    });
  }

  // JWT errors (belt-and-suspenders, in case they leak past auth middleware)
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      message: "Invalid token. Please log in again.",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Your session has expired. Please log in again.",
    });
  }

  // Multer: file too large
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File too large. Maximum allowed size exceeded.",
    });
  }

  // Multer: unexpected file field
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      success: false,
      message: "Unexpected file field in upload.",
    });
  }

  // Fallback: unknown/unhandled error
  return res.status(500).json({
    success: false,
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong. Please try again later.",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};