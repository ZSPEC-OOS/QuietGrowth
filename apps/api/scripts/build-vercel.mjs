// Builds the API as a Vercel Build Output API v3 bundle: .vercel/output/{config.json,functions/index.func}
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const fn = join(out, "functions", "index.func");
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// Single self-contained CommonJS file: workspace packages and dependencies are bundled, nothing is resolved at runtime.
await build({
  entryPoints: [join(root, "src", "vercel.ts")], outfile: join(fn, "index.js"),
  bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false, minify: false, legalComments: "none",
  external: ["pg-native"], // optional native driver of `pg`; not used
  logLevel: "warning",
});
// esbuild's CJS output exposes `default`; Vercel's launcher expects the handler to be module.exports.
writeFileSync(join(fn, "index.js"), (await import("node:fs")).readFileSync(join(fn, "index.js"), "utf8") + "\nmodule.exports = module.exports.default;\n");

// Pin the module type so the bundle stays CommonJS regardless of any parent package.json.
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "commonjs" }));
writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2));
writeFileSync(join(out, "config.json"), JSON.stringify({
  version: 3,
  routes: [{ src: "/(.*)", dest: "/index" }],
  // Hosted replacement for the BullMQ worker (see docs/VERCEL.md). Per-minute schedules require a Pro plan.
  crons: [{ path: "/cron/tick", schedule: "*/15 * * * *" }],
}, null, 2));
console.log("vercel output written to", out);
