import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  approveSubmission,
  rejectSubmission,
  fetchResubmittedIndicators,
  getAdminApprovedIndicators,
  rejectDocument,
  approveDocument,          // ← NEW: Approve individual document
  deleteSubmission,
  deleteDocumentAdmin,
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

// ─── Calendar Routes ──────────────────────────────────────────────────────────
router.get("/calendar/upcoming", getUpcomingDeadlines);
router.get("/calendar/:id", getIndicatorCalendarEvents);
router.get("/calendar", getCalendarEvents);

// ─── Single Resource Routes ──────────────────────────────────────────────────
router.get("/:id", getIndicatorByIdAdmin);

// ─── Document-Level Action Routes ───────────────────────────────────────────
// These are the new document-level workflows that allow granular control
router.patch("/:id/documents/approve", approveDocument);        // Approve individual document
router.patch("/:id/documents/reject", rejectDocument);          // Reject individual document
router.patch("/:id/documents/delete", deleteDocumentAdmin);     // Soft-delete document with reason

// ─── Submission-Level Action Routes ──────────────────────────────────────────
router.patch("/:id/submissions/approve", approveSubmission);     // Approve entire submission
router.patch("/:id/submissions/reject", rejectSubmission);       // Reject entire submission

// ─── Delete submission (hard delete) ──────────────────────────────────────
router.delete(
  "/:indicatorId/submissions/:submissionId",
  deleteSubmission
);

export default router;