import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AuthService } from "./auth.service";
import { sendToken } from "../../utils/sendToken";
import { AppError } from "../../utils/AppError";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export const AuthController = {
  // ─── Register (SuperAdmin only) ──────────────────────────────────────────
  register: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, pjNumber, title, role } = req.body;

    if (!name || !email || !pjNumber || !title) {
      throw new AppError("Name, Email, PJ Number, and Title are required.", 400);
    }

    const user = await AuthService.register({ name, email, pjNumber, title, role });

    return res.status(201).json({
      success: true,
      message: "User registered successfully.",
      user: {
        id: user._id.toString(),
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

    // maskEmail is handled inside AuthService — returns k***@gmail.com
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

    const user = await AuthService.getUserById(decoded.id);
    return sendToken(res, user, 200);
  }),

  // ─── Logout ───────────────────────────────────────────────────────────────
  logout: asyncHandler(async (_req: Request, res: Response) => {
    const isProduction = env.NODE_ENV === "production";

    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
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