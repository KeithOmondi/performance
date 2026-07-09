import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, 
  },
  // Increased timeouts for Neon cold starts
  connectionTimeoutMillis: 180000, // 3 minutes - Neon can be slow to wake up
  idleTimeoutMillis: 60000, // Increased idle timeout
  max: 20, // Increased connection pool
  // Keep connections alive longer
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Add connection error handling
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Add health check
export const checkDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection check failed:', error);
    return false;
  }
};

export const connectDB = async () => {
  try {
    console.log("🐘 Attempting to connect to Neon...");
    
    // Try with retry logic
    let retries = 3;
    let connected = false;
    
    while (retries > 0 && !connected) {
      try {
        const client = await pool.connect();
        const res = await client.query('SELECT NOW()');
        console.log(`✅ PostgreSQL connected! Server time: ${res.rows[0].now}`);
        client.release();
        connected = true;
        break;
      } catch (error) {
        retries--;
        console.log(`Connection attempt failed. ${retries} retries left.`);
        if (retries === 0) throw error;
        // Wait 2 seconds before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    if (!connected) {
      throw new Error('Failed to connect to database after multiple attempts');
    }
  } catch (error) {
    console.error("❌ PostgreSQL connection failed:");
    console.error(error);
    process.exit(1);
  }
};