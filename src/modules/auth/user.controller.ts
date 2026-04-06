import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { pool } from "../../config/db";
import { UserRole } from "../../types/user.types";

const USER_FIELDS = `id, name, email, role, pj_number AS "pjNumber", title, is_active AS "isActive", created_at AS "createdAt"`;
const VALID_ROLES: UserRole[] = ["user", "admin", "superadmin", "examiner"];

// ─── List All Users ───────────────────────────────────────────────────────────
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const { role, isActive, search } = req.query;
  
  let query = `SELECT ${USER_FIELDS} FROM users WHERE 1=1`;
  const values: any[] = [];

  if (role && VALID_ROLES.includes(role as UserRole)) {
    values.push(role);
    query += ` AND role = $${values.length}`;
  }

  if (isActive !== undefined) {
    values.push(isActive === "true");
    query += ` AND is_active = $${values.length}`;
  }

  if (search && typeof search === "string") {
    values.push(`%${search}%`);
    const idx = values.length;
    query += ` AND (name ILIKE $${idx} OR email ILIKE $${idx} OR pj_number ILIKE $${idx})`;
  }

  query += ` ORDER BY created_at DESC`;

  const { rows: users } = await pool.query(query, values);

  res.status(200).json({
    success: true,
    count: users.length,
    users,
  });
});

// ─── Get Single User ──────────────────────────────────────────────────────────
export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [id]);
  
  if (rows.length === 0) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    user: rows[0],
  });
});

// ─── Update User Role (SuperAdmin only) ───────────────────────────────────────
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body;
  const { id } = req.params;

  if (!role || !VALID_ROLES.includes(role as UserRole)) {
    throw new AppError(`Invalid role. Must be one of: ${VALID_ROLES.join(", ")}.`, 400);
  }

  // Prevent SuperAdmin from demoting themselves (req.user.id from protect middleware)
  if (req.user?.id === id && role !== "superadmin") {
    throw new AppError("You cannot change your own role.", 403);
  }

  const { rows } = await pool.query(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING ${USER_FIELDS}`,
    [role, id]
  );

  if (rows.length === 0) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: `User role updated to "${role}" successfully.`,
    user: rows[0],
  });
});

// ─── Toggle User Active/Inactive (SuperAdmin only) ────────────────────────────
export const toggleUserActive = asyncHandler(async (req: Request, res: Response) => {
  const { isActive } = req.body;
  const { id } = req.params;

  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be a boolean.", 400);
  }

  if (req.user?.id === id && !isActive) {
    throw new AppError("You cannot deactivate your own account.", 403);
  }

  const { rows } = await pool.query(
    `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING ${USER_FIELDS}`,
    [isActive, id]
  );

  if (rows.length === 0) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: `User account ${isActive ? "activated" : "deactivated"} successfully.`,
    user: rows[0],
  });
});

// ─── Create New User (SuperAdmin only) ────────────────────────────────────────
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, role, pjNumber, title } = req.body;

  // 1. Check existence
  const existing = await pool.query("SELECT id FROM users WHERE email = $1 OR pj_number = $2", [email, pjNumber]);
  if (existing.rows.length > 0) {
    throw new AppError("A user with this email or PJ number already exists.", 400);
  }

  // 2. Insert
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, pj_number, title, is_active) 
     VALUES ($1, $2, $3, $4, $5, true) 
     RETURNING ${USER_FIELDS}`,
    [name, email.toLowerCase().trim(), role || "user", pjNumber.trim(), title]
  );

  res.status(201).json({
    success: true,
    message: "User created successfully.",
    user: rows[0],
  });
});

// ─── Update User Details (SuperAdmin only) ────────────────────────────────────
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, pjNumber, title, role } = req.body;
  const { id } = req.params;

  if (req.user?.id === id && role && role !== "superadmin") {
    throw new AppError("You cannot change your own role to a lower level.", 403);
  }

  const { rows } = await pool.query(
    `UPDATE users 
     SET name = COALESCE($1, name), 
         email = COALESCE($2, email), 
         pj_number = COALESCE($3, pj_number), 
         title = COALESCE($4, title), 
         role = COALESCE($5, role),
         updated_at = NOW()
     WHERE id = $6 
     RETURNING ${USER_FIELDS}`,
    [name, email?.toLowerCase().trim(), pjNumber?.trim(), title, role, id]
  );

  if (rows.length === 0) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: "User details updated successfully.",
    user: rows[0],
  });
});

// ─── Delete User (SuperAdmin only) ───────────────────────────────────────────
export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (req.user?.id === id) {
    throw new AppError("You cannot delete your own account.", 403);
  }

  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [id]);
  if (rowCount === 0) throw new AppError("User not found.", 404);

  res.status(200).json({
    success: true,
    message: "User has been removed from the system.",
    id
  });
});