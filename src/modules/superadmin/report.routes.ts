import express from "express";
import {
  getTrackerReport,
  getReportByPlanId,
  getReportSummary,
  getTrackerPdf,        // ← add this once you build the PDF endpoint
} from "./report.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = express.Router();

router.use(protect);
router.use(restrictTo("superadmin", "admin"));

// ── Static routes FIRST ──────────────────────────────────────────────────────
router.get("/",        getTrackerReport);   // GET /api/reports
router.get("/summary", getReportSummary);   // GET /api/reports/summary
router.get("/pdf",     getTrackerPdf);      // GET /api/reports/pdf  ← before /:planId

// ── Param routes LAST ────────────────────────────────────────────────────────
router.get("/:planId", getReportByPlanId);  // GET /api/reports/:planId

export const ReportRoutes = router;