import { Router } from "express";
import {
  getAllExaminerAssignments,
  assignExaminerToFolder,
  unassignExaminerFromFolder,
  getMyExaminerFolders,
  getExaminers,
  downloadFolder,
} from "./examinerAssignment.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);

/* ── Examiner assignment (superadmin + supervisor, all folders) ── */
router.get(
  "/",
  restrictTo("superadmin", "supervisor"),
  getAllExaminerAssignments
);

router.get(
  "/examiners",
  restrictTo("superadmin", "supervisor"),
  getExaminers
);

router.post(
  "/",
  restrictTo("superadmin", "supervisor"),
  assignExaminerToFolder
);

/* ── Folder contents (examiner: own folders; supervisor/superadmin: all) ── */
router.get(
  "/my-folders",
  restrictTo("examiner", "supervisor", "superadmin"),
  getMyExaminerFolders
);

router.get(
  "/folders/:objectiveId/download",
  restrictTo("examiner", "supervisor", "superadmin"),
  downloadFolder
);

router.delete(
  "/:objectiveId",
  restrictTo("superadmin", "supervisor"),
  unassignExaminerFromFolder
);

export default router;
