import { Router } from "express";
import {
  createIndicator,
  getAllIndicators,
  getIndicatorById,
  submitProgress,
  getAllSubmissions,
  processReview,
  deleteIndicator,
  updateIndicator,
  superAdminDecision,
  getSuperAdminStats,
  getRejectedByAdmin, // New: Oversight for Super Admin
} from "./indicator.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

/* -------------------------------------------------------------------------- */
/* 1. DASHBOARD & QUEUE ROUTES (Specific strings above :id)                   */
/* -------------------------------------------------------------------------- */

// Global stats for the Super Admin dashboard
router.get(
  "/dashboard-stats", 
  protect, 
  restrictTo("superadmin"), 
  getSuperAdminStats
);

// The main processing queue
router.get(
  "/submissions/queue", 
  protect, 
  restrictTo("superadmin"), 
  getAllSubmissions
);

// NEW: Oversight route to see what lower-level admins have rejected
router.get(
  "/rejected-by-admin", 
  protect, 
  restrictTo("superadmin"), 
  getRejectedByAdmin
);


/* -------------------------------------------------------------------------- */
/* 2. CORE INDICATOR ACTIONS                                                  */
/* -------------------------------------------------------------------------- */

// Get all indicators (The general registry)
router.get("/", protect, restrictTo("superadmin"), getAllIndicators);

// Create indicator (Admin assigns KPI)
router.post("/", protect, restrictTo("superadmin"), createIndicator);

// Get a single indicator detail
router.get("/:id", protect, restrictTo("superadmin"), getIndicatorById);

// Submit progress (Update by assignee)
router.post("/:id/submit", protect, restrictTo("superadmin"), submitProgress);


/* -------------------------------------------------------------------------- */
/* 3. REVIEW & DECISION LOGIC                                                 */
/* -------------------------------------------------------------------------- */

// Standard Review (Admin level or initial Super Admin review)
router.patch("/:id/review", protect, restrictTo("superadmin"), processReview);

// Final Oversight Decision (Super Admin finalizes or overrules)
// Updated to POST to match your controller logic
router.post(
  "/super-admin/decision/:id", 
  protect, 
  restrictTo("superadmin"), 
  superAdminDecision
);


/* -------------------------------------------------------------------------- */
/* 4. MANAGEMENT (CRUD)                                                       */
/* -------------------------------------------------------------------------- */

router.patch("/:id", protect, restrictTo("superadmin"), updateIndicator);
router.delete("/:id", protect, restrictTo("superadmin"), deleteIndicator);

export const IndicatorRoutes = router;