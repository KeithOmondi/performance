import { Router } from "express";
import {
  fetchIndicatorsForAdmin,
  getIndicatorByIdAdmin,
  approveSubmission,
  rejectSubmission,
  fetchResubmittedIndicators,
} from "../admin/adminIndicatorController";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { getCalendarEvents, getIndicatorCalendarEvents, getUpcomingDeadlines } from "../calendar/calendarcontroller";

const router = Router();

router.use(protect);
router.use(restrictTo("admin"));

// ─── Collection Routes ───────────────────────────────────────────────────────
router.get("/all", fetchIndicatorsForAdmin);
router.get("/resubmitted", fetchResubmittedIndicators);

// ─── Calendar Routes (must be before /:id) ───────────────────────────────────
router.get("/calendar/upcoming", getUpcomingDeadlines);
router.get("/calendar/:id",      getIndicatorCalendarEvents);
router.get("/calendar",          getCalendarEvents);

// ─── Single Resource Routes ──────────────────────────────────────────────────
router.get("/:id", getIndicatorByIdAdmin);

// ─── Action Routes ───────────────────────────────────────────────────────────
router.patch("/:id/approve", approveSubmission);
router.patch("/:id/reject", rejectSubmission);

export default router;