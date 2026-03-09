// src/config/env.ts
import dotenv from "dotenv";

dotenv.config();

const requiredEnvVars = [
  "PORT",
  "MONGO_URI",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
  "FRONTEND_URL",
  "CLOUDINARY_CLOUD_NAME" // <-- add this
];

requiredEnvVars.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
});

export const env = {
  PORT: Number(process.env.PORT),
  NODE_ENV: process.env.NODE_ENV || "production",
  MONGO_URI: process.env.MONGO_URI as string,
  JWT_SECRET: process.env.JWT_SECRET || "supersecret",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "1d",

  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET as string,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET as string,

  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || "15m",
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || "7d",

  FRONTEND_URL: process.env.FRONTEND_URL as string, // <-- added

  //CLOUDINARY
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME as string,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY as string,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET as string,

};