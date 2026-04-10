import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";
import { upload, requireFiles } from "../../middleware/upload"; // Import requireFiles for better validation

const router = Router();

// 1. Get all assigned indicators
router.get(
  "/my-assignments",
  protect,
  restrictTo("user"),
  UserIndicatorController.getMyIndicators,
);

// 2. Stream file proxy
router.get(
  "/stream-file",
  protect,
  restrictTo("user", "admin", "superadmin", "examiner"),
  UserIndicatorController.streamFile,
);

// 3. Get single indicator details
router.get(
  "/:id",
  protect,
  restrictTo("user"),
  UserIndicatorController.getIndicatorDetails,
);

// 4. Submit or resubmit progress
// CHANGED: "evidence" -> "documents" | limit: 5 -> 50
router.post(
  "/:id/submit",
  protect,
  restrictTo("user"),
  upload.array("documents", 50), 
  UserIndicatorController.submitProgress,
);

// 5. Add documents to an existing submission
// CHANGED: "evidence" -> "documents" | limit: 5 -> 50
router.post(
  "/:id/add-documents",
  protect,
  restrictTo("user"),
  upload.array("documents", 50),
  requireFiles, // Added this to ensure user actually sent something
  UserIndicatorController.addDocuments,
);

export default router;