import { User, IUser, UserRole } from "../user/user.model";
import { AppError } from "../../utils/AppError";
import { sendOtpMail } from "../../utils/sendMail";
import { generateOTP } from "../../utils/generateOTP";
import crypto from "crypto";

interface IRegisterPayload {
  name: string;
  email: string;
  pjNumber: string;
  title: string;
  role?: UserRole;
}

// Mask email for safe display: k***@gmail.com
const maskEmail = (email: string): string => {
  const [local, domain] = email.split("@");
  return `${local[0]}***@${domain}`;
};

export class AuthService {
  // ─── Register ────────────────────────────────────────────────────────────
  static async register(payload: IRegisterPayload): Promise<IUser> {
    const existingUser = await User.findOne({
      $or: [
        { email: payload.email.toLowerCase().trim() },
        { pjNumber: payload.pjNumber.trim() },
      ],
    });

    if (existingUser) {
      throw new AppError(
        "An account with this Email or PJ Number already exists.",
        409
      );
    }

    const user = await User.create({
      ...payload,
      email: payload.email.toLowerCase().trim(),
      pjNumber: payload.pjNumber.trim(),
      role: payload.role || "user",
    });

    return user;
  }

  // ─── Request OTP ─────────────────────────────────────────────────────────
  static async requestLoginOTP(pjNumber: string): Promise<string> {
    const user = await User.findOne({
      pjNumber: pjNumber.trim(),
      isActive: true,
    }).select("+loginOtp +loginOtpExpires");

    if (!user) {
      throw new AppError(
        "No active account found with this PJ Number.",
        404
      );
    }

    // Rate limit: prevent OTP spam — block if an OTP was sent in the last 60s
    if (
      user.loginOtpExpires &&
      user.loginOtpExpires.getTime() - Date.now() > 9 * 60 * 1000
    ) {
      throw new AppError(
        "An OTP was recently sent. Please wait before requesting a new one.",
        429
      );
    }

    // Use the secure generateOTP utility (crypto.randomInt)
    const { otp, hashedOtp, expiresAt } = generateOTP(6, 10);

    user.loginOtp = hashedOtp;
    user.loginOtpExpires = expiresAt;
    await user.save({ validateBeforeSave: false });

    await sendOtpMail(user.email, otp, user.name);

    // Return masked email so frontend can show "OTP sent to k***@gmail.com"
    return maskEmail(user.email);
  }

  // ─── Verify OTP ──────────────────────────────────────────────────────────
  static async verifyOTP(pjNumber: string, otp: string): Promise<IUser> {
    const user = await User.findOne({
      pjNumber: pjNumber.trim(),
      isActive: true,
    }).select("+loginOtp +loginOtpExpires");

    if (!user) {
      throw new AppError("No active account found with this PJ Number.", 404);
    }

    // Check expiry first
    if (!user.loginOtpExpires || user.loginOtpExpires < new Date()) {
      user.loginOtp = undefined;
      user.loginOtpExpires = undefined;
      await user.save({ validateBeforeSave: false });
      throw new AppError("Your OTP has expired. Please request a new one.", 401);
    }

    // Verify the hash
    const hashedInput = crypto
      .createHash("sha256")
      .update(otp.trim())
      .digest("hex");

    if (user.loginOtp !== hashedInput) {
      throw new AppError("Invalid OTP. Please try again.", 401);
    }

    // Clear OTP after successful verification
    user.loginOtp = undefined;
    user.loginOtpExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return user;
  }

  // ─── Get User By ID ───────────────────────────────────────────────────────
  static async getUserById(userId: string): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) throw new AppError("User not found.", 404);
    return user;
  }

  // ─── Deactivate User ──────────────────────────────────────────────────────
  static async deactivateUser(userId: string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new AppError("User not found.", 404);
    if (!user.isActive) throw new AppError("User is already deactivated.", 400);

    user.isActive = false;
    await user.save({ validateBeforeSave: false });
  }

  // ─── Reactivate User ──────────────────────────────────────────────────────
  static async reactivateUser(userId: string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new AppError("User not found.", 404);
    if (user.isActive) throw new AppError("User is already active.", 400);

    user.isActive = true;
    await user.save({ validateBeforeSave: false });
  }
}