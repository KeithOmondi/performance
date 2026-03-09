import { Router } from "express";
import {
  listUsers,
  getUser,
  updateUserRole,
  toggleUserActive,
} from "./user.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// --- All routes below require being logged in ---
router.use(protect);

// -------------------------
// Routes
// -------------------------

// List all users: Accessible by Admin and Superadmin
router.get("/", restrictTo("admin", "superadmin"), listUsers);

// Get single user by ID: Accessible by Admin and Superadmin
router.get("/:id", restrictTo("admin", "superadmin"), getUser);

// Update user role: STRICKLY Superadmin only
router.patch("/:id/role", restrictTo("superadmin"), updateUserRole);

// Activate / Deactivate user: Accessible by Admin and Superadmin
router.patch("/:id/toggle", restrictTo("admin", "superadmin"), toggleUserActive);

export default router;