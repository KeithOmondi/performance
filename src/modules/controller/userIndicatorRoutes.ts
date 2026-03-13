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
 * @desc    Submit OR Resubmit quarterly progress with multiple file evidence
 * @note    The controller now handles both initial submissions and resubmitting rejected quarters.
 */
router.post(
  "/:id/submit",
  // Ensure "evidence" matches your Frontend: formData.append("evidence", file)
  upload.array("evidence", 10), 
  UserIndicatorController.submitProgress,
);

// Note: The PATCH /resubmit route has been removed because its logic 
// is now consolidated into the POST /submit route above.

export default router;