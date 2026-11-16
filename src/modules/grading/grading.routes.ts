import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import {
  getSchedule,
  gradeObjective,
  getGradeHistory,
  updateScheduleValues,
  downloadScheduleReport,
} from "./grading.controller";

const router = Router();
router.use(protect);

// Schedule 1 scorecard lives on the super admin side only
router.get("/schedule", restrictTo("superadmin"), getSchedule);
router.get("/report.pdf", restrictTo("superadmin"), downloadScheduleReport);
router.get("/objectives/:objectiveId/history", restrictTo("superadmin"), getGradeHistory);

// Fill in "Actual": super admin only
router.put("/objectives/:objectiveId", restrictTo("superadmin"), gradeObjective);

// Correct Schedule 1 weights/baseline/target: super admin only
router.patch("/objectives/:objectiveId/weights", restrictTo("superadmin"), updateScheduleValues);

export default router;
