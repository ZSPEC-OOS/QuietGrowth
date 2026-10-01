// QuietGrowth's own commercial packaging, MR §23. Priced by products, automation scope, connectors and controls; not by tokens or runs.
export type Tier = "self_host" | "hosted_starter" | "growth" | "team";

export interface Limits {
  maxProducts: number;
  paidSearch: boolean;
  controlledGrowthMode: boolean;
  approvalRoles: boolean;
  auditExport: boolean;
  /** Guardrail on unit economics (MR §23): cap on background model spend the owner may configure per month. */
  maxModelSpendCapUsd: number;
}

export const TIER_LIMITS: Readonly<Record<Tier, Limits>> = {
  self_host: { maxProducts: 1, paidSearch: false, controlledGrowthMode: false, approvalRoles: false, auditExport: false, maxModelSpendCapUsd: 1_000_000 }, // owner pays DeepSeek directly
  hosted_starter: { maxProducts: 1, paidSearch: false, controlledGrowthMode: false, approvalRoles: false, auditExport: false, maxModelSpendCapUsd: 100 },
  growth: { maxProducts: 1, paidSearch: true, controlledGrowthMode: true, approvalRoles: false, auditExport: false, maxModelSpendCapUsd: 500 },
  team: { maxProducts: 5, paidSearch: true, controlledGrowthMode: true, approvalRoles: true, auditExport: true, maxModelSpendCapUsd: 2000 },
};

export const isTier = (t: string): t is Tier => t in TIER_LIMITS;

export type Feature = keyof Omit<Limits, "maxProducts" | "maxModelSpendCapUsd">;

export class EntitlementError extends Error { constructor(readonly feature: string, readonly tier: Tier) { super(`${feature} is not included in the ${tier} plan`); } }

export const limitsFor = (tier: string): Limits => TIER_LIMITS[isTier(tier) ? tier : "hosted_starter"]; // unknown tier => most restrictive paid default

export function assertFeature(tier: string, f: Feature): void {
  if (!limitsFor(tier)[f]) throw new EntitlementError(f, isTier(tier) ? tier : "hosted_starter");
}
export function assertCanAddProduct(tier: string, currentProducts: number): void {
  if (currentProducts >= limitsFor(tier).maxProducts) throw new EntitlementError("additional products", isTier(tier) ? tier : "hosted_starter");
}
export function assertModelCap(tier: string, requestedCapUsd: number): void {
  if (requestedCapUsd > limitsFor(tier).maxModelSpendCapUsd) throw new EntitlementError(`a model-cost cap above $${limitsFor(tier).maxModelSpendCapUsd}`, isTier(tier) ? tier : "hosted_starter");
}
