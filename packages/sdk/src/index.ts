// QuietGrowth SDK: runs in browsers and Node 18+ (global fetch + crypto).
export interface ClientOptions {
  endpoint: string;
  apiKey: string;
  flushAt?: number;
  maxQueue?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  idGenerator?: () => string;
  onError?: (e: unknown) => void;
}

interface QueuedEvent { messageId: string; anonymousId?: string; userId?: string; event: string; timestamp: string; properties: Record<string, unknown>; context: Record<string, unknown>; schemaVersion: 2 }

const defaultId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export class QuietGrowthClient {
  private queue: QueuedEvent[] = [];
  private anonymousId: string;
  private userId?: string;
  private flushing: Promise<void> | null = null;
  private readonly o: Required<Omit<ClientOptions, "onError">> & Pick<ClientOptions, "onError">;

  constructor(opts: ClientOptions) {
    this.o = {
      flushAt: 20, maxQueue: 1000, fetchImpl: globalThis.fetch?.bind(globalThis), now: Date.now,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), maxRetries: 4, idGenerator: defaultId, ...opts,
    } as never;
    this.anonymousId = this.o.idGenerator();
  }

  identify(userId: string): void {
    this.userId = userId;
    // The link event lets the server merge pre-signup anonymous activity into the user.
    this.track("identify", {});
  }

  track(event: string, properties: Record<string, unknown> = {}, context: Record<string, unknown> = {}): void {
    if (this.queue.length >= this.o.maxQueue) this.queue.shift(); // drop oldest, never grow unbounded
    this.queue.push({
      messageId: this.o.idGenerator(), anonymousId: this.anonymousId, userId: this.userId, event,
      timestamp: new Date(this.o.now()).toISOString(), properties, context: { source: "product", ...context }, schemaVersion: 2,
    });
    if (this.queue.length >= this.o.flushAt) void this.flush();
  }

  get pending(): number { return this.queue.length; }

  /** Sends queued events; on persistent failure the batch is re-queued for the next flush. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.o.flushAt);
      const ok = await this.send(batch);
      if (!ok) { this.queue.unshift(...batch); return; }
    }
  }

  private async send(batch: QueuedEvent[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      try {
        const res = await this.o.fetchImpl(`${this.o.endpoint.replace(/\/$/, "")}/v1/events`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify({ events: batch }),
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) { this.o.onError?.(new Error(`rejected: ${res.status}`)); return true; } // permanent: drop
      } catch (e) {
        this.o.onError?.(e);
      }
      await this.o.sleep(Math.min(30_000, 2 ** attempt * 250));
    }
    return false;
  }
}
