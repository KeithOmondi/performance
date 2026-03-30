import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { Team } from "../user/team.model";
import { User } from "../user/user.model";
import { sendMail } from "../../utils/sendMail";

/* ------------------------------------------------------------------ */
/*  Helper: sync team field on User documents                          */
/* ------------------------------------------------------------------ */

/**
 * Sets `user.team = teamId` for every userId in `add`,
 * and clears `user.team = null` for every userId in `remove`.
 * Runs in a single bulkWrite for efficiency.
 */
// Derive the exact type Mongoose's bulkWrite() expects from its own signature.
// This avoids the mongodb ↔ mongoose AnyBulkWriteOperation mismatch.
type UserBulkOp = Parameters<typeof User.bulkWrite>[0][number];

async function syncUserTeamField(
  teamId: mongoose.Types.ObjectId,
  add: mongoose.Types.ObjectId[] = [],
  remove: mongoose.Types.ObjectId[] = [],
) {
  const ops: UserBulkOp[] = [];

  if (add.length) {
    ops.push({
      updateMany: {
        filter: { _id: { $in: add } },
        update: { $set: { team: teamId } },
      },
    });
  }

  if (remove.length) {
    ops.push({
      updateMany: {
        filter: { _id: { $in: remove }, team: teamId },
        update: { $set: { team: null } },
      },
    });
  }

  if (ops.length) await User.bulkWrite(ops);
}

/* ------------------------------------------------------------------ */
/*  1. Create Team                                                      */
/* ------------------------------------------------------------------ */
export const createTeam = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, teamLead, members = [] } = req.body;

  if (!name || !teamLead) {
    throw new AppError("Team name and team lead are required.", 400);
  }

  // Validate teamLead exists
  const lead = await User.findById(teamLead).select("name email");
  if (!lead) throw new AppError("Team lead user not found.", 404);

  // Build unique member list (lead always included)
  const memberIds: mongoose.Types.ObjectId[] = [
    ...new Set([teamLead, ...members].map(String)),
  ].map((id) => new mongoose.Types.ObjectId(id));

  // Validate all members exist
  const foundUsers = await User.find({ _id: { $in: memberIds } }).select(
    "_id name email",
  );
  if (foundUsers.length !== memberIds.length) {
    throw new AppError("One or more member user IDs are invalid.", 400);
  }

  const team = await Team.create({
    name,
    description,
    teamLead,
    members: memberIds,
    createdBy: req.user!._id,
  });

  // Sync team field on every member's User document
  await syncUserTeamField(team._id, memberIds);

  // Notify all members
  try {
    await Promise.all(
      foundUsers.map((u) =>
        sendMail({
          to: u.email,
          subject: `You've been added to team "${team.name}"`,
          html: teamAddedTemplate(u.name, team.name, lead.name, foundUsers),
        }),
      ),
    );
  } catch (err) {
    console.error("[MAIL] Team creation notification failed:", err);
  }

  const populated = await Team.findById(team._id)
    .populate("teamLead", "name email title pjNumber")
    .populate("members", "name email title pjNumber")
    .populate("createdBy", "name email");

  res.status(201).json({ success: true, data: populated });
});

/* ------------------------------------------------------------------ */
/*  2. Get All Teams                                                    */
/* ------------------------------------------------------------------ */
export const getAllTeams = asyncHandler(
  async (_req: Request, res: Response) => {
    const teams = await Team.find()
      .populate("teamLead", "name email title pjNumber")
      .populate("members", "name email title pjNumber")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, count: teams.length, data: teams });
  },
);

/* ------------------------------------------------------------------ */
/*  3. Get Single Team                                                  */
/* ------------------------------------------------------------------ */
export const getTeamById = asyncHandler(async (req: Request, res: Response) => {
  const team = await Team.findById(req.params.id)
    .populate("teamLead", "name email title pjNumber")
    .populate("members", "name email title pjNumber")
    .populate("createdBy", "name email")
    .lean();

  if (!team) throw new AppError("Team not found.", 404);

  res.status(200).json({ success: true, data: team });
});

/* ------------------------------------------------------------------ */
/*  4. Update Team (name, description, teamLead)                       */
/* ------------------------------------------------------------------ */
export const updateTeam = asyncHandler(async (req: Request, res: Response) => {
  const team = await Team.findById(req.params.id);
  if (!team) throw new AppError("Team not found.", 404);

  const { name, description, teamLead } = req.body;

  if (name) team.name = name;
  if (description !== undefined) team.description = description;

  if (teamLead && teamLead.toString() !== team.teamLead.toString()) {
    const lead = await User.findById(teamLead);
    if (!lead) throw new AppError("New team lead user not found.", 404);

    // Ensure new lead is a member
    const isAlreadyMember = team.members.some(
      (m) => m.toString() === teamLead.toString(),
    );
    if (!isAlreadyMember) team.members.push(teamLead);

    team.teamLead = teamLead;
  }

  await team.save();

  const populated = await Team.findById(team._id)
    .populate("teamLead", "name email title pjNumber")
    .populate("members", "name email title pjNumber");

  res.status(200).json({ success: true, data: populated });
});

