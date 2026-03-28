import { Router } from "express";
import {
  listUsers,
  getUser,
  updateUserRole,
  toggleUserActive,
  createUser, // 👈 Add the new controller here
} from "./user.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// All routes require authentication
router.use(protect);

// ─── Admin + SuperAdmin ───────────────────────────────────────────────────────

// List all users
router.get("/", restrictTo("admin", "superadmin"), listUsers);

// Get single user
router.get("/:id", restrictTo("admin", "superadmin"), getUser);

// Create new user 👈 ADD THIS ROUTE
router.post("/", restrictTo("superadmin"), createUser);

// ─── SuperAdmin Only ──────────────────────────────────────────────────────────

// Toggle active/inactive
router.patch("/:id/toggle", restrictTo("superadmin"), toggleUserActive);

// Update user role
router.patch("/:id/role", restrictTo("superadmin"), updateUserRole);

export default router;