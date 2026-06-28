import type { AgentUsage } from "../drivers/types";

/** Sum two usage records, treating missing fields as 0. */
export function addUsage(a: AgentUsage, b?: AgentUsage): AgentUsage {
  if (!b) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    turns: (a.turns ?? 0) + (b.turns ?? 0),
  };
}
