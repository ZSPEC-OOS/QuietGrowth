import { assignVariant } from "@quietgrowth/experiments";

// Native experiment/flag adapter (MR §21.5, P1): deterministic server-side assignment.
export interface FlagConfig { experimentId: string; treatmentShare: number; enabled: boolean; killSwitch?: boolean }

export function resolveFlag(cfg: FlagConfig, subjectId: string): { variant: "treatment" | "control"; reason: "assigned" | "disabled" | "kill_switch" } {
  if (cfg.killSwitch) return { variant: "control", reason: "kill_switch" }; // rollback path: everyone gets baseline
  if (!cfg.enabled) return { variant: "control", reason: "disabled" };
  return { variant: assignVariant(cfg.experimentId, subjectId, cfg.treatmentShare), reason: "assigned" };
}

export interface AssignmentLog { experimentId: string; subjectId: string; variant: string; at: number }

/** Records each subject's first assignment once; later calls return the stored variant even if share changes. */
export class AssignmentRegistry {
  private readonly m = new Map<string, AssignmentLog>();
  assign(cfg: FlagConfig, subjectId: string, now: number): AssignmentLog {
    const k = `${cfg.experimentId}:${subjectId}`;
    const prior = this.m.get(k);
    if (prior) return prior;
    const { variant } = resolveFlag(cfg, subjectId);
    const rec = { experimentId: cfg.experimentId, subjectId, variant, at: now };
    this.m.set(k, rec);
    return rec;
  }
  counts(experimentId: string): { control: number; treatment: number } {
    const out = { control: 0, treatment: 0 };
    for (const r of this.m.values()) if (r.experimentId === experimentId) out[r.variant as "control" | "treatment"]++;
    return out;
  }
}
