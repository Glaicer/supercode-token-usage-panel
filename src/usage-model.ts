/**
 * Usage Model — every number, formula and string of the Token Usage section.
 *
 * Reads OpenCode's authoritative session aggregate, which is maintained from
 * every `step-finish` part, and exposes ready-to-render rows plus a state flag.
 * The aggregate is not limited by the TUI's 100-message window and correctly
 * reflects removed parts.
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { Session } from "@opencode-ai/sdk/v2";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export type UsageStatus = "loading" | "empty" | "ready" | "unavailable";

export interface UsageRow {
  label: string;
  value: string;
}

export const USAGE_SECTION_TITLE = "Token Usage";

/** Indicator text shown under the rows when descendants contribute. */
export const USAGE_SUBAGENTS_TEXT = "Including subagents";

/** Row labels in render order — centralized here for future localization. */
export const USAGE_LABELS = [
  "Input",
  "Output",
  "Reasoning",
  "Cache read",
  "Cache write",
  "Cache rate",
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
}

function allZero(totals: Totals): boolean {
  return (
    totals.input === 0 &&
    totals.output === 0 &&
    totals.reasoning === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0
  );
}

function safe(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function totalsFromSession(session: Session | undefined): Totals | undefined {
  if (!session?.tokens) return undefined;
  return {
    input: safe(session.tokens.input),
    output: safe(session.tokens.output),
    reasoning: safe(session.tokens.reasoning),
    cacheRead: safe(session.tokens.cache.read),
    cacheWrite: safe(session.tokens.cache.write),
  };
}

function groupDigits(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatTokens(value: number): string {
  return groupDigits(value);
}

/** Share of all prompt tokens that the provider served from cache. */
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
];

function buildRows(totals: Totals): UsageRow[] {
  return ROW_BUILDERS.map(({ label, value }) => ({ label, value: value(totals) }));
}

export interface UsageModel {
  status: () => UsageStatus;
  rows: () => readonly UsageRow[];
  /** True when descendant sessions contribute to the totals. */
  includesSubagents: () => boolean;
}

function addTotals(target: Totals, source: Totals): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

interface FamilyResult {
  totals?: Totals;
  /** True when at least one descendant session contributed. */
  hasDescendants: boolean;
  /** Root plus every discovered descendant — the refresh filter set. */
  members: ReadonlySet<string>;
}

/**
 * Fetches the root session, then walks its descendants breadth-first via
 * `session.children`. The visited set guards against duplicate listing (a
 * session reported as a child twice, or a cycle) so no usage is double-counted.
 * Any failed fetch fails the whole walk — a partial sum would understate.
 */
async function fetchFamily(
  client: TuiPluginApi["client"],
  rootID: string,
): Promise<FamilyResult> {
  const root = (await client.session.get({ sessionID: rootID }, { throwOnError: true })).data;
  const rootTotals = totalsFromSession(root);
  if (!rootTotals) return { hasDescendants: false, members: new Set([rootID]) };
  const totals = { ...rootTotals };
  let hasDescendants = false;

  const queue = [rootID];
  const visited = new Set<string>([rootID]);
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    const kids = (await client.session.children({ sessionID: parent }, { throwOnError: true })).data;
    for (const kid of kids) {
      if (visited.has(kid.id)) continue;
      visited.add(kid.id);
      hasDescendants = true;
      const kidTotals = totalsFromSession(kid);
      if (kidTotals) addTotals(totals, kidTotals);
      queue.push(kid.id);
    }
  }
  return { totals, hasDescendants, members: visited };
}

/**
 * Usage Model over OpenCode's session aggregate. The TUI session list can lag
 * while a response is running, so usage-changing events trigger a fresh local
 * API read; request sequencing prevents slower responses from winning.
 * Totals cover the current session plus all of its descendants (subagents).
 */
export function createUsageModel(api: TuiPluginApi, sessionId: () => string): UsageModel {
  const [remote, setRemote] = createSignal<{
    sessionID: string;
    totals?: Totals;
    hasDescendants: boolean;
    failed: boolean;
  }>();
  let request = 0;
  /** Sessions of the last confirmed family walk; membership-filtered events. */
  let members: ReadonlySet<string> = new Set();

  const refresh = (sessionID: string) => {
    const current = ++request;
    void fetchFamily(api.client, sessionID)
      .then(({ totals, hasDescendants, members: family }) => {
        if (current !== request || sessionId() !== sessionID) return;
        members = family;
        setRemote({ sessionID, totals, hasDescendants, failed: !totals });
      })
      .catch(() => {
        if (current !== request || sessionId() !== sessionID) return;
        setRemote((previous) =>
          previous?.sessionID === sessionID && previous.totals
            ? { ...previous, failed: true }
            : { sessionID, hasDescendants: false, failed: true },
        );
      });
  };

  createEffect(() => {
    const sessionID = sessionId();
    members = new Set([sessionID]);
    setRemote(undefined);
    untrack(() => refresh(sessionID));
  });

  const refreshCurrent = (sessionID: string) => {
    if (sessionID === sessionId() || members.has(sessionID)) refresh(sessionId());
  };
  /** A new session anywhere might be a descendant — membership is unconfirmed until the walk. */
  const offSessionCreated = api.event.on("session.created", () => {
    refreshCurrent(sessionId());
  });
  const offSessionDeleted = api.event.on("session.deleted", (event) => {
    refreshCurrent(event.properties.sessionID);
  });
  const offPartUpdated = api.event.on("message.part.updated", (event) => {
    if (event.properties.part.type === "step-finish") {
      refreshCurrent(event.properties.part.sessionID);
    }
  });
  const offPartRemoved = api.event.on("message.part.removed", (event) => {
    refreshCurrent(event.properties.sessionID);
  });
  const offMessageRemoved = api.event.on("message.removed", (event) => {
    refreshCurrent(event.properties.sessionID);
  });
  const offSessionUpdated = api.event.on("session.updated", (event) => {
    refreshCurrent(event.properties.info.id);
  });
  onCleanup(() => {
    request++;
    offSessionCreated();
    offSessionDeleted();
    offPartUpdated();
    offPartRemoved();
    offMessageRemoved();
    offSessionUpdated();
  });

  const snapshot = createMemo<
    { status: UsageStatus; rows: readonly UsageRow[]; hasDescendants: boolean }
  >(() => {
    try {
      const sessionID = sessionId();
      const loaded = remote();
      const totals =
        loaded?.sessionID === sessionID && loaded.totals
          ? loaded.totals
          : totalsFromSession(api.state.session.get(sessionID));
      const hasDescendants = loaded?.sessionID === sessionID
        ? loaded.hasDescendants
        : false;
      if (!totals) {
        return {
          status: loaded?.sessionID === sessionID && loaded.failed ? "unavailable" : "loading",
          rows: [],
          hasDescendants: false,
        };
      }
      if (allZero(totals)) return { status: "empty", rows: [], hasDescendants: false };
      return { status: "ready", rows: buildRows(totals), hasDescendants };
    } catch {
      return { status: "unavailable", rows: [], hasDescendants: false };
    }
  });
  return {
    status: () => snapshot().status,
    rows: () => snapshot().rows,
    includesSubagents: () => snapshot().hasDescendants,
  };
}
