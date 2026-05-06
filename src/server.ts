// src/server.ts
import app from "./app";
import { env } from "./config/env";
import { connectDB, pool } from "./config/db";
import { registerDeadlineReminderJob } from "./jobs/deadlineReminder";

const startServer = async () => {
  try {
    // 1. Connect Database (Verifies connection to Neon)
    await connectDB();

    // 2. Register scheduled jobs (after DB is confirmed live)
    registerDeadlineReminderJob();

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Server running on port ${env.PORT}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
    });

    // 3. Graceful shutdown (SIGTERM - production/Docker)
    process.on("SIGTERM", async () => {
      console.log("🛑 SIGTERM received. Shutting down gracefully...");

      server.close(async () => {
        await pool.end();
        console.log("🐘 PostgreSQL pool has ended.");
        process.exit(0);
      });
    });

  } catch (error) {
    console.error("❌ Server failed to start:", error);
    process.exit(1);
  }
};

// 4. Ctrl+C shutdown (development)
process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received. Closing DB pool...");
  await pool.end();
  console.log("🐘 PostgreSQL pool has ended.");
  process.exit(0);
});

startServer();