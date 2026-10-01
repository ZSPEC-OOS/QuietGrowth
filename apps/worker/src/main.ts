import pg from "pg";
import { Redis } from "ioredis";
import { createQueue, createWorker, enqueueTick } from "./queue.js";
import { buildWorkerDeps } from "./wiring.js";

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

const pool = new pg.Pool({ connectionString: need("DATABASE_URL") });
const redis = new Redis(need("REDIS_URL"), { maxRetriesPerRequest: null });
createWorker(redis, buildWorkerDeps(process.env, pool));
const queue = createQueue(redis);
const tick = async () => {
  const orgs = (await pool.query("SELECT id FROM organizations")).rows.map((r) => r.id as string);
  await enqueueTick(queue, orgs, String(Math.floor(Date.now() / (15 * 60_000))));
};
await tick();
setInterval(() => void tick().catch((e) => console.error("tick failed", e)), 15 * 60_000);
