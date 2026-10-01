import { ACTION_TYPES, type ActionRequest, type ActionType, type Decision, type Policy, type SpendState } from "./types.js";

const isActionType = (t: string): t is ActionType => (ACTION_TYPES as readonly string[]).includes(t);
const bad = (n: number): boolean => !Number.isFinite(n) || n < 0;

/**
 * Pure policy evaluation. Fails closed: unknown type, missing rule, invalid
 * numbers or any thrown error yields DENY. Spend and model-cap checks precede
 * rule lookup so no rule (including approval) can authorise spend over a cap.
 */
export function evaluate(action: ActionRequest, policy: Policy, state: SpendState): Decision {
  const deny = (...reasons: string[]): Decision => ({ verdict: "DENY", reasons, policyVersion: policy?.version ?? "unknown" });
  try {
    if (!policy || !state) return deny("missing policy or spend state");
    if (!isActionType(action.type)) return deny(`unknown action type: ${String(action.type)}`);
    if (bad(action.estimatedExternalCostUsd) || bad(action.estimatedModelCostUsd)) return deny("invalid cost estimate");

    if (state.externalSpendUsd + action.estimatedExternalCostUsd > policy.maxExternalSpendUsd)
      return deny("external spend cap exceeded");
    if (state.modelSpendUsd + action.estimatedModelCostUsd > policy.maxModelSpendUsd)
      return deny("model spend cap exceeded");

    const rule = policy.rules[action.type];
    if (rule === undefined || rule === "deny") return deny(`rule denies ${action.type}`);
    if (rule === "require_approval")
      return { verdict: "NEEDS_APPROVAL", reasons: [`rule requires approval for ${action.type}`], policyVersion: policy.version };

    const done = state.actionsToday[action.type] ?? 0;
    if (done >= policy.limits.maxActionsPerDay)
      return { verdict: "NEEDS_APPROVAL", reasons: [`daily limit reached for ${action.type}`], policyVersion: policy.version };
    return { verdict: "ALLOW", reasons: [`within limits for ${action.type}`], policyVersion: policy.version };
  } catch (e) {
    return deny(`evaluation error: ${e instanceof Error ? e.message : "unknown"}`);
  }
}
