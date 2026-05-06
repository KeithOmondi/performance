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
  unassignIndicator,
  deleteSubmission,
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);
router.use(restrictTo("superadmin"));

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get("/dashboard-stats", getSuperAdminStats);
router.get("/rejected-by-admin", getRejectedByAdmin);

// ─── Submissions ─────────────────────────────────────────────────────────────
// ⚠️ Must be declared BEFORE /:id routes — otherwise Express matches
// "submissions" as the :id param and hits deleteIndicator instead.
router.get("/submissions/queue", getAllSubmissions);
router.delete("/submissions/:submissionId", deleteSubmission);

// ─── Indicators (collection) ──────────────────────────────────────────────────
router.get("/", getAllIndicators);
router.post("/", createIndicator);

// ─── Single Indicator ─────────────────────────────────────────────────────────
// These must come AFTER all fixed-segment routes above
router.get("/:id", getIndicatorById);
router.patch("/:id", updateIndicator);
router.delete("/:id", deleteIndicator);

// ─── Review & Reopen ──────────────────────────────────────────────────────────
router.patch("/:id/review", superAdminReviewProcess);
router.patch("/:id/reopen", reopenIndicator);

// ─── Unassign ─────────────────────────────────────────────────────────────────
router.delete("/:id/unassign", unassignIndicator);

export const IndicatorRoutes = router;