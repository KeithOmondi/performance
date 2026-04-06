import { pool } from "../../config/db";
import { ITeam } from "../../types/team.types";


export class TeamService {
  /**
   * REPLACES: TeamSchema.pre("save")
   * Creates a team and ensures the lead is added as a member.
   */
  static async createTeam(data: {
    name: string;
    description?: string;
    teamLeadId: string;
    createdBy: string;
    memberIds: string[]; // Pass array of user IDs
  }): Promise<ITeam> {
    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      // 1. Ensure teamLead is in the member list (Logic from your pre-save hook)
      const membersSet = new Set(data.memberIds);
      membersSet.add(data.teamLeadId);
      const uniqueMembers = Array.from(membersSet);

      if (uniqueMembers.length === 0) {
        throw new Error("A team must have at least one member.");
      }

      // 2. Insert the Team
      const teamQuery = `
        INSERT INTO teams (name, description, team_lead_id, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `;
      const teamRes = await client.query(teamQuery, [
        data.name, 
        data.description || "", 
        data.teamLeadId, 
        data.createdBy
      ]);
      const newTeam = teamRes.rows[0];

      // 3. Insert Members into Join Table
      const memberValues = uniqueMembers.map(userId => `('${newTeam.id}', '${userId}')`).join(",");
      await client.query(`
        INSERT INTO team_members (team_id, user_id) 
        VALUES ${memberValues}
      `);

      await client.query("COMMIT");
      return newTeam;

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fetch a team with its members list
   */
  static async getTeamById(id: string): Promise<ITeam | null> {
    const teamRes = await pool.query("SELECT * FROM teams WHERE id = $1", [id]);
    if (teamRes.rows.length === 0) return null;

    const team = teamRes.rows[0];
    const membersRes = await pool.query(
      "SELECT user_id FROM team_members WHERE team_id = $1", 
      [id]
    );
    
    team.members = membersRes.rows.map(row => row.user_id);
    return team;
  }
}