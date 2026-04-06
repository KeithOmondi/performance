import { pool } from "../../config/db";
import { ITeam } from "../../types/team.types";

export class TeamService {
  static async createTeam(data: {
    name: string;
    description?: string;
    teamLeadId: string;
    createdBy: string;
    memberIds: string[];
  }): Promise<ITeam> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const membersSet = new Set(data.memberIds);
      membersSet.add(data.teamLeadId);
      const uniqueMembers = Array.from(membersSet);

      if (uniqueMembers.length === 0) {
        throw new Error("A team must have at least one member.");
      }

      const teamQuery = `
        INSERT INTO teams (name, description, team_lead_id, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `;
      const teamRes = await client.query(teamQuery, [
        data.name,
        data.description || "",
        data.teamLeadId,
        data.createdBy,
      ]);
      const newTeam = teamRes.rows[0];

      // ✅ Use parameterized query to avoid SQL injection
      const memberValues = uniqueMembers.map((_, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO team_members (team_id, user_id) VALUES ${memberValues}`,
        [newTeam.id, ...uniqueMembers]
      );

      await client.query("COMMIT");

      // ✅ Return with members populated so caller gets full model
      return { ...newTeam, members: uniqueMembers };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async getTeamById(id: string): Promise<ITeam | null> {
    const teamRes = await pool.query("SELECT * FROM teams WHERE id = $1", [id]);
    if (teamRes.rows.length === 0) return null;

    const team = teamRes.rows[0];

    // ✅ Fetch all members from join table (includes team lead since they were added there)
    const membersRes = await pool.query(
      "SELECT user_id FROM team_members WHERE team_id = $1",
      [id]
    );

    // ✅ Both teamLeadId (from teams table) and members (from join table) are now populated
    team.members = membersRes.rows.map((row) => row.user_id);

    return team;
  }
}