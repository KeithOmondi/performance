import { Router } from "express";
import {
  getAllExaminerAssignments,
  assignExaminerToFolder,
  unassignExaminerFromFolder,
  getMyExaminerFolders,
  getExaminers,
} from "./examinerAssignment.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

router.use(protect);

/* ── Superadmin routes ── */
router.get(
  "/",
  restrictTo("superadmin"),
  getAllExaminerAssignments
);

router.get(
  "/examiners",
  restrictTo("superadmin"),
  getExaminers
);

router.post(
  "/",
  restrictTo("superadmin"),
  assignExaminerToFolder
);

router.delete(
  "/:objectiveId",
  restrictTo("superadmin"),
  unassignExaminerFromFolder
);

/* ── Examiner route ── */
router.get(
  "/my-folders",
  restrictTo("examiner", "superadmin"),
  getMyExaminerFolders
);

export default router;