import { createProductionApp } from "./production.js";

// Standalone host (containers / local). The single-project Vercel deployment mounts the same app inside Next.js.
const { app } = await createProductionApp();
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3001) });
