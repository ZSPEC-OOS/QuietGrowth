// Context compiler, MR §13.1: assemble task context and truncate by priority to a token budget.
export interface ContextSection { key: string; priority: number; content: unknown; /** never dropped or cut */ required?: boolean }

/** Rough, deterministic token estimate (~4 chars/token). */
export const estimateTokens = (v: unknown): number => Math.ceil(JSON.stringify(v ?? null).length / 4);

export interface Compiled { context: Record<string, unknown>; tokens: number; dropped: string[]; truncated: string[] }

export class ContextBudgetError extends Error {}

/**
 * Highest priority first. Whole sections are dropped when they do not fit; large array
 * sections are trimmed from the tail before being dropped. Required sections that cannot
 * fit raise an error instead of silently degrading policy/funnel context.
 */
export function compileContext(sections: ContextSection[], tokenBudget: number): Compiled {
  const ordered = [...sections].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  const context: Record<string, unknown> = {};
  const dropped: string[] = [], truncated: string[] = [];
  let used = 2;
  for (const s of ordered) {
    let content = s.content;
    let cost = estimateTokens(content) + estimateTokens(s.key);
    if (used + cost > tokenBudget && !s.required && Array.isArray(content)) {
      let arr = [...content];
      while (arr.length > 0 && used + estimateTokens(arr) + estimateTokens(s.key) > tokenBudget) arr = arr.slice(0, Math.floor(arr.length / 2));
      if (arr.length > 0) { content = arr; cost = estimateTokens(arr) + estimateTokens(s.key); truncated.push(s.key); }
    }
    if (used + cost > tokenBudget) {
      if (s.required) throw new ContextBudgetError(`required section "${s.key}" does not fit in budget`);
      dropped.push(s.key);
      continue;
    }
    context[s.key] = content;
    used += cost;
  }
  return { context, tokens: used, dropped, truncated };
}
