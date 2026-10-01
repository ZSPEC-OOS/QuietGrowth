// Action state machine, MR §8.2. Transition table is the single source of truth.
export const ACTION_STATES = [
  "DISCOVERED", "SCORED", "PROPOSED", "POLICY_CHECK",
  "BLOCKED", "NEEDS_APPROVAL", "APPROVED", "AUTO_APPROVED",
  "QUEUED", "RUNNING", "VERIFYING", "FAILED", "SUCCEEDED",
  "OBSERVING", "EVALUATED",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  DISCOVERED: ["SCORED"],
  SCORED: ["PROPOSED"],
  PROPOSED: ["POLICY_CHECK"],
  POLICY_CHECK: ["BLOCKED", "NEEDS_APPROVAL", "AUTO_APPROVED"],
  BLOCKED: [],
  NEEDS_APPROVAL: ["APPROVED", "BLOCKED"], // BLOCKED here = owner rejection (extension of MR §8.2; POST /v1/actions/:id/reject)
  APPROVED: ["QUEUED"],
  AUTO_APPROVED: ["QUEUED"],
  QUEUED: ["RUNNING"],
  RUNNING: ["VERIFYING"],
  VERIFYING: ["FAILED", "SUCCEEDED"],
  FAILED: [],
  SUCCEEDED: ["OBSERVING"],
  OBSERVING: ["EVALUATED"],
  EVALUATED: [],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: ActionState, readonly to: ActionState) {
    super(`Illegal action transition ${from} -> ${to}`);
  }
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: ActionState, to: ActionState): ActionState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
