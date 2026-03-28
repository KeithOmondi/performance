import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  adminReviewProcess,
  fetchResubmittedIndicators,
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();



// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get("/all", protect, restrictTo("admin"), fetchIndicatorsForAdmin);
router.get("/resubmitted", protect, restrictTo("admin"), fetchResubmittedIndicators);

// ─── Single Indicator ─────────────────────────────────────────────────────────
router.get("/:id", protect, restrictTo("admin"), getIndicatorByIdAdmin);

// ─── Admin Review ─────────────────────────────────────────────────────────────
router.patch("/:id/review", protect, restrictTo("admin"), adminReviewProcess);

export default router;