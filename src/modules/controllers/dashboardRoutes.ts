import { Router } from "express";
import { getDashboardStats } from "./dashboard.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

/**
 * GET /api/superadmin/dashboard
 * Superadmin only — returns stats, perspectives, and recent submissions.
 */
router.get("/stats", protect, restrictTo("superadmin", "admin"), getDashboardStats);

export default router;