import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";
import { upload } from "../../middleware/upload";

const router = Router();

router.use(protect);
router.use(restrictTo("user", "examiner"));

// Get all assigned indicators
router.get("/my-assignments", UserIndicatorController.getMyIndicators);

// Get single indicator details
router.get("/:id", UserIndicatorController.getIndicatorDetails);

// Submit or resubmit progress with file evidence
router.post(
  "/:id/submit",
  upload.array("evidence", 5),
  UserIndicatorController.submitProgress
);

// Add documents to an existing submission
router.post(
  "/:id/add-documents",
  upload.array("evidence", 5),
  UserIndicatorController.addDocuments
);

export default router;