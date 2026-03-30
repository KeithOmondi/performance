import mongoose, { Document, Model, Schema } from "mongoose";
import bcrypt from "bcrypt";

// ---------------------- Types ----------------------
export type UserRole = "user" | "admin" | "superadmin" | "examiner";

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  password?: string;
  role: UserRole;
  pjNumber: string;
  title: string;
  isActive: boolean;

  /**
   * Reference to the Team this user belongs to (if any).
   * Populated by the Team model when members are added/removed.
   * A user can only belong to one team at a time.
   */
  team?: mongoose.Types.ObjectId;

  // OTP Fields for Login
  loginOtp?: string;
  loginOtpExpires?: Date;

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
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
    },
    password: {
      type: String,
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    pjNumber: {
      type: String,
      required: [true, "PJ Number is required"],
      unique: true,
      trim: true,
      index: true,
    },
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
      index: true,
    },

    // ── Team membership ─────────────────────────────────────────────────
    // Set automatically by the Team controller whenever members are
    // added to / removed from a team. Do NOT set this manually on the
    // user document; always go through the Team CRUD.
    team: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      default: null,
      index: true,
    },

    loginOtp: {
      type: String,
      select: false,
    },
    loginOtpExpires: {
      type: Date,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, any>) {
        ret.password = undefined;
        ret.loginOtp = undefined;
        ret.loginOtpExpires = undefined;
        ret.passwordChangedAt = undefined;
        ret.__v = undefined;
        return ret;
      },
    },
  },
);

// ---------------------- Pre-save Hooks ----------------------

// Hash password if modified
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Track password changes for JWT invalidation
userSchema.pre("save", function () {
  if (!this.isModified("password") || this.isNew) return;
  this.passwordChangedAt = new Date(Date.now() - 1000);
});

// ---------------------- Instance Methods ----------------------

userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// ---------------------- Export Model ----------------------
export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);