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

export const StrategicPlanRoutes = router;
