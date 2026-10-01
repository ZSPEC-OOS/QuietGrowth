import { proxyApiRequest } from "@/server/proxy";

// The control-plane API is served from this same Next.js deployment under /api/*:
//   /api/healthz, /api/v1/*, /api/internal/*, /api/cron/tick   (the Fastify app sees them without the /api prefix)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx) { return proxyApiRequest(req, (await ctx.params).path); }
export async function POST(req: Request, ctx: Ctx) { return proxyApiRequest(req, (await ctx.params).path); }
