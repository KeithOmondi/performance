import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import userRoutes from "../modules/auth/user.routes";
import { StrategicPlanRoutes } from "../modules/SPlanning/strategicPlan.routes";
import { IndicatorRoutes } from "../modules/superadmin/indicator.routes";
import  userIndicatorRoutes  from "../modules/controller/userIndicatorRoutes";
import adminIndicatorRoutes from "../modules/admin/adminIndicatorRoutes"
import reportsRoutes from "../modules/superadmin/report.routes"
import registryRoute from  "../modules/registry/registryRoute"

const router = Router();

// Test route
router.get("/test", (_req, res) => {
  res.json({ message: "Test route working ✅" });
});

// Auth routes
router.use("/auth", authRoutes);

// User management routes
router.use("/users", userRoutes);

// Strategic plans routes
router.use("/strategic-plans", StrategicPlanRoutes);
router.use("/indicators", IndicatorRoutes);
router.use("/user-indicators", userIndicatorRoutes);
router.use("/admin", adminIndicatorRoutes);
router.use("/reports", reportsRoutes);
router.use("/registry", registryRoute);

export default router;