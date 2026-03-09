import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AuthService } from "./auth.service";
import { sendToken } from "../../utils/sendToken";
import { AppError } from "../../utils/AppError";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export const AuthController = {
  // 🔹 Register
  register: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      throw new AppError("Name, email, and password are required", 400);
    }

    const userDoc = await AuthService.register({ name, email, password, role });
    return sendToken(res, userDoc);
  }),

  // 🔹 Login
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new AppError("Email and password are required", 400);
    }

    const { user } = await AuthService.login({ email, password });
    
    // ✅ Pass the full user document to sendToken
    return sendToken(res, user);
  }),

  // 🔹 Refresh Token
  refreshToken: asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) throw new AppError("No refresh token provided", 401);

    try {
      const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as any;
      const user = await AuthService.getUserById(decoded.id);
      
      return sendToken(res, user);
    } catch (err) {
      throw new AppError("Invalid or expired refresh token", 401);
    }
  }),

  // 🔹 Logout
  logout: asyncHandler(async (_req: Request, res: Response) => {
    res.cookie("accessToken", "", { httpOnly: true, expires: new Date(0) });
    res.cookie("refreshToken", "", { httpOnly: true, expires: new Date(0) });

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  }),
};