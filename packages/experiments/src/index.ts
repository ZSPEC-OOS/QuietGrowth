import { createHash } from "node:crypto";

// Experiment record + decision rules, MR §11.
export interface ExperimentSpec {
  hypothesis: string;
  targetCohort: string;
  treatment: string;
  controlOrBaseline: string;
  primaryMetric: string;
  guardrailMetrics: string[];
  minimumSamplePerVariant: number;
  minimumObservationDays: number;
  /** Fraction assigned to treatment, in (0,1). */
  treatmentShare: number;
  /** Pricing/entitlement experiments are never auto-decided (MR §11.2). */
  touchesPricingOrEntitlements: boolean;
}

export function validateSpec(s: ExperimentSpec): string[] {
  const errs: string[] = [];
  if (!s.hypothesis.trim()) errs.push("hypothesis required");
  if (!s.primaryMetric.trim()) errs.push("primary metric required");
  if (s.guardrailMetrics.length === 0) errs.push("at least one guardrail metric required");
  if (!(s.minimumSamplePerVariant > 0)) errs.push("minimum sample must be positive");
  if (!(s.minimumObservationDays > 0)) errs.push("minimum observation window must be positive");
  if (!(s.treatmentShare > 0 && s.treatmentShare < 1)) errs.push("treatment share must be in (0,1)");
  return errs;
}

/** Deterministic, stable assignment: same subject + experiment always yields the same variant. */
export function assignVariant(experimentId: string, subjectId: string, treatmentShare: number): "treatment" | "control" {
  const h = createHash("sha256").update(`${experimentId}:${subjectId}`).digest();
  const u = h.readUInt32BE(0) / 0x1_0000_0000;
  return u < treatmentShare ? "treatment" : "control";
}

export interface Arm { n: number; conversions: number }

/** Two-sided two-proportion z-test. Returns lift (absolute), z and p. */
export function twoProportionTest(control: Arm, treatment: Arm): { lift: number; z: number | null; p: number | null; ci95: [number, number] | null } {
  if (control.n === 0 || treatment.n === 0) return { lift: 0, z: null, p: null, ci95: null };
  const p1 = control.conversions / control.n, p2 = treatment.conversions / treatment.n;
  const pooled = (control.conversions + treatment.conversions) / (control.n + treatment.n);
  const se0 = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / treatment.n));
  const se1 = Math.sqrt((p1 * (1 - p1)) / control.n + (p2 * (1 - p2)) / treatment.n);
  const lift = p2 - p1;
  const ci95: [number, number] = [lift - 1.96 * se1, lift + 1.96 * se1];
  if (se0 === 0) return { lift, z: null, p: null, ci95 };
  const z = lift / se0;
  return { lift, z, p: 2 * (1 - normalCdf(Math.abs(z))), ci95 };
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export type Decision =
  | { decision: "continue"; reason: string }
  | { decision: "stop_guardrail"; reason: string }
  | { decision: "freeze_instrumentation"; reason: string }
  | { decision: "inconclusive"; reason: string }
  | { decision: "propose_winner"; reason: string; requiresHumanApproval: true; label: "experimental" }
  | { decision: "no_effect"; reason: string };

export interface EvalInput {
  spec: ExperimentSpec;
  daysElapsed: number;
  primary: { control: Arm; treatment: Arm };
  /** Guardrail arms where higher = worse (e.g. refund or churn rate). */
  guardrails: { name: string; control: Arm; treatment: Arm }[];
  instrumentationHealthy: boolean;
  alpha?: number;
}

/**
 * Fixed-window evaluation. Never declares a winner on small samples or before the window,
 * freezes on broken instrumentation, stops on a significant guardrail regression, and
 * never auto-applies pricing/entitlement winners.
 */
export function evaluateExperiment(i: EvalInput): Decision {
  const alpha = i.alpha ?? 0.05;
  if (!i.instrumentationHealthy) return { decision: "freeze_instrumentation", reason: "instrumentation unhealthy; evaluation frozen" };

  for (const g of i.guardrails) {
    const t = twoProportionTest(g.control, g.treatment);
    if (t.p !== null && t.p < alpha && t.lift > 0) return { decision: "stop_guardrail", reason: `guardrail ${g.name} worsened (lift ${t.lift.toFixed(4)}, p=${t.p.toFixed(4)})` };
  }

  const { control, treatment } = i.primary;
  const small = Math.min(control.n, treatment.n) < i.spec.minimumSamplePerVariant;
  if (i.daysElapsed < i.spec.minimumObservationDays || small)
    return { decision: "continue", reason: small ? "minimum sample not reached" : "observation window not elapsed" };

  const t = twoProportionTest(control, treatment);
  if (t.p === null) return { decision: "inconclusive", reason: "no variance in outcomes" };
  if (t.p < alpha && t.lift > 0)
    return { decision: "propose_winner", reason: `lift ${t.lift.toFixed(4)} (p=${t.p.toFixed(4)})`, requiresHumanApproval: true, label: "experimental" };
  if (t.p < alpha && t.lift < 0) return { decision: "no_effect", reason: `treatment worse (lift ${t.lift.toFixed(4)}, p=${t.p.toFixed(4)})` };
  return { decision: "inconclusive", reason: `no significant difference (p=${t.p.toFixed(4)})` };
}
