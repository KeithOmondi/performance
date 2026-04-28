import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  adminReviewProcess,
  fetchResubmittedIndicators,
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// Apply global admin protection to all routes in this file
router.use(protect);
router.use(restrictTo("admin"));

// ─── Collection Routes (Static paths must come first) ────────────────────────
router.get("/all", fetchIndicatorsForAdmin);
router.get("/resubmitted", fetchResubmittedIndicators);

// ─── Single Resource Routes (Dynamic params last) ───────────────────────────
router.get("/:id", getIndicatorByIdAdmin);

// ─── Action Routes ──────────────────────────────────────────────────────────
/**
 * Using PATCH is correct for partial updates to status and document reviews.
 */
router.patch("/:id/review", adminReviewProcess);

export default router;