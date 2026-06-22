import express from "express";
import { StrategicPlanController } from "./strategicPlan.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = express.Router();

router.use(protect);

// ─── SuperAdmin + Admin ───────────────────────────────────────────────────────
router.get(
  "/",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.fetchAllStrategicPlans,
);
router.get(
  "/:id",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.fetchStrategicPlanById,
);

// ─── SuperAdmin only ──────────────────────────────────────────────────────────
router.post(
  "/",
  restrictTo("superadmin"),
  StrategicPlanController.createStrategicPlan,
);
router.patch(
  "/:id",
  restrictTo("superadmin"),
  StrategicPlanController.updateStrategicPlan,
);
router.delete(
  "/:id",
  restrictTo("superadmin"),
  StrategicPlanController.deleteStrategicPlan,
);

// strategicPlan.routes.ts

// ─── OBJECTIVES (superadmin only) ────────────────────────────────────────────
router.post(
  "/:id/objectives",
  restrictTo("superadmin"),
  StrategicPlanController.addObjective,
);
router.patch(
  "/objectives/:objectiveId",
  restrictTo("superadmin"),
  StrategicPlanController.updateObjective,
);

// ─── ACTIVITIES (superadmin only) ────────────────────────────────────────────
router.post(
  "/objectives/:objectiveId/activities",
  restrictTo("superadmin"),
  StrategicPlanController.addActivity,
);
router.patch(
  "/activities/:activityId",
  restrictTo("superadmin"),
  StrategicPlanController.updateActivity,
);

// ─── INDICATOR LOOKUP ────────────────────────────────────────────────────────
router.get(
  "/activities/:activityId/indicator",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.getIndicatorByActivity,
);

export const StrategicPlanRoutes = router;
