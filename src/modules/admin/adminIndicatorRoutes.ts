import { Router } from "express";
import { 
  fetchIndicatorsForAdmin, 
  getIndicatorByIdAdmin, 
  adminReviewProcess, 
  fetchResubmittedIndicators
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

/**
 * All routes here are prefixed with /api/admin/indicators
 * and require Admin/Super Admin privileges.
 */
router.use(protect);
router.use(restrictTo("admin"));

// @route   GET /api/admin/indicators/all
// @desc    Get all indicators across the entire strategic plan
router.get("/all", fetchIndicatorsForAdmin);

// @route   GET /api/admin/indicators/assigned
// @desc    Get only indicators that have an active assignee (Filtered Workflow)
// Note: You can reuse fetchIndicatorsForAdmin with a query param or a dedicated controller
router.get("/assigned", fetchIndicatorsForAdmin); 

// @route   GET /api/admin/indicators/:id
// @desc    Get detailed data for a specific indicator (Slide-out view)
router.get("/:id", getIndicatorByIdAdmin);

// @route   PATCH /api/admin/indicators/review/:id
// @desc    Process the admin's decision (Approve/Reject/Comment)
router.patch("/review/:id", adminReviewProcess);
router.get("/resubmitted", fetchResubmittedIndicators);

export default router;