import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  approveSubmission,
  rejectSubmission,
  fetchResubmittedIndicators,
  getAdminApprovedIndicators,
  rejectDocument,
  approveDocument,
  deleteSubmission,
  deleteDocumentAdmin,
  approveQuarter,
  rejectQuarter,
  getQuarterStatusesForIndicator,
  getSentBackIndicators,      // ✅ NEW
  getReturnedIndicators,      // ✅ NEW
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { getCalendarEvents, getIndicatorCalendarEvents, getUpcomingDeadlines } from "../calendar/calendarcontroller";

const router = Router();

router.use(protect);
router.use(restrictTo("admin"));

// ─── Collection Routes ───────────────────────────────────────────────────────
router.get("/all", fetchIndicatorsForAdmin);
router.get("/resubmitted", fetchResubmittedIndicators);
router.get("/approved-by-admin", getAdminApprovedIndicators);

// ✅ NEW: Routes for indicators sent back or returned
router.get("/sent-back", getSentBackIndicators);        // Indicators sent back by super admin
router.get("/returned", getReturnedIndicators);         // Indicators returned/rejected

// ─── Calendar Routes ──────────────────────────────────────────────────────────
router.get("/calendar/upcoming", getUpcomingDeadlines);
router.get("/calendar/:id", getIndicatorCalendarEvents);
router.get("/calendar", getCalendarEvents);

// ─── Single Resource Routes ──────────────────────────────────────────────────
router.get("/:id", getIndicatorByIdAdmin);

// ─── Quarter-Level Routes ────────────────────────────────────────────────────
router.get("/:id/quarters", getQuarterStatusesForIndicator);
router.patch("/:id/quarters/approve", approveQuarter);
router.patch("/:id/quarters/reject", rejectQuarter);

// ─── Document-Level Action Routes ───────────────────────────────────────────
router.patch("/:id/documents/approve", approveDocument);
router.patch("/:id/documents/reject", rejectDocument);
router.patch("/:id/documents/delete", deleteDocumentAdmin);

// ─── Submission-Level Action Routes (Legacy) ────────────────────────────────
router.patch("/:id/submissions/approve", approveSubmission);
router.patch("/:id/submissions/reject", rejectSubmission);

// ─── Delete submission (hard delete) ──────────────────────────────────────
router.delete(
  "/:indicatorId/submissions/:submissionId",
  deleteSubmission
);

export default router;