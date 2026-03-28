import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import userRoutes from "../modules/auth/user.routes";
import { StrategicPlanRoutes } from "../modules/SPlanning/strategicPlan.routes";
import { IndicatorRoutes } from "../modules/superadmin/indicator.routes";
import userIndicatorRoutes from "../modules/controller/userIndicatorRoutes";
import adminIndicatorRoutes from "../modules/admin/adminIndicatorRoutes";
import reportsRoutes from "../modules/superadmin/report.routes";
import registryRoute from "../modules/registry/registryRoute";

const router = Router();

// ----------------  Health / Test ----------------
router.get("/test", (_req, res) => {
  res.json({ message: "Test route working ✅" });
});

// ---------------- Auth ----------------
router.use("/auth", authRoutes);

// ---------------- User Management ----------------
router.use("/users", userRoutes);

// ---------------- Strategic Plans ----------------
router.use("/strategic-plans", StrategicPlanRoutes);

// ---------------- Indicators (SuperAdmin) ----------------
router.use("/indicators", IndicatorRoutes);

// ---------------- User Indicator Submissions ----------------
router.use("/user-indicators", userIndicatorRoutes);

// ---------------- Admin Approval ----------------
router.use("/admin", adminIndicatorRoutes);

// ---------------- Reports ----------------
router.use("/reports", reportsRoutes);

// ---------------- Registry ----------------
router.use("/registry", registryRoute);

export default router;