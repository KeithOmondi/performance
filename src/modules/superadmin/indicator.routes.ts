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
  sendBackToAdmin,
  deleteSingleDocument,
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

/* ─── Debug logger: remove after diagnosing ─────────────────────────────── */
router.use((req, _res, next) => {
  console.log(
    `[IndicatorRoutes] ${req.method} ${req.originalUrl} | role=${(req as any).user?.role ?? "anon"}`
  );
  next();
});

/* ─── Global middleware for this router ─────────────────────────────────── */
router.use(protect);
router.use(restrictTo("superadmin", "admin"));

/* ─────────────────────────────────────────────────────────────────────────
   1. FIXED-SEGMENT ROUTES FIRST (no params)
   ───────────────────────────────────────────────────────────────────────── */

// Dashboard & Stats
router.get("/dashboard-stats", getSuperAdminStats);
router.get("/rejected-by-admin", getRejectedByAdmin);

// Submissions queue (nested fixed segments)
router.get("/submissions/queue", getAllSubmissions);
router.delete("/submissions/:submissionId", deleteSubmission);

// Document deletion
router.delete("/documents/:documentId", deleteSingleDocument);

// Categorized lists
router.get("/assigned", getAssignedIndicators);
router.get("/unassigned", getUnassignedIndicators);
router.get("/review", getReviewIndicators);
router.get("/counts", getIndicatorCounts);
router.get("/approved-by-superadmin", getSuperAdminApprovedIndicators);

// Collection root
router.get("/", getAllIndicators);
router.post("/", createIndicator);

/* ─────────────────────────────────────────────────────────────────────────
   2. PARAM ROUTES WITH SUB-PATHS (two or more segments)
   These MUST come before `/:id` to be safe in every Express version.
   ───────────────────────────────────────────────────────────────────────── */

// Review & Reopen
router.patch("/:id/review", superAdminReviewProcess);
router.patch("/:id/reopen", reopenIndicator);

// Send back to admin
router.patch("/:id/send-back-to-admin", sendBackToAdmin);

// Partial approval history
router.get("/:id/partial-approvals", getPartialApprovalsHistory);

// Assignment management (sub-paths on :id)
router.patch("/:id/assign", assignIndicator);
router.delete("/:id/unassign", unassignIndicator);
router.patch("/:id/reassign", reassignIndicator);
router.post("/:id/add-users", addUsersToIndicator);
router.delete("/:id/remove-users", removeUsersFromIndicator);

/* ─────────────────────────────────────────────────────────────────────────
   3. SINGLE-SEGMENT PARAM ROUTES LAST
   `/:id` will match `/anything` but NOT `/anything/sub`. Still, keeping it
   last is the safest convention.
   ───────────────────────────────────────────────────────────────────────── */

router.get("/:id", getIndicatorById);
router.patch("/:id", updateIndicator);
router.delete("/:id", deleteIndicator);

export const IndicatorRoutes = router;