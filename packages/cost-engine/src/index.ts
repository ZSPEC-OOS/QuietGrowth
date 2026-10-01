// Model cost ledger arithmetic, MR §4.2. Rates are configuration, never hard-coded.
export interface RateTable {
  /** Identifier/version of the rate table, stored with every ledger row. */
  version: string;
  /** USD per 1M tokens. */
  perMillionTokensUsd: { cachedInput: number; uncachedInput: number; output: number };
}

export interface Usage {
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningMode?: "none" | "low" | "high" | "max";
  retryCount?: number;
}

export function costUsd(u: Usage, r: RateTable): number {
  for (const n of [u.cachedInputTokens, u.uncachedInputTokens, u.outputTokens])
    if (!Number.isFinite(n) || n < 0) throw new RangeError("token counts must be non-negative finite numbers");
  const p = r.perMillionTokensUsd;
  return (u.cachedInputTokens * p.cachedInput + u.uncachedInputTokens * p.uncachedInput + u.outputTokens * p.output) / 1_000_000;
}

export interface LedgerEntry { orgId: string; month: string; costUsd: number }

export class CostLedger {
  private readonly totals = new Map<string, number>();
  readonly entries: LedgerEntry[] = [];
  record(orgId: string, month: string, cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) throw new RangeError("invalid cost");
    this.entries.push({ orgId, month, costUsd: cost });
    const k = `${orgId}|${month}`;
    this.totals.set(k, (this.totals.get(k) ?? 0) + cost);
  }
  monthTotal(orgId: string, month: string): number {
    return this.totals.get(`${orgId}|${month}`) ?? 0;
  }
  /** True when background AI work must pause (MR §27). */
  capReached(orgId: string, month: string, capUsd: number): boolean {
    return this.monthTotal(orgId, month) >= capUsd;
  }
}

/** Per-action ceiling: abort/re-plan on overrun (MR §4.2). */
export function withinTokenCeiling(u: Usage, ceiling: number): boolean {
  return u.cachedInputTokens + u.uncachedInputTokens + u.outputTokens <= ceiling;
}
