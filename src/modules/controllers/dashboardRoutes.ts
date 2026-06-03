// src/routes/dashboard.routes.ts
import { Router } from "express";
import { DashboardController } from "../controllers/dashboard.controller";
import { protect } from "../../middleware/auth.middleware";

const router = Router();

// All dashboard routes are protected (any authenticated user can view)
router.use(protect);

router.get("/stats", DashboardController.getStats);
router.get("/recent-submissions", DashboardController.getRecentSubmissions);
router.get("/team-overview", DashboardController.getTeamOverview);

export default router;