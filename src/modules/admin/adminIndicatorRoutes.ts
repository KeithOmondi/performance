import { Router } from "express";
import { 
  fetchIndicatorsForAdmin, 
  getIndicatorByIdAdmin, 
  adminReviewProcess, 
  fetchResubmittedIndicators
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);
router.use(restrictTo("admin"));

// Specific routes MUST come before generic /:id routes
router.get("/all", fetchIndicatorsForAdmin);
router.get("/resubmitted", fetchResubmittedIndicators); // FIXED: Order matters
router.get("/assigned", fetchIndicatorsForAdmin); 

// Generic /:id route - handles everything that isn't 'all' or 'resubmitted'
router.get("/:id", getIndicatorByIdAdmin);

router.patch("/review/:id", adminReviewProcess);

export default router;