import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { env } from "../config/env";
import { User } from "../modules/user/user.model";

interface JwtPayload {
  id: string;
  role: "user" | "admin" | "superadmin" | "examiner";
  iat: number;
  exp: number;
}

// ---------------------------
// Protect Middleware
// ---------------------------
export const protect: RequestHandler = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    let token: string | undefined;

    // Check cookie first, then Authorization header (Bearer token)
    if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    } else if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) throw new AppError("Not authenticated. Please log in.", 401);

    let decoded: JwtPayload;

    try {
      decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        throw new AppError("Your session has expired. Please log in again.", 401);
      }
      throw new AppError("Invalid token. Please log in again.", 401);
    }

    const currentUser = await User.findById(decoded.id).select("+password");

    if (!currentUser) throw new AppError("User no longer exists.", 401);
    if (!currentUser.isActive) throw new AppError("Your account has been deactivated. Contact support.", 403);

    // Check if password was changed after token was issued
    if (
      currentUser.passwordChangedAt &&
      decoded.iat < Math.floor(currentUser.passwordChangedAt.getTime() / 1000)
    ) {
      throw new AppError("Password recently changed. Please log in again.", 401);
    }

    req.user = currentUser;

    next();
  }
);

// ---------------------------
// Role-based Access Middleware
// ---------------------------
export const restrictTo =
  (...roles: ("user" | "admin" | "superadmin" | "examiner")[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError("Not authenticated. Please log in.", 401);
    }

    if (!roles.includes(req.user.role)) {
      throw new AppError(
        `Access denied. This action requires one of the following roles: ${roles.join(", ")}`,
        403
      );
    }

    next();
  };