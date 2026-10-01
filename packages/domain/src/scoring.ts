// Opportunity value score, MR §8.3. Risk is a policy gate, not a score term.
export interface ScoreInputs {
  expectedIncrementalImpact: number;
  confidence: number;
  ease: number;
  timeToSignal: number;
  reversibility: number;
  strategicFit: number;
  /** Optional cap on confidence derived from evidence quality, in [0,1]. */
  evidenceQualityCap?: number;
}

export const SCORE_WEIGHTS = {
  expectedIncrementalImpact: 0.3,
  confidence: 0.2,
  ease: 0.15,
  timeToSignal: 0.15,
  reversibility: 0.1,
  strategicFit: 0.1,
} as const;

const unit = (n: number, name: string): number => {
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new RangeError(`${name} must be in [0,1]`);
  return n;
};

export function valueScore(i: ScoreInputs): number {
  const confidence = Math.min(unit(i.confidence, "confidence"), unit(i.evidenceQualityCap ?? 1, "evidenceQualityCap"));
  return (
    SCORE_WEIGHTS.expectedIncrementalImpact * unit(i.expectedIncrementalImpact, "expectedIncrementalImpact") +
    SCORE_WEIGHTS.confidence * confidence +
    SCORE_WEIGHTS.ease * unit(i.ease, "ease") +
    SCORE_WEIGHTS.timeToSignal * unit(i.timeToSignal, "timeToSignal") +
    SCORE_WEIGHTS.reversibility * unit(i.reversibility, "reversibility") +
    SCORE_WEIGHTS.strategicFit * unit(i.strategicFit, "strategicFit")
  );
}
