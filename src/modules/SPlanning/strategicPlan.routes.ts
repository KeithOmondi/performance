import express from "express";
import { StrategicPlanController } from "./strategicPlan.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = express.Router();

/* Clean RESTful Design:
  - POST   /            -> Create a new plan
  - GET    /            -> Fetch all plans
  - GET    /:id         -> Fetch one plan
  - PATCH  /:id         -> Update one plan
  - DELETE /:id         -> Delete one plan
*/

router.post("/", protect, restrictTo("superadmin"), StrategicPlanController.createStrategicPlan);

router.get("/", protect, restrictTo("superadmin", "admin"), StrategicPlanController.fetchAllStrategicPlans);

router.get("/:id", protect, restrictTo("superadmin"),  StrategicPlanController.fetchStrategicPlanById);

router.patch("/:id", protect, restrictTo("superadmin"), StrategicPlanController.updateStrategicPlan);

router.delete("/:id", protect, restrictTo("superadmin"), StrategicPlanController.deleteStrategicPlan);

export const StrategicPlanRoutes = router;