import { MongoClient, type Db } from "mongodb";
import { logger } from "./logger";

// Strip anything after a space — guards against Koyeb env vars being joined on one line
// e.g. "mongodb+srv://...?w=majority MONGODB_DATABASE=manus" → "mongodb+srv://...?w=majority"
const rawUri = process.env["MONGODB_URI"] ?? "";
const uri = rawUri.split(" ")[0] || undefined;
const dbName = process.env["MONGODB_DATABASE"]?.split(" ")[0] ?? "qwen_gateway";

if (!uri) {
  logger.warn("MONGODB_URI not set — MongoDB features will be unavailable");
}

let client: MongoClient | null = null;
let dbInstance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (dbInstance) return dbInstance;
  if (!uri) throw new Error("MONGODB_URI environment variable is not set");
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    logger.info({ dbName }, "Connected to MongoDB");
  }
  dbInstance = client.db(dbName);
  // Ensure indexes
  await dbInstance.collection("users").createIndex({ email: 1 }, { unique: true });
  await dbInstance.collection("api_keys").createIndex({ key_hash: 1 });
  await dbInstance.collection("api_keys").createIndex({ user_id: 1 });
  await dbInstance.collection("telegram_users").createIndex({ telegram_id: 1 }, { unique: true });
  await dbInstance.collection("request_history").createIndex({ requestedAt: -1 });
  await dbInstance.collection("request_history").createIndex({ success: 1 });
  return dbInstance;
}
