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
  restrictTo("superadmin", "admin"),
  StrategicPlanController.createStrategicPlan,
);
router.patch(
  "/:id",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.updateStrategicPlan,
);
router.delete(
  "/:id",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.deleteStrategicPlan,
);

// ─── OBJECTIVES ────────────────────────────────────────────────────────────────
router.post(
  "/:id/objectives",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.addObjective,
);
router.patch(
  "/objectives/:objectiveId",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.updateObjective,
);

// ─── ACTIVITIES ────────────────────────────────────────────────────────────────
router.post(
  "/objectives/:objectiveId/activities",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.addActivity,
);
router.patch(
  "/activities/:activityId",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.updateActivity,
);
router.delete(
  "/activities/:activityId",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.deleteActivity,
);
router.post(
  "/objectives/:objectiveId/reorder-activities",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.reorderActivities,
);

// ─── INDICATOR LOOKUP ────────────────────────────────────────────────────────
router.get(
  "/activities/:activityId/indicator",
  restrictTo("superadmin", "admin"),
  StrategicPlanController.getIndicatorByActivity,
);

export const StrategicPlanRoutes = router;