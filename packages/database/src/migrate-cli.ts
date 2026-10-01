import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: url });
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
console.log("applied:", await migrate(pool, dir));
await pool.end();
