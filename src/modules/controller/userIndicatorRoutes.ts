import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";

import { upload, requireFiles } from "../../middleware/upload";

const router = Router();

// ── Static GET routes (must precede /:id) ────────────────────────────────────
router.get("/my-assignments", protect, restrictTo("user"),
  UserIndicatorController.getMyIndicators);

router.get("/rejects", protect, restrictTo("user"),
  UserIndicatorController.getRejectedSubmissions);

router.get("/stream-file", protect, restrictTo("user", "admin", "superadmin", "examiner"),
  UserIndicatorController.streamFile);

// ── Single indicator ──────────────────────────────────────────────────────────
router.get("/:id", protect, restrictTo("user"),
  UserIndicatorController.getIndicatorDetails);

// ── Submission actions ────────────────────────────────────────────────────────
router.post("/:id/submit", protect, restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.submitProgress);

// ✅ Updated: Resubmit with support for specific document IDs
router.post("/:id/resubmit", protect, restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.resubmitProgress);

router.post("/:id/add-documents", protect, restrictTo("user"),
  upload.array("documents", 50), requireFiles,
  UserIndicatorController.addDocuments);

router.patch("/:id/update-submission", protect, restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.updateSubmission);

// ── Document operations — SPECIFIC routes before WILDCARD ────────────────────

// Bulk descriptions — must be above :docId wildcard
router.patch("/submissions/:submissionId/documents/descriptions", protect, restrictTo("user"),
  UserIndicatorController.updateDocumentDescriptions);

// Single description
router.patch("/documents/:docId/description", protect, restrictTo("user"),
  UserIndicatorController.updateDocumentDescription);

// ✅ Delete pending document — includes :indicatorId to match frontend thunk URL
router.delete("/:indicatorId/submissions/:submissionId/documents/:docId",
  protect, restrictTo("user"),
  UserIndicatorController.deletePendingDocument);

// ✅ Legacy delete (no indicatorId/submissionId scope)
router.delete("/documents/:docId", protect, restrictTo("user"),
  UserIndicatorController.deleteDocument);

// ── ✅ NEW: Resubmit specific documents ──────────────────────────────────────
router.post("/submissions/:submissionId/documents/resubmit", protect, restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.resubmitDocuments);

// ── ✅ NEW: Approve/Reject individual document (Admin/Super Admin only) ─────
router.patch("/documents/:docId/status", protect, restrictTo("admin", "superadmin"),
  UserIndicatorController.updateDocumentStatus);

// ── ✅ NEW: Get rejected documents for a submission ──────────────────────────
router.get("/submissions/:submissionId/rejected-documents", protect, restrictTo("user", "admin", "superadmin"),
  UserIndicatorController.getRejectedDocuments);

export default router;