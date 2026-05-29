import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { UserIndicatorController } from "./userIndicatorController";
import { upload, requireFiles } from "../../middleware/upload";

const router = Router();

// 1. Get all assigned indicators
router.get(
  "/my-assignments",
  protect,
  restrictTo("user"),
  UserIndicatorController.getMyIndicators,
);

// 2. Get only indicators with rejected submissions (Archive)
// Note: Placed above /:id to avoid route parameter collision
router.get(
  "/rejects",
  protect,
  restrictTo("user"),
  UserIndicatorController.getRejectedSubmissions,
);

// 3. Stream file proxy
router.get(
  "/stream-file",
  protect,
  restrictTo("user", "admin", "superadmin", "examiner"),
  UserIndicatorController.streamFile,
);

// 4. Get single indicator details
router.get(
  "/:id",
  protect,
  restrictTo("user"),
  UserIndicatorController.getIndicatorDetails,
);

// 5. Submit progress (first-time only)
router.post(
  "/:id/submit",
  protect,
  restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.submitProgress,
);

// 6. Resubmit progress (existing submission only)
router.post(
  "/:id/resubmit",
  protect,
  restrictTo("user"),
  upload.array("documents", 50),
  UserIndicatorController.resubmitProgress,
);

// 7. Add documents to an existing submission (append only)
router.post(
  "/:id/add-documents",
  protect,
  restrictTo("user"),
  upload.array("documents", 50),
  requireFiles,
  UserIndicatorController.addDocuments,
);

// 8. Delete a single document (legacy - use /:id/submissions/:submissionId/documents/:docId instead)
router.delete(
  "/documents/:docId",
  protect,
  restrictTo("user"),
  UserIndicatorController.deleteDocument,
);

// 9. Update/correct a rejected submission
router.patch(
  "/:id/update-submission",
  protect,
  restrictTo("user"),
  UserIndicatorController.updateSubmission,
);

// 10. Update multiple document descriptions for a submission
router.patch(
  "/submissions/:submissionId/documents/descriptions",
  protect,
  restrictTo("user"),
  UserIndicatorController.updateDocumentDescriptions,
);

// 11. Update single document description
router.patch(
  "/documents/:docId/description",
  protect,
  restrictTo("user"),
  UserIndicatorController.updateDocumentDescription,
);


router.delete(
  "/:id/submissions/:submissionId/documents/:docId",
  protect,
  restrictTo("user"),
  UserIndicatorController.deletePendingDocument,
);

export default router;