import { Router } from "express";
import { protect } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";
import { upload } from "../../middleware/upload";

const router = Router();

// All routes here require the user to be logged in
router.use(protect);

/**
 * @route   GET /api/user/indicators/my-assignments
 * @desc    Get all indicators assigned to the current user
 */
router.get("/my-assignments", UserIndicatorController.getMyIndicators);

/**
 * @route   GET /api/user/indicators/:id
 * @desc    Get full history and details for a specific assignment
 */
router.get("/:id", UserIndicatorController.getIndicatorDetails);

/**
 * @route   POST /api/user/indicators/:id/submit
 * @desc    Submit quarterly progress with multiple file evidence
 * @note    Updated from .single() or .array() without limits to explicit .array("evidence", 10)
 */
router.post(
  "/:id/submit",
  // "evidence" must match the key used in your Frontend FormData.append("evidence", file)
  upload.array("evidence", 10), 
  UserIndicatorController.submitProgress,
);

/**
 * @route   PATCH /api/user/indicators/:indicatorId/resubmit/:submissionId
 * @desc    Update a specific rejected or incorrect submission with new multiple files
 */
router.patch(
  "/:indicatorId/resubmit/:submissionId",
  upload.array("evidence", 10),
  UserIndicatorController.resubmitProgress,
);

export default router;