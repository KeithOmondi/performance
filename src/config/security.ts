import helmet from "helmet";
import rateLimit from "express-rate-limit";
import hpp from "hpp";
import { Express, Request, Response, NextFunction } from "express";
import { env } from "./env";

export const applySecurityMiddleware = (app: Express) => {
  app.set("trust proxy", 1);

  // Secure HTTP headers
  app.use(helmet());

  // Rate limiting in production
  if (env.NODE_ENV === "production") {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: "Too many requests from this IP, please try again later.",
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.use("/api", limiter);
  }

  // Prevent HTTP parameter pollution
  app.use(hpp());

  // Block MongoDB injection operators
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sanitize = (obj: any) => {
      if (!obj || typeof obj !== "object") return;
      Object.keys(obj).forEach((key) => {
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