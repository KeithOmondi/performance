import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";
import { upload } from "../../middleware/upload";

const router = Router();

// Get all assigned indicators
router.get(
  "/my-assignments",
  protect,
  restrictTo("user"),
  UserIndicatorController.getMyIndicators,
);

// ✅ Stream file proxy — must be before /:id to avoid route conflict
router.get(
  "/stream-file",
  protect,
  restrictTo("user", "admin", "superadmin", "examiner"),
  UserIndicatorController.streamFile,
);

// Get single indicator details
router.get(
  "/:id",
  protect,
  restrictTo("user"),
  UserIndicatorController.getIndicatorDetails,
);

// Submit or resubmit progress with file evidence
router.post(
  "/:id/submit",
  protect,
  restrictTo("user"),
  upload.array("evidence", 5),
  UserIndicatorController.submitProgress,
);

// Add documents to an existing submission
router.post(
  "/:id/add-documents",
  protect,
  restrictTo("user"),
  upload.array("evidence", 5),
  UserIndicatorController.addDocuments,
);

export default router;
