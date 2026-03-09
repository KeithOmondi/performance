// src/server.ts
import app from "./app";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import mongoose from "mongoose";

const startServer = async () => {
  try {
    // Connect Database
    await connectDB();

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Server running on port ${env.PORT}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
      console.log(`🌐 Frontend URL: ${env.FRONTEND_URL}`);
    });

    // Graceful shutdown (SIGTERM - production)
    process.on("SIGTERM", async () => {
      console.log("🛑 SIGTERM received. Shutting down gracefully...");
      server.close(async () => {
        await mongoose.connection.close();
        process.exit(0);
      });
    });

  } catch (error) {
    console.error("❌ Server failed to start:", error);
    process.exit(1);
  }
};

// Ctrl+C shutdown (development)
process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received. Closing DB connection...");
  await mongoose.connection.close();
  process.exit(0);
});

startServer();