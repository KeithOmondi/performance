import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AuthService } from "./auth.service";
import { sendToken } from "../../utils/sendToken";
import { AppError } from "../../utils/AppError";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { UserRole } from "../../types/user.types";

export const AuthController = {
  // ─── Register (SuperAdmin only) ──────────────────────────────────────────
  register: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, pjNumber, title, role } = req.body;

    if (!name || !email || !pjNumber || !title) {
      throw new AppError("Name, Email, PJ Number, and Title are required.", 400);
    }

    // Role is cast to UserRole to satisfy TypeScript (matches our PG Enum)
    const user = await AuthService.register({ 
      name, 
      email, 
      pjNumber, 
      title, 
      role: role as UserRole 
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully.",
      user: {
        id: user.id, // Changed from user._id.toString()
        name: user.name,
        email: user.email,
        role: user.role,
        pjNumber: user.pjNumber,
      },
    });
  }),

  // ─── Step 1: Request OTP ─────────────────────────────────────────────────
  requestOTP: asyncHandler(async (req: Request, res: Response) => {
    const { pjNumber } = req.body;
    if (!pjNumber) throw new AppError("PJ Number is required.", 400);

    // AuthService now queries Neon/Postgres using the pool
    const maskedEmail = await AuthService.requestLoginOTP(pjNumber);

    res.status(200).json({
      success: true,
      message: `OTP sent to ${maskedEmail}. Valid for 10 minutes.`,
    });
  }),

  // ─── Step 2: Verify OTP & Login ──────────────────────────────────────────
  login: asyncHandler(async (req: Request, res: Response) => {
    const { pjNumber, otp } = req.body;

    if (!pjNumber || !otp) {
      throw new AppError("PJ Number and OTP are required.", 400);
    }

    const user = await AuthService.verifyOTP(pjNumber, otp);
    
    // sendToken handles cookie setting and JWT generation
    return sendToken(res, user, 200);
  }),

  // ─── Refresh Token ────────────────────────────────────────────────────────
  refreshToken: asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) throw new AppError("No refresh token provided.", 401);

    let decoded: { id: string; role: string };

    try {
      decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as {
        id: string;
        role: string;
      };
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        throw new AppError("Session expired. Please log in again.", 401);
      }
      throw new AppError("Invalid refresh token. Please log in again.", 401);
    }

    // Ensure AuthService.getUserById uses pool.query('SELECT * FROM users WHERE id = $1')
    const user = await AuthService.getUserById(decoded.id);
    if (!user) throw new AppError("User not found.", 404);

    return sendToken(res, user, 200);
  }),

  // ─── Logout ───────────────────────────────────────────────────────────────
  logout: asyncHandler(async (_req: Request, res: Response) => {
    const isProduction = env.NODE_ENV === "production";

    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      // For Kenya Judiciary deployment, 'lax' is safer if not using subdomains
      sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
      expires: new Date(0),
    };

    res.cookie("accessToken", "", cookieOptions);
    res.cookie("refreshToken", "", cookieOptions);

    res.status(200).json({
      success: true,
      message: "Logged out successfully.",
    });
  }),
};