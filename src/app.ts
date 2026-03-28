// src/app.ts
import express from "express";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { applySecurityMiddleware } from "./config/security";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import cors from "cors";

const app = express();

// ---------------- CORS (BEFORE Security Middleware) ----------------
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
  })
);

// Handle preflight requests globally
app.options("*", cors());

// ---------------- Security Middleware ----------------
applySecurityMiddleware(app);

// ---------------- Body Parser ----------------
app.use(express.json({ limit: "10mb" })); // increased for file uploads
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ---------------- Cookie Parser ----------------
app.use(cookieParser());

// ---------------- Health Check ----------------
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running securely 🚀",
  });
});

// ---------------- API Routes ----------------
app.use("/api/v1", routes);

// ---------------- 404 Handler ----------------
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ---------------- Global Error Handler (LAST) ----------------
app.use(errorHandler);

export default app;