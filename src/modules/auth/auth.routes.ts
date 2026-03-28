import { Router } from "express";
import { AuthController } from "./auth.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// ─── Public Routes ───────────────────────────────────────────────────────────

// Step 1: Request OTP
router.post("/request-otp", AuthController.requestOTP);

// Step 2: Verify OTP & login
router.post("/login", AuthController.login);

// Refresh access token
router.get("/refresh", AuthController.refreshToken);

// ─── Protected Routes ────────────────────────────────────────────────────────

// Logout (must be logged in to log out)
router.post("/logout", protect, AuthController.logout);

// Register new user — SuperAdmin only
router.post("/register", protect, restrictTo("superadmin"), AuthController.register);

export default router;