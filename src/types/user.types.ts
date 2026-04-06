// src/types/user.types.ts
export type UserRole = "user" | "admin" | "superadmin" | "examiner";

export interface IUser {
  id: string; // UUID in Postgres
  name: string;
  email: string;
  password?: string;
  role: UserRole;
  pjNumber: string;
  title: string;
  isActive: boolean;
  teamId?: string | null; // Foreign key
  loginOtp?: string;
  loginOtpExpires?: Date;
  passwordChangedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}