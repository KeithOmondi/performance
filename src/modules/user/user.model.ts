// src/services/user.service.ts
import bcrypt from "bcrypt";
import { IUser } from "../../types/user.types";
import { pool } from "../../config/db";

export class UserService {
  /**
   * Equivalent to userSchema.pre("save") for Hashing
   */
  private static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  /**
   * Create a new user (The "Create" in CRUD)
   */
  static async createUser(data: Partial<IUser>): Promise<IUser> {
    const hashedPassword = data.password ? await this.hashPassword(data.password) : null;
    
    const query = `
      INSERT INTO users (name, email, password, pj_number, title, role, is_active, team_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      data.name,
      data.email?.toLowerCase(),
      hashedPassword,
      data.pjNumber,
      data.title || "Staff",
      data.role || "user",
      data.isActive ?? true,
      data.teamId || null
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
  }

  /**
   * Equivalent to userSchema.methods.comparePassword
   */
  static async comparePassword(candidate: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(candidate, hashed);
  }

  /**
   * Find user by email (Handles the "select: false" logic manually)
   */
  static async findByEmail(email: string, includePassword = false): Promise<IUser | null> {
    const query = `SELECT * FROM users WHERE email = $1 LIMIT 1`;
    const { rows } = await pool.query(query, [email.toLowerCase()]);
    
    const user = rows[0];
    if (!user) return null;

    // Manual "select: false" equivalent
    if (!includePassword) {
      delete user.password;
      delete user.login_otp;
    }
    
    return user;
  }
}