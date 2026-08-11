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
  assignIndicator,
  deleteSubmission,
  getAssignedIndicators,
  getUnassignedIndicators,
  getReviewIndicators,
  getIndicatorCounts,
  getSuperAdminApprovedIndicators,
  getPartialApprovalsHistory,
  reassignIndicator,
  addUsersToIndicator,
  removeUsersFromIndicator,
  sendBackToAdmin, // ✅ Add this import
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// ─── Middleware ─────────────────────────────────────────────────────────────────
// All routes require authentication and superadmin/admin role
router.use(protect);
router.use(restrictTo("superadmin", "admin"));

// ─── Dashboard & Stats ────────────────────────────────────────────────────────
router.get("/dashboard-stats", getSuperAdminStats);
router.get("/rejected-by-admin", getRejectedByAdmin);

// ─── Submissions Queue (MUST be before /:id routes) ──────────────────────────
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

// ✅ Send Back to Admin (MUST be before /:id/assign and other specific routes)
router.patch("/:id/send-back-to-admin", sendBackToAdmin);

// ─── Assignment Management ────────────────────────────────────────────────────
// Single assignee operations
router.patch("/:id/assign", assignIndicator);
router.delete("/:id/unassign", unassignIndicator);

// Multi-assignee operations
router.patch("/:id/reassign", reassignIndicator);
router.post("/:id/add-users", addUsersToIndicator);
router.delete("/:id/remove-users", removeUsersFromIndicator);

export const IndicatorRoutes = router;