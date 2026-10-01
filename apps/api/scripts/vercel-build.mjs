// Vercel build command for the API project: build workspace deps, optionally migrate, then emit the Build Output bundle.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const api = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(api, "..", "..");
const sh = (cmd, args, cwd, env = process.env) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env }); if (r.status !== 0) process.exit(r.status ?? 1); };

sh("pnpm", ["turbo", "run", "build", "--filter=@quietgrowth/api..."], repo);

// Opt-in, production only: migrations are idempotent and transactional per file. Uses the direct (unpooled) connection.
if (process.env.RUN_MIGRATIONS === "1" && (process.env.VERCEL_ENV ?? "production") === "production") {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) { console.error("RUN_MIGRATIONS=1 requires DATABASE_URL_UNPOOLED (or DATABASE_URL)"); process.exit(1); }
  sh("node", [join(repo, "packages/database/dist/migrate-cli.js")], repo, { ...process.env, DATABASE_URL: url });
}
sh("pnpm", ["run", "build:vercel"], api);
