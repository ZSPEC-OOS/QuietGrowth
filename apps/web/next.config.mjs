import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Monorepo: trace server dependencies from the repository root so workspace packages and their node_modules are
  // included in the serverless output on Vercel.
  outputFileTracingRoot: root,
  // The control-plane API runs inside this app. Native-ish / dynamic-require heavy packages stay external (not
  // webpack-bundled) and are shipped via file tracing instead.
  serverExternalPackages: ["pg", "fastify", "pino"],
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Frame-Options", value: "DENY" }, { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Content-Security-Policy", value: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" },
    ] }];
  },
};
