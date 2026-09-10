import { Router } from "express";
import {
  createSpotCheck,
  getSpotChecks,
  getSpotCheck,
  updateSpotCheck,
  deleteSpotCheck,
  deleteSpotCheckDocument,
  getSpotCheckLibrary,
} from "./spot-check.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { requireFiles, uploadBulkEvidence } from "../../middleware/upload";

const router = Router();

// All routes require auth.
router.use(protect);

// ── Library: submission-page picker ──
router.get("/library", getSpotCheckLibrary);

// ── Library: admin CRUD ──
router.post(
  "/",
  restrictTo("superadmin", "admin", "user"),
  uploadBulkEvidence,
  requireFiles,
  createSpotCheck
);
router.get("/", getSpotChecks);
router.get("/:id", getSpotCheck);
router.patch(
  "/:id",
  restrictTo("superadmin", "admin", "user"),
  uploadBulkEvidence,
  updateSpotCheck
);
router.delete("/:id", restrictTo("superadmin", "admin"), deleteSpotCheck);

// ── Documents ──
router.delete(
  "/documents/:documentId",
  restrictTo("superadmin", "admin"),
  deleteSpotCheckDocument
);

export default router;