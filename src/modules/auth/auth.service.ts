import { pool } from "../../config/db";
import { IUser, UserRole } from "../../types/user.types";
import { AppError } from "../../utils/AppError";
import { sendOtpMail } from "../../utils/sendMail";
import { generateOTP } from "../../utils/generateOTP";
import crypto from "crypto";

interface IRegisterPayload {
  name: string;
  email: string;
  pjNumber: string;
  title: string;
  role?: UserRole;
}

const maskEmail = (email: string): string => {
  const [local, domain] = email.split("@");
  return `${local[0]}***@${domain}`;
};

export class AuthService {
  // ─── Register ────────────────────────────────────────────────────────────
  static async register(payload: IRegisterPayload): Promise<IUser> {
    const email = payload.email.toLowerCase().trim();
    const pjNumber = payload.pjNumber.trim();

    // 1. Check for existing user (SQL OR check)
    const existingRes = await pool.query(
      "SELECT id FROM users WHERE email = $1 OR pj_number = $2 LIMIT 1",
      [email, pjNumber]
    );

    if (existingRes.rows.length > 0) {
      throw new AppError("An account with this Email or PJ Number already exists.", 409);
    }

    // 2. Insert into PostgreSQL
    const insertQuery = `
      INSERT INTO users (name, email, pj_number, title, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, role, pj_number as "pjNumber";
    `;

    const { rows } = await pool.query(insertQuery, [
      payload.name,
      email,
      pjNumber,
      payload.title,
      payload.role || "user",
    ]);

    return rows[0];
  }

  // ─── Request OTP ─────────────────────────────────────────────────────────
  static async requestLoginOTP(pjNumber: string): Promise<string> {
    const cleanPj = pjNumber.trim();

    const userRes = await pool.query(
      "SELECT id, name, email, login_otp_expires FROM users WHERE pj_number = $1 AND is_active = true",
      [cleanPj]
    );

    const user = userRes.rows[0];
    if (!user) throw new AppError("No active account found with this PJ Number.", 404);

    // Rate limit: prevent OTP spam (1 minute window)
    if (user.login_otp_expires && (new Date(user.login_otp_expires).getTime() - Date.now() > 9 * 60 * 1000)) {
      throw new AppError("An OTP was recently sent. Please wait before requesting a new one.", 429);
    }

    const { otp, hashedOtp, expiresAt } = generateOTP(6, 10);

    // Update OTP fields in DB
    await pool.query(
      "UPDATE users SET login_otp = $1, login_otp_expires = $2 WHERE id = $3",
      [hashedOtp, expiresAt, user.id]
    );

    await sendOtpMail(user.email, otp, user.name);

    return maskEmail(user.email);
  }

  // ─── Verify OTP ──────────────────────────────────────────────────────────
  static async verifyOTP(pjNumber: string, otp: string): Promise<IUser> {
    const userRes = await pool.query(
      "SELECT id, name, email, role, pj_number as \"pjNumber\", login_otp, login_otp_expires FROM users WHERE pj_number = $1 AND is_active = true",
      [pjNumber.trim()]
    );

    const user = userRes.rows[0];
    if (!user) throw new AppError("No active account found with this PJ Number.", 404);

    // Check expiry
    if (!user.login_otp_expires || new Date(user.login_otp_expires) < new Date()) {
      await pool.query("UPDATE users SET login_otp = NULL, login_otp_expires = NULL WHERE id = $1", [user.id]);
      throw new AppError("Your OTP has expired. Please request a new one.", 401);
    }

    // Verify hash
    const hashedInput = crypto.createHash("sha256").update(otp.trim()).digest("hex");
    if (user.login_otp !== hashedInput) {
      throw new AppError("Invalid OTP. Please try again.", 401);
    }

    // Clear OTP and return user
    const finalRes = await pool.query(
      "UPDATE users SET login_otp = NULL, login_otp_expires = NULL WHERE id = $1 RETURNING id, name, email, role, pj_number as \"pjNumber\"",
      [user.id]
    );

    return finalRes.rows[0];
  }

  // ─── Get User By ID ───────────────────────────────────────────────────────
  static async getUserById(userId: string): Promise<IUser> {
    const { rows } = await pool.query(
      "SELECT id, name, email, role, pj_number as \"pjNumber\", is_active as \"isActive\" FROM users WHERE id = $1",
      [userId]
    );
    if (rows.length === 0) throw new AppError("User not found.", 404);
    return rows[0];
  }

  // ─── Deactivate/Reactivate ────────────────────────────────────────────────
  static async toggleUserStatus(userId: string, status: boolean): Promise<void> {
    const { rowCount } = await pool.query(
      "UPDATE users SET is_active = $1 WHERE id = $2",
      [status, userId]
    );
    if (rowCount === 0) throw new AppError("User not found.", 404);
  }
}