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
  assignIndicator,  // ✅ ADDED - assign indicator
  deleteSubmission,
  getAssignedIndicators,
  getUnassignedIndicators,
  getReviewIndicators,
  getIndicatorCounts,
  getSuperAdminApprovedIndicators,
  getPartialApprovalsHistory,
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);
router.use(restrictTo("superadmin"));

// ─── Dashboard & Stats ────────────────────────────────────────────────────────
router.get("/dashboard-stats", getSuperAdminStats);
router.get("/rejected-by-admin", getRejectedByAdmin);

// ─── Submissions (MUST be before /:id routes) ─────────────────────────────────
router.get("/submissions/queue", getAllSubmissions);
router.delete("/submissions/:submissionId", deleteSubmission);

// ─── Categorized Indicator Lists (MUST be before /:id routes) ─────────────────
router.get("/assigned", getAssignedIndicators);
router.get("/unassigned", getUnassignedIndicators);
router.get("/review", getReviewIndicators);
router.get("/counts", getIndicatorCounts);
router.get("/approved-by-superadmin", getSuperAdminApprovedIndicators);

// ─── Indicators (collection) ──────────────────────────────────────────────────
router.get("/", getAllIndicators);
router.post("/", createIndicator);

// ─── Partial Approval History (MUST be before /:id routes) ────────────────────
router.get("/:id/partial-approvals", getPartialApprovalsHistory);

// ─── Single Indicator Operations (MUST be after all fixed-segment routes) ─────
router.get("/:id", getIndicatorById);
router.patch("/:id", updateIndicator);
router.delete("/:id", deleteIndicator);

// ─── Review & Reopen ──────────────────────────────────────────────────────────
router.patch("/:id/review", superAdminReviewProcess);
router.patch("/:id/reopen", reopenIndicator);

// ─── Assignment Management ────────────────────────────────────────────────────
router.patch("/:id/assign", assignIndicator);      // ✅ ADDED - assign an indicator
router.delete("/:id/unassign", unassignIndicator); // unassign an indicator

export const IndicatorRoutes = router;