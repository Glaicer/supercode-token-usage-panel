/**
 * Usage Model — every number, formula and string of the Token Usage section.
 *
 * Folds `step-finish` parts of assistant messages (NOT the message-level
 * `tokens` field, which is a last-step snapshot) into cumulative session
 * totals and exposes ready-to-render rows plus a state flag. Contributions
 * are grouped per provider/model pair already, so a future per-model
 * breakdown reads this map without rewriting the fold.
 */
import { createMemo } from "solid-js";
import type {
  AssistantMessage,
  Message,
  Part,
} from "@opencode-ai/sdk/v2";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export type UsageStatus = "loading" | "empty" | "ready" | "unavailable";

export interface UsageRow {
  label: string;
  value: string;
}

export const USAGE_SECTION_TITLE = "Token Usage";

/** Row labels in render order — centralized here for future localization. */
export const USAGE_LABELS = [
  "Input",
  "Output",
  "Reasoning",
  "Cache read",
  "Cache write",
  "Cache rate",
  "Cost",
] as const;

/**
 * Presentation strings for non-ready states; the View renders them as-is.
 * ("ready" never uses one — rows carry the values.)
 */
export const USAGE_STATUS_TEXT: Record<UsageStatus, string> = {
  loading: "Loading…",
  ready: "",
  empty: "No usage yet.",
  unavailable: "Usage unavailable.",
};

/** No-data placeholder: never render NaN/Infinity/0 for a missing fact. */
export const USAGE_DASH = "–";

interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Grouping key: one bucket per provider/model pair (v2 breakdown seam). */
function modelKey(message: AssistantMessage): string {
  return `${message.providerID}/${message.modelID}`;
}

function allZero(totals: Totals): boolean {
  return (
    totals.input === 0 &&
    totals.output === 0 &&
    totals.reasoning === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0 &&
    totals.cost === 0
  );
}

function addInto(target: Totals, source: Totals): Totals {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  return target;
}

/**
 * Fold of ONE session: sum every step-finish part of every assistant message.
 * Multi-step messages contribute ALL their step-finish parts; a message-level
 * snapshot would undercount, which is why parts are the source of truth.
 * Returns undefined when nothing was contributed — zeros are not facts.
 */
function foldSession(api: TuiPluginApi, sessionID: string): Totals | undefined {
  const groups = new Map<string, Totals>();
  const messages: readonly Message[] = api.state.session.messages(sessionID);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of api.state.part(message.id) as readonly Part[]) {
      if (part.type !== "step-finish") continue;
      const stepFinish = part;
      let group = groups.get(modelKey(message));
      if (!group) {
        group = emptyTotals();
        groups.set(modelKey(message), group);
      }
      addInto(group, {
        input: stepFinish.tokens.input,
        output: stepFinish.tokens.output,
        reasoning: stepFinish.tokens.reasoning,
        cacheRead: stepFinish.tokens.cache.read,
        cacheWrite: stepFinish.tokens.cache.write,
        cost: stepFinish.cost,
      });
    }
  }
  if (groups.size === 0) return undefined;
  const totals = emptyTotals();
  for (const group of groups.values()) addInto(totals, group);
  if (allZero(totals)) return undefined;
  return totals;
}

function groupDigits(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatTokens(value: number): string {
  return groupDigits(value);
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Cache rate repeats Kilo's formula over three disjoint billing buckets. */
function formatCacheRate(totals: Totals): string {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
  if (denominator <= 0) return USAGE_DASH;
  return `${((totals.cacheRead / denominator) * 100).toFixed(1)}%`;
}

/** Label and value formula travel together — no positional pairing. */
const ROW_BUILDERS: readonly {
  label: (typeof USAGE_LABELS)[number];
  value: (totals: Totals) => string;
}[] = [
  { label: USAGE_LABELS[0], value: (t) => formatTokens(t.input) },
  { label: USAGE_LABELS[1], value: (t) => formatTokens(t.output) },
  { label: USAGE_LABELS[2], value: (t) => formatTokens(t.reasoning) },
  { label: USAGE_LABELS[3], value: (t) => formatTokens(t.cacheRead) },
  { label: USAGE_LABELS[4], value: (t) => formatTokens(t.cacheWrite) },
  { label: USAGE_LABELS[5], value: formatCacheRate },
  { label: USAGE_LABELS[6], value: (t) => formatCost(t.cost) },
];

function buildRows(totals: Totals): UsageRow[] {
  return ROW_BUILDERS.map(({ label, value }) => ({ label, value: value(totals) }));
}

export interface UsageModel {
  status: () => UsageStatus;
  rows: () => readonly UsageRow[];
}

/**
 * Usage Model over the reactive TUI state. The fold re-runs whenever the
 * session id or the underlying messages/parts change; incremental
 * accumulation keyed by partID replaces the refold in ticket 02 without
 * changing this surface.
 */
export function createUsageModel(api: TuiPluginApi, sessionId: () => string): UsageModel {
  // "loading" exists for async folds (ticket 02); today's fold is synchronous,
  // so observers see it only before the first read of these memos.
  const snapshot = createMemo<{ status: UsageStatus; rows: readonly UsageRow[] }>(() => {
    try {
      const totals = foldSession(api, sessionId());
      if (!totals) return { status: "empty", rows: [] };
      return { status: "ready", rows: buildRows(totals) };
    } catch {
      // Initial fold failed wholesale: unavailability, never zero-as-fact.
      return { status: "unavailable", rows: [] };
    }
  });
  return {
    status: () => snapshot().status,
    rows: () => snapshot().rows,
  };
}
