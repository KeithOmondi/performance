import mongoose, { Document, Model, Schema } from "mongoose";
import bcrypt from "bcrypt";

// Updated roles to match your administrative hierarchy
export type UserRole = "user" | "admin" | "superadmin" | "examiner";

// ---------------------- Interface ----------------------
export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  pjNumber: string; // 👈 Added
  title: string;    // 👈 Added
  isActive: boolean;
  passwordChangedAt?: Date;

  comparePassword(candidatePassword: string): Promise<boolean>;
}

// ---------------------- Schema ----------------------
const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
      select: false, 
    },
    // New Professional Identification
    pjNumber: {
      type: String,
      required: [true, "PJ Number is required"],
      unique: true,
      trim: true,
    },
    // New Professional Designation
    title: {
      type: String,
      required: [true, "Professional title is required"],
      default: "Staff",
      trim: true,
    },
    role: {
      type: String,
      enum: ["user", "admin", "superadmin", "examiner"],
      default: "user",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    passwordChangedAt: Date,
  },
  {
    timestamps: true,
  },
);

// ---------------------- Pre-save Hooks ----------------------

// 🔐 Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// 🔐 Track password changes
userSchema.pre("save", function () {
  if (!this.isModified("password") || this.isNew) return;
  this.passwordChangedAt = new Date(Date.now() - 1000);
});

// ---------------------- Instance Methods ----------------------

userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  // Accessing 'this.password' requires it to be selected in the query
  return bcrypt.compare(candidatePassword, this.password);
};

// ---------------------- Export Model ----------------------
export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);