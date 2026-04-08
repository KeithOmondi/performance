import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { sendMail } from "../../utils/sendMail";

/* ─── SHARED SELECT FRAGMENT ──────────────────────────────────────────────────
   Returns a camelCase-aliased team row that matches the ITeam frontend type.
────────────────────────────────────────────────────────────────────────────── */
const TEAM_SELECT = `
  SELECT
    t.id,
    t.name,
    t.description,
    t.team_lead_id   AS "teamLeadId",
    t.created_by     AS "createdBy",
    t.is_active      AS "isActive",
    t.created_at     AS "createdAt",
    t.updated_at     AS "updatedAt",
    u.name           AS "leadName",
    u.email          AS "leadEmail",
    cb.name          AS "creatorName",
    (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS "memberCount"
  FROM teams t
  LEFT JOIN users u  ON t.team_lead_id = u.id
  LEFT JOIN users cb ON t.created_by = cb.id
`;

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */

async function syncTeamMembers(client: any, teamId: string, userIds: string[]) {
  await client.query("DELETE FROM team_members WHERE team_id = $1", [teamId]);
  if (userIds.length > 0) {
    const values = userIds.map((_, idx) => `($1, $${idx + 2})`).join(",");
    await client.query(
      `INSERT INTO team_members (team_id, user_id) VALUES ${values}`,
      [teamId, ...userIds]
    );
  }
}

async function getTeamWithMembers(teamId: string) {
  const teamRes = await pool.query(`${TEAM_SELECT} WHERE t.id = $1`, [teamId]);
  const team = teamRes.rows[0];
  if (!team) return null;

  const membersRes = await pool.query(
    `SELECT u.id, u.name, u.email, u.title, u.pj_number AS "pjNumber", u.role
     FROM users u
     JOIN team_members tm ON u.id = tm.user_id
     WHERE tm.team_id = $1`,
    [teamId]
  );

  return { ...team, members: membersRes.rows };
}

/* ─── 1. CREATE TEAM ──────────────────────────────────────────────────────── */
export const createTeam = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, teamLead, members = [] } = req.body;
  const createdBy = (req as any).user.id;

  if (!name || !teamLead) throw new AppError("Team name and lead are required.", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const teamRes = await client.query(
      `INSERT INTO teams (name, description, team_lead_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, description, teamLead, createdBy]
    );
    const teamId = teamRes.rows[0].id;

    const uniqueMembers = Array.from(new Set([teamLead, ...members])) as string[];
    await syncTeamMembers(client, teamId, uniqueMembers);

    await client.query("COMMIT");

    const fullTeam = await getTeamWithMembers(teamId);

    // ✅ Fixed: added u.id to SELECT so the lead lookup actually works
    pool.query("SELECT id, name, email FROM users WHERE id = ANY($1)", [uniqueMembers])
      .then(({ rows }) => {
        const lead = rows.find((u) => u.id === teamLead);
        rows.forEach((u) =>
          sendMail({
            to: u.email,
            subject: `Added to team: ${name}`,
            html: teamAddedTemplate(u.name, name, lead?.name ?? "Team Lead", rows),
          })
        );
      })
      .catch((err) => console.error("Team creation email error:", err));

    res.status(201).json({ success: true, data: fullTeam });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

/* ─── 2. GET ALL TEAMS ────────────────────────────────────────────────────── */
/* ─── 2. GET ALL TEAMS (with members) ────────────────────────────────────── */
export const getAllTeams = asyncHandler(async (_req: Request, res: Response) => {
  // Step 1: fetch all team rows
  const { rows: teams } = await pool.query(
    `${TEAM_SELECT} ORDER BY t.created_at DESC`
  );

  if (teams.length === 0) {
    return res.status(200).json({ success: true, data: [] });
  }

  // Step 2: fetch ALL members for ALL teams in ONE query (no N+1)
  const teamIds = teams.map((t) => t.id);
  const { rows: members } = await pool.query(
    `SELECT
       tm.team_id   AS "teamId",
       u.id,
       u.name,
       u.email,
       u.title,
       u.pj_number  AS "pjNumber",
       u.role
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ANY($1)`,
    [teamIds]
  );

  // Step 3: group members by teamId and attach
  const membersByTeamId = members.reduce<Record<string, any[]>>((acc, m) => {
    const { teamId, ...member } = m;
    if (!acc[teamId]) acc[teamId] = [];
    acc[teamId].push(member);
    return acc;
  }, {});

  const data = teams.map((team) => ({
    ...team,
    members: membersByTeamId[team.id] ?? [],
  }));

  res.status(200).json({ success: true, data });
});

/* ─── 3. GET SINGLE TEAM (with members) ──────────────────────────────────── */
export const getTeamById = asyncHandler(async (req: Request, res: Response) => {
  const team = await getTeamWithMembers(req.params.id as string);
  if (!team) throw new AppError("Team not found.", 404);
  res.status(200).json({ success: true, data: team });
});

/* ─── 4. UPDATE TEAM ──────────────────────────────────────────────────────── */
export const updateTeam = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name, description, teamLead, members, isActive } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE teams SET
         name         = COALESCE($1, name),
         description  = COALESCE($2, description),
         team_lead_id = COALESCE($3, team_lead_id),
         is_active    = COALESCE($4, is_active),
         updated_at   = NOW()
       WHERE id = $5`,
      [name, description, teamLead, isActive, id]
    );

    // ✅ Fixed: if teamLead or members changed, re-sync the join table
    // so team_members stays consistent with the teams table
    if (teamLead !== undefined || members !== undefined) {
      // Fetch the current lead in case only members were passed (not teamLead)
      const leadRes = await client.query(
        "SELECT team_lead_id FROM teams WHERE id = $1",
        [id]
      );
      const currentLeadId = leadRes.rows[0]?.team_lead_id;

      const baseMembers: string[] = members ?? [];
      const uniqueMembers = Array.from(
        new Set([currentLeadId, ...baseMembers])
      ) as string[];

      await syncTeamMembers(client, id, uniqueMembers);
    }

    await client.query("COMMIT");

    const team = await getTeamWithMembers(id);
    if (!team) throw new AppError("Team not found.", 404);
    res.status(200).json({ success: true, data: team });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

/* ─── 5. DELETE TEAM ──────────────────────────────────────────────────────── */
export const deleteTeam = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rowCount } = await pool.query("DELETE FROM teams WHERE id = $1", [id]);
  if (rowCount === 0) throw new AppError("Team not found.", 404);
  res.status(200).json({ success: true, message: "Team removed." });
});

