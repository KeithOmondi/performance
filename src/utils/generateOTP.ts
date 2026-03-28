import crypto from "crypto";

export interface GeneratedOTP {
  otp: string;
  hashedOtp: string;
  expiresAt: Date;
}

const DEFAULT_OTP_LENGTH = 6;
const DEFAULT_EXPIRY_MINUTES = 10; // increased from 5 — more realistic for email delivery

// Cryptographically secure OTP generation
const generateNumericOtp = (length: number): string => {
  const digits = crypto.randomInt(
    Math.pow(10, length - 1),
    Math.pow(10, length)
  );
  return digits.toString();
};

const hashOtp = (otp: string): string =>
  crypto.createHash("sha256").update(otp).digest("hex");

export const generateOTP = (
  length: number = DEFAULT_OTP_LENGTH,
  expiryMinutes: number = DEFAULT_EXPIRY_MINUTES
): GeneratedOTP => {
  const otp = generateNumericOtp(length);

  return {
    otp,
    hashedOtp: hashOtp(otp),
    expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
  };
};