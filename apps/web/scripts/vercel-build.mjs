// Vercel build command for the single project: build workspace deps, optionally migrate (production only), build Next.js.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..", "..");
const sh = (args, env = process.env) => { const r = spawnSync("node", args, { cwd: repo, stdio: "inherit", env }); if (r.status !== 0) process.exit(r.status ?? 1); };
const turbo = (...a) => { const r = spawnSync("pnpm", ["turbo", "run", ...a], { cwd: repo, stdio: "inherit" }); if (r.status !== 0) process.exit(r.status ?? 1); };

// Everything the web app depends on (including the in-process API) must be built before `next build`.
turbo("build", "--filter=@quietgrowth/web...");

// Opt-in, production only. Migrations are idempotent and transactional per file; uses the direct (unpooled) connection.
if (process.env.RUN_MIGRATIONS === "1" && (process.env.VERCEL_ENV ?? "production") === "production") {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) { console.error("RUN_MIGRATIONS=1 requires DATABASE_URL_UNPOOLED (or DATABASE_URL)"); process.exit(1); }
  sh([join(repo, "packages/database/dist/migrate-cli.js")], { ...process.env, DATABASE_URL: url });
}
