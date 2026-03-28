import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { User, UserRole } from "../user/user.model";

const USER_FIELDS = "name email role pjNumber title isActive createdAt";

const VALID_ROLES: UserRole[] = ["user", "admin", "superadmin", "examiner"];

// ─── List All Users ───────────────────────────────────────────────────────────
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const { role, isActive, search } = req.query;

  const filter: Record<string, any> = {};

  if (role && VALID_ROLES.includes(role as UserRole)) {
    filter.role = role;
  }

  if (isActive !== undefined) {
    filter.isActive = isActive === "true";
  }

  if (search && typeof search === "string") {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { pjNumber: { $regex: search, $options: "i" } },
    ];
  }

  const users = await User.find(filter).select(USER_FIELDS).sort("-createdAt");

  res.status(200).json({
    success: true,
    count: users.length,
    users,
  });
});

// ─── Get Single User ──────────────────────────────────────────────────────────
export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id).select(USER_FIELDS);
  if (!user) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    user,
  });
});

// ─── Update User Role (SuperAdmin only) ───────────────────────────────────────
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body;

  if (!role || !VALID_ROLES.includes(role as UserRole)) {
    throw new AppError(
      `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}.`,
      400
    );
  }

  // Prevent SuperAdmin from demoting themselves
  if (req.user?._id.toString() === req.params.id && role !== "superadmin") {
    throw new AppError("You cannot change your own role.", 403);
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { role },
    { new: true, runValidators: true }
  ).select(USER_FIELDS);

  if (!user) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: `User role updated to "${role}" successfully.`,
    user,
  });
});

// ─── Toggle User Active/Inactive (SuperAdmin only) ────────────────────────────
export const toggleUserActive = asyncHandler(async (req: Request, res: Response) => {
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be a boolean (true or false).", 400);
  }

  // Prevent SuperAdmin from deactivating themselves
  if (req.user?._id.toString() === req.params.id && !isActive) {
    throw new AppError("You cannot deactivate your own account.", 403);
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive },
    { new: true }
  ).select(USER_FIELDS);

  if (!user) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: `User account ${isActive ? "activated" : "deactivated"} successfully.`,
    user,
  });
});

// ─── Create New User (SuperAdmin only) ────────────────────────────────────────
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password, role, pjNumber, title } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new AppError("A user with this email already exists.", 400);
  }

  const user = await User.create({
    name,
    email,
    password, // Ensure your model hashes this!
    role: role || "user",
    pjNumber,
    title,
    isActive: true
  });

  // Remove password from response
  const userResponse = await User.findById(user._id).select(USER_FIELDS);

  res.status(201).json({
    success: true,
    message: "User created successfully.",
    user: userResponse,
  });
});

// ─── Update User Details (SuperAdmin only) ────────────────────────────────────
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, pjNumber, title, role } = req.body;

  // 1. Check if user exists
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError("User not found.", 404);

  // 2. Prevent SuperAdmin from demoting themselves via general update
  if (req.user?._id.toString() === req.params.id && role && role !== "superadmin") {
    throw new AppError("You cannot change your own role to a lower level.", 403);
  }

  // 3. Update the fields
  const updatedUser = await User.findByIdAndUpdate(
    req.params.id,
    { name, email, pjNumber, title, role },
    { new: true, runValidators: true }
  ).select(USER_FIELDS);

  res.status(200).json({
    success: true,
    message: "User details updated successfully.",
    user: updatedUser,
  });
});

// ─── Delete User (SuperAdmin only) ───────────────────────────────────────────
export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);

  if (!user) throw new AppError("User not found.", 404);

  // Prevent SuperAdmin from deleting themselves
  if (req.user?._id.toString() === req.params.id) {
    throw new AppError("You cannot delete your own account.", 403);
  }

  // Optional: Check if user has assigned indicators/tasks before allowing deletion
  // If your system requires history, you might prefer toggleUserActive (Soft Delete)
  
  await User.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: "User has been removed from the system.",
    id: req.params.id
  });
});