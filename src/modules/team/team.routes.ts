import { Router } from "express";
import {
  createTeam,
  getAllTeams,
  getTeamById,
  updateTeam,
  addTeamMembers,
  removeTeamMembers,
  setTeamActiveStatus,
  deleteTeam,
} from "./team.controller";
import { protect, restrictTo } from "../../middleware/auth.middleware";

const router = Router();

// All team routes require authentication; most require superadmin
router.use(protect);

router
  .route("/")
  .get(restrictTo("superadmin", "admin"), getAllTeams)          // list all teams
  .post(restrictTo("superadmin"), createTeam);                  // create team

router
  .route("/:id")
  .get(restrictTo("superadmin", "admin"), getTeamById)          // single team
  .patch(restrictTo("superadmin"), updateTeam)                  // rename / change lead
  .delete(restrictTo("superadmin"), deleteTeam);                // delete team

router.patch(
  "/:id/members/add",
  restrictTo("superadmin"),
  addTeamMembers,                                               // body: { memberIds: [] }
);

router.patch(
  "/:id/members/remove",
  restrictTo("superadmin"),
  removeTeamMembers,                                            // body: { memberIds: [] }
);

router.patch(
  "/:id/status",
  restrictTo("superadmin"),
  setTeamActiveStatus,                                          // body: { isActive: bool }
);

export default router;