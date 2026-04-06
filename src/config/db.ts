import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // 1. Loosen SSL for initial connection
  ssl: {
    rejectUnauthorized: false, 
  },
  // 2. Increase timeouts to give Neon time to "wake up"
  connectionTimeoutMillis: 10000, // Wait 10s instead of 2s
  idleTimeoutMillis: 30000,
  max: 10,
});

export const connectDB = async () => {
  try {
    console.log("🐘 Attempting to connect to Neon...");
    const client = await pool.connect();
    
    // Check if we are connected
    const res = await client.query('SELECT NOW()');
    console.log(`✅ PostgreSQL connected! Server time: ${res.rows[0].now}`);
    
    client.release();
  } catch (error) {
    console.error("❌ PostgreSQL connection failed:");
    console.error(error);
    process.exit(1);
  }
};