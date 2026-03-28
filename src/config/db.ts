import mongoose from "mongoose";
import { env } from "./env";

export const connectDB = async () => {
  try {
    // Passing dbName explicitly ensures you aren't saving 
    // Judicial records into a 'test' database by accident.
    await mongoose.connect(env.MONGO_URI, {
      dbName: env.DB_NAME || "PMMU", 
    });

    console.log(`✅ MongoDB connected to: ${env.DB_NAME || "default_db"}`);
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1);
  }
};