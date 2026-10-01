import type { Pool, PoolClient } from "pg";
import type { GscRow } from "@quietgrowth/connector-gsc";
import type { RevenueEvent } from "@quietgrowth/connector-billing";
import type { Executor, Verifier, OutcomeEvaluator, NewAction } from "@quietgrowth/growth-engine";
import type { DetectedOpportunity } from "@quietgrowth/opportunity-detectors";

export interface WorkerDeps {
  pool: Pool;
  now: () => number;
  authSecret: string;
  /** Per-org data sources (connector wiring lives in main.ts, tests inject fakes). */
  sources: {
    gscRows(orgId: string): Promise<GscRow[] | null>;
    billingEvents(orgId: string, since: Date): Promise<RevenueEvent[]>;
    plgFacts(orgId: string): Promise<import("@quietgrowth/opportunity-detectors").PlgFacts | null>;
  };
  /** Turns an opportunity into a bounded, typed action proposal (agent-backed or rule-based). */
  drafter: Drafter;
  executor: Executor;
  verifier: Verifier;
  outcomes: OutcomeEvaluator;
  scopeFor: (a: import("@quietgrowth/growth-engine").ActionRecord) => string;
  /** Observation window before an outcome is evaluated. */
  observationDays: number;
  maxProposalsPerTick: number;
  notify?: (orgId: string, kind: string, body: Record<string, unknown>) => Promise<void>;
}

export interface Drafter { draft(orgId: string, opp: DetectedOpportunity & { id: string }, c: PoolClient): Promise<NewAction | null> }
