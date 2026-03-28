import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import {
  getRegistryStatus,
  configureRegistry,
  toggleRegistryLock,
} from "./registryController";

const router = Router();

router.use(protect);

// ─── All authenticated users ──────────────────────────────────────────────────
router.get("/status", getRegistryStatus);

// ─── SuperAdmin only ──────────────────────────────────────────────────────────
router.post("/configure", restrictTo("superadmin"), configureRegistry);

// ─── Admin + SuperAdmin ───────────────────────────────────────────────────────
router.patch("/lock/:id", restrictTo("admin", "superadmin"), toggleRegistryLock);

export default router;