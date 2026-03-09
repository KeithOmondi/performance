import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { User } from "../user/user.model";

// Helper to define exactly which fields the UI needs
const USER_FIELDS = "name email role pjNumber title isActive createdAt";

// -------------------------
// List All Users (Admin/Superadmin)
// -------------------------
export const listUsers = asyncHandler(async (_req: Request, res: Response) => {
  const users = await User.find()
    .select(USER_FIELDS)
    .sort("-createdAt");

  res.status(200).json({
    success: true,
    count: users.length,
    users,
  });
});

// -------------------------
// Get Single User by ID
// -------------------------
export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id).select(USER_FIELDS);
  
  if (!user) throw new AppError("User not found", 404);

  res.status(200).json({
    success: true,
    user,
  });
});

// -------------------------
// Update User Role (Superadmin Only)
// -------------------------
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body;
  
  // Updated to include all roles from your Model: "user", "admin", "superadmin", "reviewer", "registrar"
  const validRoles = ["user", "admin", "superadmin", "reviewer", "registrar"];
  
  if (!role || !validRoles.includes(role)) {
    throw new AppError("Invalid role. Must be one of: " + validRoles.join(", "), 400);
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { role },
    { new: true, runValidators: true }
  ).select(USER_FIELDS);

  if (!user) throw new AppError("User not found", 404);

  res.status(200).json({
    success: true,
    message: `User role updated to ${role}`,
    user,
  });
});

// -------------------------
// Deactivate / Reactivate User
// -------------------------
export const toggleUserActive = asyncHandler(async (req: Request, res: Response) => {
  const { isActive } = req.body;
  
  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be true or false", 400);
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive },
    { new: true }
  ).select(USER_FIELDS);

  if (!user) throw new AppError("User not found", 404);

  res.status(200).json({
    success: true,
    message: `User status set to ${isActive}`,
    user,
  });
});