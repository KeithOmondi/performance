import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { env } from "../config/env";
import { User } from "../modules/user/user.model";

interface JwtPayload {
  id: string;
  role: "user" | "admin" | "superadmin";
  iat: number;
  exp: number;
}

// ---------------------------
// Protect Middleware
// ---------------------------
export const protect: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    let token: string | undefined;

    if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) throw new AppError("Not authenticated", 401);

    let decoded: JwtPayload;

    try {
      decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    } catch {
      throw new AppError("Invalid or expired token", 401);
    }

    const currentUser = await User.findById(decoded.id);

    if (!currentUser) throw new AppError("User no longer exists", 401);
    if (!currentUser.isActive) throw new AppError("User is deactivated", 403);

    (req as any).user = currentUser;

    next();
  }
);

// ---------------------------
// Role-based Access Middleware
// ---------------------------
export const restrictTo =
  (...roles: ("user" | "admin" | "superadmin")[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user || !roles.includes(user.role)) {
      throw new AppError("You do not have permission to perform this action", 403);
    }

    next();
  };