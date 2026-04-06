import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { env } from "../config/env";
import { pool } from "../config/db";
import { UserRole } from "../types/user.types";

interface JwtPayload {
  id: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// ---------------------------
// Protect Middleware
// ---------------------------
export const protect: RequestHandler = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    let token: string | undefined;

    // 1. Extract Token
    if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    } else if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) throw new AppError("Not authenticated. Please log in.", 401);

    // 2. Verify Token
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        throw new AppError("Your session has expired. Please log in again.", 401);
      }
      throw new AppError("Invalid token. Please log in again.", 401);
    }

    // 3. Check if user still exists in PostgreSQL
    const userQuery = `
      SELECT id, name, email, role, pj_number, is_active, password_changed_at 
      FROM users 
      WHERE id = $1 LIMIT 1
    `;
    const { rows } = await pool.query(userQuery, [decoded.id]);
    const currentUser = rows[0];

    if (!currentUser) {
      throw new AppError("The user belonging to this token no longer exists.", 401);
    }

    if (!currentUser.is_active) {
      throw new AppError("Your account has been deactivated. Contact support.", 403);
    }

    // 4. Check if password was changed after token was issued
    // Note: PG returns null or a Date object for password_changed_at
    if (currentUser.password_changed_at) {
      const changedTimestamp = Math.floor(new Date(currentUser.password_changed_at).getTime() / 1000);
      if (decoded.iat < changedTimestamp) {
        throw new AppError("Password recently changed. Please log in again.", 401);
      }
    }

    // 5. Grant Access (Map snake_case to camelCase if your req.user interface requires it)
    req.user = {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      role: currentUser.role,
      pjNumber: currentUser.pj_number,
    } as any;

    next();
  }
);

// ---------------------------
// Role-based Access Middleware
// ---------------------------
export const restrictTo =
  (...roles: UserRole[]): RequestHandler =>
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