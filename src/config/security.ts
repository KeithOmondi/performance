// src/config/security.ts
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import hpp from "hpp";
import { Express, Request, Response, NextFunction } from "express";
import { env } from "./env";

export const applySecurityMiddleware = (app: Express) => {
  app.set("trust proxy", 1);

  // ---------------- Secure HTTP headers ----------------
  app.use(helmet());

  // ---------------- CORS configuration ----------------
  const frontendUrl =
    env.NODE_ENV === "development"
      ? "http://localhost:5173"
      : env.FRONTEND_URL;

  app.use(
    cors({
      origin: frontendUrl,
      credentials: true,
    })
  );

  // ---------------- Rate limiting ----------------
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/api", limiter);

  // ---------------- Prevent HTTP parameter pollution ----------------
  app.use(hpp());

  // ---------------- Custom Mongo Injection Protection ----------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const sanitize = (obj: any) => {
      if (!obj || typeof obj !== "object") return;

      Object.keys(obj).forEach((key) => {
        // Remove Mongo operators like $gt, $ne, $or etc
        if (key.startsWith("$") || key.includes(".")) {
          delete obj[key];
        } else if (typeof obj[key] === "object") {
          sanitize(obj[key]);
        }
      });
    };

    sanitize(req.body);
    sanitize(req.params);
    sanitize(req.query);

    next();
  });
};