/* ─── 6. ADD MEMBERS ──────────────────────────────────────────────────────── */
export const addTeamMembers = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { memberIds } = req.body;

  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new AppError("memberIds must be a non-empty array.", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const teamCheck = await client.query("SELECT id FROM teams WHERE id = $1", [id]);
    if (!teamCheck.rows[0]) throw new AppError("Team not found.", 404);

    const values = memberIds.map((_, idx) => `($1, $${idx + 2})`).join(",");
    await client.query(
      `INSERT INTO team_members (team_id, user_id) VALUES ${values}
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [id, ...memberIds]
    );

    await client.query("COMMIT");

    const team = await getTeamWithMembers(id);
    res.status(200).json({ success: true, message: "Members added successfully.", data: team });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

/* ─── 7. REMOVE MEMBERS ───────────────────────────────────────────────────── */
export const removeTeamMembers = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { memberIds } = req.body;

  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new AppError("memberIds must be a non-empty array.", 400);
  }

  const teamRes = await pool.query("SELECT team_lead_id FROM teams WHERE id = $1", [id]);
  if (!teamRes.rows[0]) throw new AppError("Team not found.", 404);

  if (memberIds.includes(teamRes.rows[0].team_lead_id)) {
    throw new AppError("Cannot remove the Team Lead. Reassign leadership first.", 400);
  }

  await pool.query(
    "DELETE FROM team_members WHERE team_id = $1 AND user_id = ANY($2)",
    [id, memberIds]
  );

  const team = await getTeamWithMembers(id);
  res.status(200).json({ success: true, message: "Members removed.", data: team });
});

/* ─── 8. SET ACTIVE STATUS ────────────────────────────────────────────────── */
export const setTeamActiveStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") throw new AppError("isActive must be a boolean.", 400);

  await pool.query(
    "UPDATE teams SET is_active = $1, updated_at = NOW() WHERE id = $2",
    [isActive, id]
  );

  const team = await getTeamWithMembers(id);
  if (!team) throw new AppError("Team not found.", 404);

  res.status(200).json({
    success: true,
    message: `Team ${isActive ? "activated" : "deactivated"}.`,
    data: team,
  });
});

/* ─── MAIL TEMPLATE ───────────────────────────────────────────────────────── */

function teamAddedTemplate(
  memberName: string,
  teamName: string,
  leadName: string,
  allMembers: { name: string; email: string }[]
) {
  const memberRows = allMembers
    .map(
      (m) => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #eee;">
          ${m.name}${m.name === memberName ? " (You)" : ""}
        </td>
        <td style="padding:10px;border-bottom:1px solid #eee;color:#666;">${m.email}</td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family:sans-serif;border:1px solid #e5e7eb;padding:20px;">
      <h2 style="color:#2563eb;">Judiciary Performance Portal</h2>
      <p>Hello <strong>${memberName}</strong>, you have been added to <strong>${teamName}</strong>.</p>
      <p><strong>Team Lead:</strong> ${leadName}</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f9fafb;"><th>Name</th><th>Email</th></tr>
        ${memberRows}
      </table>
    </div>`;
}