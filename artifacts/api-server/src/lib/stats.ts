import { getDb } from "./mongo";
import { logger } from "./logger";

export interface HistoryEntry {
  id: string;
  success: boolean;
  statusCode: number;
  requestedAt: string;
  responseTime: number;
  endpoint: string;
  method: string;
  model: string;
  requestPayload: unknown;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
  error: string | null;
}

const COLLECTION = "request_history";

export async function recordRequest(entry: HistoryEntry): Promise<void> {
  try {
    const db = await getDb();
    await db.collection(COLLECTION).insertOne({ ...entry, _insertedAt: new Date() });
  } catch (err) {
    logger.warn({ err }, "stats: failed to persist request to MongoDB");
  }
}

export async function getHistory(limit?: number): Promise<HistoryEntry[]> {
  try {
    const db = await getDb();
    const cursor = db
      .collection<HistoryEntry>(COLLECTION)
      .find({}, { projection: { _id: 0, _insertedAt: 0 } })
      .sort({ requestedAt: -1 });
    if (limit) cursor.limit(limit);
    return await cursor.toArray();
  } catch (err) {
    logger.warn({ err }, "stats: failed to read history from MongoDB");
    return [];
  }
}

export async function clearHistory(): Promise<number> {
  try {
    const db = await getDb();
    const result = await db.collection(COLLECTION).deleteMany({});
    return result.deletedCount;
  } catch (err) {
    logger.warn({ err }, "stats: failed to clear history from MongoDB");
    return 0;
  }
}

export async function getStats(): Promise<{
  totalRequests: number;
  successCount: number;
  failureCount: number;
  avgResponseTime: number;
  lastRequestAt: string | null;
}> {
  try {
    const db = await getDb();
    const col = db.collection<HistoryEntry>(COLLECTION);

    const [agg, last] = await Promise.all([
      col
        .aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              successCount: { $sum: { $cond: ["$success", 1, 0] } },
              avgResponseTime: { $avg: "$responseTime" },
            },
          },
        ])
        .toArray(),
      col.findOne({}, { sort: { requestedAt: -1 }, projection: { requestedAt: 1 } }),
    ]);

    const row = agg[0];
    if (!row) return { totalRequests: 0, successCount: 0, failureCount: 0, avgResponseTime: 0, lastRequestAt: null };

    const total = Number(row.total);
    const successCount = Number(row.successCount);
    return {
      totalRequests: total,
      successCount,
      failureCount: total - successCount,
      avgResponseTime: Math.round(Number(row.avgResponseTime) || 0),
      lastRequestAt: last?.requestedAt ?? null,
    };
  } catch (err) {
    logger.warn({ err }, "stats: failed to get stats from MongoDB");
    return { totalRequests: 0, successCount: 0, failureCount: 0, avgResponseTime: 0, lastRequestAt: null };
  }
}