/* ------------------------------------------------------------------ */
/*  5. Add Members to Team                                              */
/* ------------------------------------------------------------------ */
export const addTeamMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { memberIds } = req.body; // array of user IDs

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new AppError("memberIds must be a non-empty array.", 400);
    }

    const team = await Team.findById(req.params.id);
    if (!team) throw new AppError("Team not found.", 404);

    // Filter out already-existing members
    const existingStrs = team.members.map((m) => m.toString());
    const newIds = memberIds
      .filter((id: string) => !existingStrs.includes(id.toString()))
      .map((id: string) => new mongoose.Types.ObjectId(id));

    if (newIds.length === 0) {
      return res
        .status(200)
        .json({ success: true, message: "All users are already members." });
    }

    // Validate users exist
    const newUsers = await User.find({ _id: { $in: newIds } }).select(
      "_id name email",
    );
    if (newUsers.length !== newIds.length) {
      throw new AppError("One or more user IDs are invalid.", 400);
    }

    team.members.push(...newIds);
    await team.save();

    await syncUserTeamField(team._id, newIds);

    // Notify newly added members — fetch full member list so we can include it in the email
    const lead = await User.findById(team.teamLead).select("name");
    const allTeamMembers = await User.find({ _id: { $in: team.members } }).select("_id name email");
    try {
      await Promise.all(
        newUsers.map((u) =>
          sendMail({
            to: u.email,
            subject: `You've been added to team "${team.name}"`,
            html: teamAddedTemplate(u.name, team.name, lead?.name ?? "Your Team Lead", allTeamMembers),
          }),
        ),
      );
    } catch (err) {
      console.error("[MAIL] Add member notification failed:", err);
    }

    const populated = await Team.findById(team._id)
      .populate("teamLead", "name email title pjNumber")
      .populate("members", "name email title pjNumber");

    return res.status(200).json({ success: true, data: populated });
  },
);

/* ------------------------------------------------------------------ */
/*  6. Remove Members from Team                                         */
/* ------------------------------------------------------------------ */
export const removeTeamMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { memberIds } = req.body;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new AppError("memberIds must be a non-empty array.", 400);
    }

    const team = await Team.findById(req.params.id);
    if (!team) throw new AppError("Team not found.", 404);

    // Cannot remove the team lead
    const leadStr = team.teamLead.toString();
    if (memberIds.some((id: string) => id.toString() === leadStr)) {
      throw new AppError(
        "Cannot remove the team lead. Reassign the lead first.",
        400,
      );
    }

    const removeSet = new Set(memberIds.map(String));
    const removedIds = team.members
      .filter((m) => removeSet.has(m.toString()))
      .map((m) => m as mongoose.Types.ObjectId);

    team.members = team.members.filter(
      (m) => !removeSet.has(m.toString()),
    ) as mongoose.Types.DocumentArray<mongoose.Types.ObjectId>;

    await team.save();
    await syncUserTeamField(team._id, [], removedIds);

    const populated = await Team.findById(team._id)
      .populate("teamLead", "name email title pjNumber")
      .populate("members", "name email title pjNumber");

    res.status(200).json({ success: true, data: populated });
  },
);

/* ------------------------------------------------------------------ */
/*  7. Deactivate / Reactivate Team                                     */
/* ------------------------------------------------------------------ */
export const setTeamActiveStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      throw new AppError("isActive must be a boolean.", 400);
    }

    const team = await Team.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true },
    )
      .populate("teamLead", "name email")
      .populate("members", "name email");

    if (!team) throw new AppError("Team not found.", 404);

    res.status(200).json({ success: true, data: team });
  },
);

/* ------------------------------------------------------------------ */
/*  8. Delete Team                                                      */
/* ------------------------------------------------------------------ */
export const deleteTeam = asyncHandler(async (req: Request, res: Response) => {
  const team = await Team.findById(req.params.id);
  if (!team) throw new AppError("Team not found.", 404);

  // Clear team reference from all members before deleting
  await syncUserTeamField(
    team._id,
    [],
    team.members as unknown as mongoose.Types.ObjectId[],
  );

  await team.deleteOne();

  res.status(200).json({ success: true, message: "Team deleted." });
});

/* ------------------------------------------------------------------ */
/*  Mail template (inline for locality)                                 */
/* ------------------------------------------------------------------ */
function teamAddedTemplate(
  memberName: string,
  teamName: string,
  leadName: string,
  allMembers: { name: string; email: string }[],
): string {
  // Build a row for every member; highlight the recipient with a subtle badge
  const memberRows = allMembers
    .map(
      (m) => `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #111827;">
            ${m.name}
            ${m.name === memberName ? '<span style="margin-left:8px;background:#dbeafe;color:#1d4ed8;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:0.05em;">You</span>' : ""}
            ${m.name === leadName ? '<span style="margin-left:6px;background:#fef9c3;color:#92400e;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:0.05em;">Lead</span>' : ""}
          </td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #6b7280;">${m.email}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: #2563EB; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px;">Performance Management System</h1>
      </div>
      <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none;">
        <h2 style="color: #111827; margin-top: 0;">You've been added to a team 🎉</h2>
        <p style="color: #374151;">Hello <strong>${memberName}</strong>,</p>
        <p style="color: #374151;">
          You have been added to the team <strong>"${teamName}"</strong>.
          Your team lead is <strong>${leadName}</strong>.
        </p>
        <p style="color: #374151;">
          Indicators assigned to this team will appear in your dashboard. You will be
          notified whenever a task is assigned, reviewed, or approved.
        </p>

        <h3 style="color: #111827; font-size: 14px; margin: 28px 0 12px;">Your Team Members</h3>
        <table style="width: 100%; border-collapse: collapse; font-family: Arial, sans-serif;">
          <thead>
            <tr style="background: #f9fafb;">
              <th style="padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #e5e7eb;">Name</th>
              <th style="padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #e5e7eb;">Email</th>
            </tr>
          </thead>
          <tbody>
            ${memberRows}
          </tbody>
        </table>
      </div>
      <div style="padding: 16px 32px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
        <small style="color: #6b7280;">This is an automated message. Please do not reply.</small>
      </div>
    </div>
  `;
}