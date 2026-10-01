import { describe, expect, it } from "vitest";
import { QuietGrowthClient } from "./index.js";

const mk = (responses: (number | "throw")[], extra = {}) => {
  const calls: any[] = []; let n = 0;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = responses[Math.min(n++, responses.length - 1)];
    if (r === "throw") throw new Error("net");
    return { ok: r! >= 200 && r! < 300, status: r };
  }) as unknown as typeof fetch;
  let id = 0;
  const c = new QuietGrowthClient({ endpoint: "https://api.qg/", apiKey: "k", fetchImpl, sleep: async () => {}, idGenerator: () => `id${++id}`, now: () => 0, ...extra });
  return { c, calls };
};

describe("QuietGrowthClient", () => {
  it("batches and authenticates", async () => {
    const { c, calls } = mk([200], { flushAt: 2 });
    c.track("a"); c.track("b");
    await c.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.qg/v1/events");
    expect(calls[0].headers.authorization).toBe("Bearer k");
    expect(calls[0].body.events.map((e: any) => e.event)).toEqual(["a", "b"]);
    expect(c.pending).toBe(0);
  });
  it("identify links anonymous to user and subsequent events carry both ids", async () => {
    const { c, calls } = mk([200]);
    c.identify("u1"); c.track("signup");
    await c.flush();
    const ev = calls[0].body.events;
    expect(ev[0]).toMatchObject({ event: "identify", userId: "u1", anonymousId: "id1" });
    expect(ev[1]).toMatchObject({ userId: "u1", anonymousId: "id1", schemaVersion: 2 });
  });
  it("retries transient failures reusing the same messageIds (server dedupes)", async () => {
    const { c, calls } = mk(["throw", 503, 200]);
    c.track("x"); await c.flush();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.body.events[0].messageId)).size).toBe(1);
    expect(c.pending).toBe(0);
  });
  it("keeps events queued when the endpoint stays down; drops permanently rejected batches", async () => {
    const down = mk([503], { maxRetries: 1 });
    down.c.track("x"); await down.c.flush(); expect(down.c.pending).toBe(1);
    const bad = mk([400]); bad.c.track("x"); await bad.c.flush(); expect(bad.c.pending).toBe(0);
  });
  it("bounds the queue", () => {
    const { c } = mk([200], { maxQueue: 3, flushAt: 100 });
    for (let i = 0; i < 10; i++) c.track(`e${i}`);
    expect(c.pending).toBe(3);
  });
});
