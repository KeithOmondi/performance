import { Response } from "express";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import ms from "ms";

export interface IUserPayload {
  id: string;
  role: string;
}

const parseExpires = (value: string): SignOptions['expiresIn'] => {
  return value as unknown as SignOptions['expiresIn'];
};

export const generateAccessToken = (payload: IUserPayload) => {
  const options: SignOptions = { expiresIn: parseExpires(env.JWT_ACCESS_EXPIRES) };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
};

export const generateRefreshToken = (payload: IUserPayload) => {
  const options: SignOptions = { expiresIn: parseExpires(env.JWT_REFRESH_EXPIRES) };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, options);
};

export const sendToken = (
  res: Response,
  // Changed to 'any' or a Document type to handle Mongoose ObjectIds
  user: any 
) => {
  const payload: IUserPayload = { 
    id: user._id.toString(), 
    role: user.role 
  };

  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  const isProduction = env.NODE_ENV === "production";

  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: ms('15m'),
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: ms('7d'),
  });

  // ✅ CRITICAL FIX: Include user object so frontend state.user is not null
  return res.status(200).json({
    success: true,
    message: "Authentication successful",
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
};