import { Response } from "express";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import ms, { StringValue } from "ms";
import { IUser, UserRole } from "../types/user.types"; 

export interface IUserPayload {
  id: string;
  role: UserRole;
}

const parseExpires = (value: string): SignOptions["expiresIn"] => {
  return value as SignOptions["expiresIn"];
};

export const generateAccessToken = (payload: IUserPayload) => {
  const options: SignOptions = { expiresIn: parseExpires(env.JWT_ACCESS_EXPIRES) };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
};

export const generateRefreshToken = (payload: IUserPayload) => {
  const options: SignOptions = { expiresIn: parseExpires(env.JWT_REFRESH_EXPIRES) };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, options);
};

export const sendToken = (res: Response, user: IUser, statusCode: number = 200) => {
  const payload: IUserPayload = {
    id: user.id, // Using 'id' from Postgres object
    role: user.role,
  };

  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  const isProduction = env.NODE_ENV === "production";

  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    maxAge: ms(env.JWT_ACCESS_EXPIRES as StringValue), 
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    maxAge: ms(env.JWT_REFRESH_EXPIRES as StringValue),
  });

  return res.status(statusCode).json({
    success: true,
    message: "Authentication successful",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
};