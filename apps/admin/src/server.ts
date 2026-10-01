import pg from "pg";
import { spawn } from "node:child_process";
import { DockerCellManager, type CommandRunner } from "@quietgrowth/cell-manager";
import { buildAdminApp } from "./app.js";

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const docker: CommandRunner = { run: (cmd, args) => new Promise((res) => { const p = spawn(cmd, args); let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d)); p.on("close", (code) => res({ code: code ?? 1, stdout: o, stderr: e })); }) };
const app = await buildAdminApp({
  pool: new pg.Pool({ connectionString: need("ADMIN_DATABASE_URL") }),
  cells: new DockerCellManager(docker, Number(process.env.OPENCLAW_GATEWAY_BASE_PORT ?? 20000), undefined, (process.env.OPENCLAW_ALLOWED_IMAGES ?? "").split(",").filter(Boolean)),
  adminToken: need("ADMIN_TOKEN"),
});
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3002) });
