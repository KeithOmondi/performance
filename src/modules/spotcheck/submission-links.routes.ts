import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import {
  linkSpotCheckDocuments,
  unlinkSpotCheckDocuments,
  getSubmissionSpotCheckLinks,
} from "./spot-check.controller";

const router = Router();

router.use(protect);

router.post(
  "/:submissionId/spot-check-links",
  restrictTo("user"),
  linkSpotCheckDocuments
);

router.delete(
  "/:submissionId/spot-check-links",
  restrictTo("user"),
  unlinkSpotCheckDocuments
);

router.get(
  "/:submissionId/spot-check-links",
  restrictTo("user", "admin", "superadmin"),
  getSubmissionSpotCheckLinks
);

export default router;