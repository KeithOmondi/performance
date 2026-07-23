import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  approveSubmission,
  rejectSubmission,
  fetchResubmittedIndicators,
  getAdminApprovedIndicators,
  rejectDocument,
  deleteSubmission,
  deleteDocumentAdmin,          // ← NEW import
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
router.get("/calendar/:id",      getIndicatorCalendarEvents);
router.get("/calendar",          getCalendarEvents);

// ─── Single Resource Routes ──────────────────────────────────────────────────
router.get("/:id", getIndicatorByIdAdmin);

// ─── Action Routes ───────────────────────────────────────────────────────────
router.patch("/:id/approve",           approveSubmission);
router.patch("/:id/reject",            rejectSubmission);        // overall rejection
router.patch("/:id/reject-document",   rejectDocument);          // single document rejection

// ─── Delete submission (hard delete) ──────────────────────────────────────
router.delete(
  "/:indicatorId/submissions/:submissionId",
  deleteSubmission
);

// ─── NEW: Admin soft‑delete a single document (with reason) ──────────────
router.patch(
  "/:indicatorId/delete-document",
  deleteDocumentAdmin
);

export default router;