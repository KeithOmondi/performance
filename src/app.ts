// src/app.ts
import express from "express";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { applySecurityMiddleware } from "./config/security";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import cors from "cors"

const app = express();


// ---------------- Security Middleware (FIRST) ----------------
applySecurityMiddleware(app);

app.use(
  cors({
    origin: env.FRONTEND_URL,      // your frontend domain
    credentials: true,             // allow cookies
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], // allowed HTTP methods
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
  }),
);


// ---------------- Body Parser ----------------
app.use(express.json({ limit: "10kb" }));

// ---------------- Cookie Parser ----------------
app.use(cookieParser());

// ---------------- API Routes ----------------
app.use("/api/v1", routes);

// ---------------- Health Check ----------------
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running securely 🚀",
  });
});

// ---------------- Global Error Handler (LAST) ----------------
app.use(errorHandler);

export default app;