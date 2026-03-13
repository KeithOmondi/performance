import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { validateSubmissionWindow } from "../../middleware/submissionGuard";
import { submitProgress } from "../superadmin/indicator.controller";
import { 
  getRegistryStatus, 
  configureRegistry, 
  toggleRegistryLock 
} from "../registry/registryController"; // Update path as per your folder structure

const router = Router();

// --- REGISTRY GOVERNANCE (The Control Tower) ---

/**
 * @route   GET /api/indicators/registry/status
 * @desc    Fetch open/closed windows for the current year
 * @access  All Authenticated Users (User needs this to disable buttons)
 */
router.get(
  "/registry/status", 
  protect, 
  getRegistryStatus
);

/**
 * @route   POST /api/indicators/registry/configure
 * @desc    Set start/end dates for a specific quarter
 * @access  Super Admin Only
 */
router.post(
  "/registry/configure", 
  protect, 
  restrictTo("superadmin"), 
  configureRegistry
);

/**
 * @route   PATCH /api/indicators/registry/lock/:id
 * @desc    Emergency freeze for a specific quarter window
 * @access  Admin & Super Admin
 */
router.patch(
  "/registry/lock/:id", 
  protect, 
  restrictTo("admin", "superadmin"), 
  toggleRegistryLock
);


// --- INDICATOR SUBMISSIONS (The Business Logic) ---

/**
 * @route   POST /api/indicators/submit-progress/:id
 * @desc    User submits evidence for a specific indicator
 * @access  Protected + Gatekeeper Checked
 */
router.post(
  "/submit-progress/:id", 
  protect, 
  validateSubmissionWindow, // Logic: Check if config exists and dates are valid
  submitProgress            // Logic: Save the submission to DB
);

export default router;