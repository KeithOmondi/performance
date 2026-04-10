import { Router } from "express";
import {
  createIndicator,
  getAllIndicators,
  getIndicatorById,
  getAllSubmissions,
  deleteIndicator,
  updateIndicator,
  superAdminReviewProcess,
  getSuperAdminStats,
  getRejectedByAdmin,
  reopenIndicator,
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);
router.use(restrictTo("superadmin"));

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get("/dashboard-stats", getSuperAdminStats);
router.get("/submissions/queue", getAllSubmissions);
router.get("/rejected-by-admin", getRejectedByAdmin);

// ─── Indicators ───────────────────────────────────────────────────────────────
router.get("/", getAllIndicators);
router.post("/", createIndicator);

// ─── Single Indicator ─────────────────────────────────────────────────────────
router.get("/:id", getIndicatorById);
router.patch("/:id", updateIndicator);
router.delete("/:id", deleteIndicator);

// ─── Review ───────────────────────────────────────────────────────────────────
router.patch("/:id/review", superAdminReviewProcess);
router.patch("/:id/reopen", reopenIndicator);

export const IndicatorRoutes = router;