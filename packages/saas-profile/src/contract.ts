// Required SaaS growth contract validation, MR §3.3 (POST /v1/funnel/define).
export interface GrowthContract {
  primaryConversion?: string;
  activationEvent?: string;
  retentionWindowDays?: number;
  billingSource?: "stripe" | "paddle" | "chargebee" | string;
  acquisitionObjective?: string;
  guardrails?: string[];
  signupEvent?: string;
  churnEvent?: string;
}

export function validateGrowthContract(c: GrowthContract): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const req = (v: unknown, msg: string) => { if (typeof v !== "string" || !v.trim()) errors.push(msg); };
  req(c.primaryConversion, "primaryConversion is required");
  req(c.activationEvent, "activationEvent is required");
  req(c.signupEvent, "signupEvent is required");
  req(c.billingSource, "billingSource is required");
  req(c.acquisitionObjective, "acquisitionObjective is required");
  if (!(typeof c.retentionWindowDays === "number" && c.retentionWindowDays > 0)) errors.push("retentionWindowDays must be a positive number");
  if (!c.guardrails || c.guardrails.length === 0) errors.push("at least one guardrail is required");
  return { ok: errors.length === 0, errors };
}
