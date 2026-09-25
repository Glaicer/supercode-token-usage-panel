/**
 * Usage Model — every number, formula and string of the Token Usage section.
 *
 * Reads OpenCode's authoritative session aggregate and family message history,
 * folds completed steps/speed/TTFT, and estimates the current visible stream from
 * deltas. Exposes only ready-to-render rows plus a state flag.
 *
 * OpenCode v2 shape: one assistant message = one model step, so per-step tokens
 * live on `message.tokens` (there are no `step-finish` parts) and TTFT is
 * `message.time.streamed - message.time.created` (`time.streamed` is set by
 * `session.step.streamed`, the first streamed token).
 */
import type * as Solid from "solid-js";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client";

export type UsageStatus = "loading" | "empty" | "ready" | "unavailable";

export interface UsageRow {
  label: string;
  value: string;
}

export const USAGE_SECTION_TITLE = "Token Usage";

export const USAGE_SECTION_TITLE_WITH_SUBAGENTS = "Token Usage (including subagents)";

export const USAGE_LABELS = [
  "Input",
  "Output",
  "Reasoning",
  "Cache read",
  "Cache write",
  "Cache rate",
  "Steps",
  "Session cost",
  "Generation speed",
  "Time to first token",
] as const;

export const USAGE_STATUS_TEXT: Record<UsageStatus, string> = {
  loading: "Loading…",
  ready: "",
  empty: "No usage yet.",
  unavailable: "Usage unavailable.",
};

/** Placeholder for missing values: never render NaN/Infinity as a number. */
export const USAGE_DASH = "–";

interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface CompletedMetrics {
  generated: number;
  decodeMs: number;
  ttftMs: number;
  ttftCount: number;
  /** Completed agent steps: one per finished assistant message, summed across the family. */
  steps: number;
  calibrations: Map<string, { chars: number; tokens: number }>;
}

interface LiveSpeedState {
  messageID: string;
  /** `${kind}:${messageID}:${ordinal}` of the streaming content item. */
  partKey: string;
  startedAt: number;
  now: number;
  chars: number;
  displayedChars: number;
  charsPerToken: number;
  hasTicked: boolean;
}

interface LiveTtftState {
  messageID: string;
  createdAt: number;
  now: number;
}

type UsageEventType =
  | "session.created"
  | "session.deleted"
  | "session.usage.updated"
  | "session.step.started"
  | "session.step.streamed"
  | "session.step.ended"
  | "session.step.failed"
  | "session.text.delta"
  | "session.text.ended"
  | "session.reasoning.delta"
  | "session.reasoning.ended"
  | "session.revert.committed"
  | "session.execution.started"
  | "session.execution.failed"
  | "session.idle"
  | "server.connected";

/**
 * The slice of the TUI plugin context the model reads. The panel passes the
 * real `Plugin.Context` (typecheck at the call site keeps this slice honest);
 * tests fake exactly this surface.
 */
export interface UsageApi {
  client: {
    session: {
      get(input: { sessionID: string }): Promise<SessionInfo | undefined>;
      list(input: { parentID: string }): Promise<{ data: SessionInfo[] }>;
    };
    message: {
      list(input: {
        sessionID: string;
        cursor?: string;
      }): Promise<{ data: SessionMessageInfo[]; cursor?: { next?: string | null } | null }>;
    };
  };
  data: {
    on<Type extends UsageEventType>(
      type: Type,
      handler: (event: Extract<OpenCodeEvent, { type: Type }>) => void,
    ): () => void;
    session: {
      get(sessionID: string): SessionInfo | undefined;
      message: { list(sessionID: string): readonly SessionMessageInfo[] };
    };
  };
}

function emptyMetrics(): CompletedMetrics {
  return {
    generated: 0,
    decodeMs: 0,
    ttftMs: 0,
    ttftCount: 0,
    steps: 0,
    calibrations: new Map(),
  };
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

function safe(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function totalsFromUsage(tokens: TokenUsageInfo | undefined, cost: number | undefined): Totals {
  return {
    input: safe(tokens?.input),
    output: safe(tokens?.output),
    reasoning: safe(tokens?.reasoning),
    cacheRead: safe(tokens?.cache.read),
    cacheWrite: safe(tokens?.cache.write),
    cost: safe(cost),
  };
}

function totalsFromSession(session: SessionInfo | undefined): Totals | undefined {
  if (!session?.tokens) return undefined;
  return totalsFromUsage(session.tokens, session.cost);
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

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

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

function formatSteps(metrics: CompletedMetrics | undefined): string {
  if (!metrics || !positive(metrics.steps)) return USAGE_DASH;
  return formatTokens(metrics.steps);
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function formatGenerationSpeed(metrics: CompletedMetrics | undefined): string {
  if (!metrics || !positive(metrics.generated) || !positive(metrics.decodeMs)) return USAGE_DASH;
  const value = metrics.generated / (metrics.decodeMs / 1_000);
  const rounded = Math.round(value);
  return positive(rounded) ? `${rounded} tps` : USAGE_DASH;
}

function formatTtft(metrics: CompletedMetrics | undefined): string {
  if (!metrics || !positive(metrics.ttftMs) || !positive(metrics.ttftCount)) return USAGE_DASH;
  const value = metrics.ttftMs / metrics.ttftCount / 1_000;
  return positive(value) ? `${value.toFixed(1)}s` : USAGE_DASH;
}

function buildUsageRows(totals: Totals, metrics: CompletedMetrics | undefined): UsageRow[] {
  const head = ROW_BUILDERS.map(({ label, value }) => ({ label, value: value(totals) }));
  return [
    ...head,
    { label: USAGE_LABELS[6], value: formatSteps(metrics) },
    { label: USAGE_LABELS[7], value: formatCost(totals.cost) },
  ];
}

function formatLiveSpeed(live: LiveSpeedState): string {
  if (!live.hasTicked) return USAGE_DASH;
  const elapsed = (live.now - live.startedAt) / 1_000;
  const value = live.displayedChars / live.charsPerToken / elapsed;
  const rounded = Math.round(value);
  return positive(rounded) ? `~${rounded} tps` : USAGE_DASH;
}

function formatLiveTtft(live: LiveTtftState): string {
  const value = (live.now - live.createdAt) / 1_000;
  return positive(value) ? `>${value.toFixed(1)}s` : USAGE_DASH;
}

function buildDiagnosticRows(
  metrics: CompletedMetrics | undefined,
  liveSpeed: LiveSpeedState | undefined,
  liveTtft: LiveTtftState | undefined,
): UsageRow[] {
  return [
    {
      label: liveSpeed ? "Live speed" : USAGE_LABELS[8],
      value: liveSpeed ? formatLiveSpeed(liveSpeed) : formatGenerationSpeed(metrics),
    },
    {
      label: USAGE_LABELS[9],
      value: liveTtft ? formatLiveTtft(liveTtft) : formatTtft(metrics),
    },
  ];
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function modelKey(message: SessionMessageAssistant): string {
  return JSON.stringify([message.model.providerID, message.model.id]);
}

function addCalibration(
  calibrations: CompletedMetrics["calibrations"],
  key: string,
  chars: number,
  tokens: number,
): void {
  if (!positive(chars) || !positive(tokens)) return;
  const calibration = calibrations.get(key) ?? { chars: 0, tokens: 0 };
  calibration.chars += chars;
  calibration.tokens += tokens;
  calibrations.set(key, calibration);
}

export interface UsageModel {
  status: () => UsageStatus;
  rows: () => readonly UsageRow[];
  includesSubagents: () => boolean;
}

function addTotals(target: Totals, source: Totals): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
}

interface FamilyResult {
  totals?: Totals;
  metrics: CompletedMetrics;
  hasDescendants: boolean;
  members: ReadonlySet<string>;
  contributions: ReadonlyMap<string, SessionContribution>;
  incompleteBranches: ReadonlySet<string>;
}

interface SessionContribution {
  totals?: Totals;
  metrics: CompletedMetrics;
  parentID?: string;
}

interface Freshness {
  request: number;
  sessionID: string;
  startRevision: number;
}

interface RemoteState {
  sessionID: string;
  totals?: Totals;
  metrics?: CompletedMetrics;
  hasDescendants: boolean;
  failed: boolean;
  contributions?: ReadonlyMap<string, SessionContribution>;
  incompleteBranches?: ReadonlySet<string>;
}

/** Minimal identity of a session announced by an event; totals arrive via fetch. */
interface SessionRef {
  id: string;
  parentID?: string;
}

/** A step is finished once its tokens or completion time is recorded. */
function finishedStep(message: SessionMessageAssistant): boolean {
  return message.tokens !== undefined || message.time.completed !== undefined;
}

function completedMetrics(messages: readonly SessionMessageInfo[]): CompletedMetrics {
  const result = emptyMetrics();
  for (const info of messages) {
    if (info.type !== "assistant") continue;
    if (finishedStep(info)) result.steps++;
    if (!positive(info.time.completed ?? 0)) continue;

    let stepChars = 0;
    let stepHasTool = false;
    for (const item of info.content) {
      if (item.type === "text" || item.type === "reasoning") {
        stepChars += codePoints(item.text);
        continue;
      }
      if (item.type === "tool") stepHasTool = true;
    }
    if (info.tokens && !stepHasTool) {
      addCalibration(
        result.calibrations,
        modelKey(info),
        stepChars,
        info.tokens.output + info.tokens.reasoning,
      );
    }

    // Without streamed timing there is no first-token sample and no decode
    // baseline, so the step contributes steps/calibration only.
    const streamed = info.time.streamed;
    if (!positive(streamed ?? 0)) continue;
    const visible = info.content.some((item) => item.type === "text" || item.type === "reasoning");
    if (!visible) continue;
    const ttft = (streamed as number) - info.time.created;
    if (!positive(ttft)) continue;

    result.ttftMs += ttft;
    result.ttftCount++;

    const generated = info.tokens ? info.tokens.output + info.tokens.reasoning : 0;
    const tools = info.content.reduce((sum, item) => {
      if (item.type !== "tool" || item.state.status !== "completed") return sum;
      const duration = (item.time.completed ?? 0) - (item.time.ran ?? item.time.created);
      return positive(duration) ? sum + duration : sum;
    }, 0);
    const decode = (info.time.completed as number) - info.time.created - ttft - tools;
    if (!positive(generated) || !positive(decode)) continue;
    result.generated += generated;
    result.decodeMs += decode;
  }
  return result;
}

function addMetrics(target: CompletedMetrics, source: CompletedMetrics): void {
  target.generated += source.generated;
  target.decodeMs += source.decodeMs;
  target.ttftMs += source.ttftMs;
  target.ttftCount += source.ttftCount;
  target.steps += source.steps;
  for (const [key, sourceCalibration] of source.calibrations) {
    addCalibration(target.calibrations, key, sourceCalibration.chars, sourceCalibration.tokens);
  }
}

/**
 * Whether the viewed session launched subagents: at least one other member of
 * the family descends from it. Siblings and ancestors do not count, so the
 * section title stays "Token Usage" unless the current session itself has
 * descendants.
 */
function hasCurrentDescendant(
  viewedID: string,
  contributions: ReadonlyMap<string, SessionContribution>,
): boolean {
  for (const id of contributions.keys()) {
    if (id === viewedID) continue;
    if (belongsToBranch(id, viewedID, contributions)) return true;
  }
  return false;
}

function aggregateContributions(
  contributions: ReadonlyMap<string, SessionContribution>,
  incompleteBranches: ReadonlySet<string> = new Set(),
  viewedID?: string,
): FamilyResult {
  let totals: Totals | undefined;
  const metrics = emptyMetrics();
  for (const contribution of contributions.values()) {
    if (contribution.totals) {
      if (totals) addTotals(totals, contribution.totals);
      else totals = { ...contribution.totals };
    }
    addMetrics(metrics, contribution.metrics);
  }
  const members = new Set(contributions.keys());
  return {
    totals,
    metrics,
    hasDescendants: viewedID
      ? hasCurrentDescendant(viewedID, contributions)
      : members.size > 1,
    members,
    contributions,
    incompleteBranches,
  };
}

async function listAllMessages(
  client: UsageApi["client"],
  sessionID: string,
): Promise<SessionMessageInfo[]> {
  const collected: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({ sessionID, ...(cursor ? { cursor } : {}) });
    collected.push(...page.data);
    cursor = page.cursor?.next ?? undefined;
  } while (cursor);
  return collected.sort((a, b) => (a.time.created ?? 0) - (b.time.created ?? 0));
}

async function fetchContribution(
  client: UsageApi["client"],
  session: SessionInfo,
): Promise<SessionContribution> {
  let metrics = emptyMetrics();
  try {
    metrics = completedMetrics(await listAllMessages(client, session.id));
  } catch {
    // Totals stay usable when diagnostic history cannot be read.
  }
  return {
    totals: totalsFromSession(session),
    metrics,
    ...(session.parentID ? { parentID: session.parentID } : {}),
  };
}

async function fetchBranch(
  client: UsageApi["client"],
  root: SessionInfo,
): Promise<FamilyResult> {
  const contributions = new Map<string, SessionContribution>();
  const incompleteBranches = new Set<string>();
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const session = queue.shift() as SessionInfo;
    if (visited.has(session.id)) continue;
    visited.add(session.id);
    contributions.set(session.id, await fetchContribution(client, session));
    try {
      const children = (await client.session.list({ parentID: session.id })).data;
      for (const child of children) {
        if (child && !visited.has(child.id)) queue.push(child);
      }
    } catch {
      incompleteBranches.add(session.id);
    }
  }
  return aggregateContributions(contributions, incompleteBranches, root.id);
}

function walkParents(
  sessionID: string,
  contributions: ReadonlyMap<string, SessionContribution>,
  matches: (id: string) => boolean,
): boolean {
  const visited = new Set<string>();
  let current: string | undefined = sessionID;
  while (current && !visited.has(current)) {
    if (matches(current)) return true;
    visited.add(current);
    current = contributions.get(current)?.parentID;
  }
  return false;
}

function belongsToIncompleteBranch(
  sessionID: string,
  incompleteBranches: ReadonlySet<string>,
  previous: ReadonlyMap<string, SessionContribution>,
): boolean {
  return walkParents(sessionID, previous, (id) => incompleteBranches.has(id));
}

function belongsToBranch(
  sessionID: string,
  rootID: string,
  contributions: ReadonlyMap<string, SessionContribution>,
): boolean {
  return walkParents(sessionID, contributions, (id) => id === rootID);
}

/**
 * Totals cover the whole family resolved from the root: the root session plus
 * all descendants (subagents). The walk counts each session once and keeps
 * resolved aggregates when a branch fails to resolve.
 */
async function fetchFamily(
  client: UsageApi["client"],
  sessionID: string,
): Promise<FamilyResult> {
  let root = await client.session.get({ sessionID });
  if (!root) throw new Error("session unavailable");
  const ancestors = new Set([root.id]);
  while (root.parentID && !ancestors.has(root.parentID)) {
    ancestors.add(root.parentID);
    const parent = await client.session.get({ sessionID: root.parentID });
    if (!parent) throw new Error("parent session unavailable");
    root = parent;
  }
  return fetchBranch(client, root);
}

/**
 * Reactive primitives owned by the TUI entrypoint.
 *
 * The entry (usage-panel.tsx) imports these from "solid-js", where the host
 * rewrites them to its own runtime. usage-model.ts must not value-import
 * "solid-js" itself: as an npm-installed file under node_modules, the host's
 * prescan can miss this sibling, leaving it bound to an isolated solid-js
 * copy. Signals from two runtimes never notify each other's renderers, which
 * freezes the panel at its first paint ("No usage yet.").
 */
export interface SolidRuntime {
  createSignal: typeof Solid.createSignal;
  createMemo: typeof Solid.createMemo;
  createEffect: typeof Solid.createEffect;
  onCleanup: typeof Solid.onCleanup;
  untrack: typeof Solid.untrack;
}

/**
 * Usage Model over OpenCode's session aggregate. Totals cover the whole family
 * resolved from the root (the session plus all subagent descendants); request
 * sequencing keeps slower responses from overwriting newer ones.
 */
export function createUsageModel(
  api: UsageApi,
  sessionId: () => string,
  solid: SolidRuntime,
): UsageModel {
  const [remote, setRemote] = solid.createSignal<RemoteState>();
  const [liveSpeed, setLiveSpeed] = solid.createSignal<LiveSpeedState>();
  const [liveTtft, setLiveTtft] = solid.createSignal<LiveTtftState>();
  let request = 0;
  let nextAsyncRequest = 0;
  const memberRequests = new Map<string, number>();
  const branchRequests = new Map<string, number>();
  let appliedRevision = 0;
  const contributionRevisions = new Map<string, number>();
  const pendingBranches = new Map<string, SessionRef>();
  const failedMembers = new Set<string>();
  /** Parent links announced by events, for contributions created before any fetch lands. */
  const parents = new Map<string, string>();
  /** Deleted session ids; a full refresh must never resurrect their totals. */
  const tombstones = new Set<string>();
  /** Content items whose stream already ended; stale deltas must not restart them. */
  const endedParts = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ttftTurnShown = false;
  let members: ReadonlySet<string> = new Set();

  const isAttachable = (session: SessionRef): boolean =>
    !!session.parentID && members.has(session.parentID) && !members.has(session.id);

  const captureFreshness = (): Freshness => ({
    request,
    sessionID: sessionId(),
    startRevision: appliedRevision,
  });
  const isFresh = (freshness: Freshness): boolean =>
    freshness.request === request && freshness.sessionID === sessionId();
  const isCurrent = (
    previous: RemoteState | undefined,
    freshness: Freshness,
  ): previous is RemoteState => !!previous && isFresh(freshness);
  const hasNewerIncremental = (id: string, freshness: Freshness): boolean =>
    (contributionRevisions.get(id) ?? 0) > freshness.startRevision;
  const markRevised = (ids: Iterable<string>): void => {
    const revision = ++appliedRevision;
    for (const id of ids) contributionRevisions.set(id, revision);
  };
  const publishFamily = (
    sessionID: string,
    contributions: ReadonlyMap<string, SessionContribution>,
    incompleteBranches: ReadonlySet<string> | undefined,
  ): RemoteState => {
    const aggregate = aggregateContributions(contributions, incompleteBranches, sessionID);
    members = aggregate.members;
    for (const [id, contribution] of contributions) {
      if (contribution.parentID) parents.set(id, contribution.parentID);
    }
    return {
      sessionID,
      totals: aggregate.totals,
      metrics: aggregate.metrics,
      hasDescendants: aggregate.hasDescendants,
      contributions,
      incompleteBranches: aggregate.incompleteBranches,
      failed: !aggregate.totals,
    };
  };

  const stopTimerIfIdle = () => {
    if (liveSpeed() || liveTtft() || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      const now = Date.now();
      setLiveSpeed((current) =>
        current && {
          ...current,
          now,
          displayedChars: current.chars,
          hasTicked: now - current.startedAt >= 1_000,
        },
      );
      setLiveTtft((current) => current && { ...current, now });
      stopTimerIfIdle();
    }, 1_000);
  };
  const clearLiveSpeed = () => {
    setLiveSpeed(undefined);
    stopTimerIfIdle();
  };
  const clearLiveTtft = () => {
    setLiveTtft(undefined);
    stopTimerIfIdle();
  };
  const clearProvisional = () => {
    setLiveSpeed(undefined);
    setLiveTtft(undefined);
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /**
   * Live TTFT belongs to the first assistant step of a turn only; later steps
   * follow tool calls and would report tool latency as "time to first token".
   * A turn is the run of assistant messages after the last non-assistant
   * message; it is already spoken for when any of its steps finished. When the
   * panel mounts mid-first-step the seeded measurement keeps the elapsed time
   * visible from the step's start.
   */
  const scanTurnState = (sessionID: string): { shown: boolean; seed?: SessionMessageAssistant } => {
    try {
      const messages = api.data.session.message.list(sessionID);
      const run: SessionMessageAssistant[] = [];
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.type !== "assistant") break;
        run.unshift(message);
      }
      const shown = run.some(finishedStep);
      const seed = !shown ? run[0] : undefined;
      return { shown, ...(seed ? { seed } : {}) };
    } catch {
      return { shown: false };
    }
  };

  const refresh = (sessionID: string) => {
    const freshness: Freshness = { request: ++request, sessionID, startRevision: appliedRevision };
    void fetchFamily(api.client, sessionID)
      .then((family) => {
        if (!isFresh(freshness)) return;
        setRemote((previous) => {
          const contributions = new Map(family.contributions);
          if (previous?.sessionID === sessionID && previous.contributions) {
            for (const [id, revision] of contributionRevisions) {
              if (!hasNewerIncremental(id, freshness)) continue;
              const contribution = previous.contributions.get(id);
              if (contribution) contributions.set(id, contribution);
              else contributions.delete(id);
            }
          }
          if (
            family.incompleteBranches.size > 0 &&
            previous?.sessionID === sessionID &&
            previous.contributions
          ) {
            for (const [id, contribution] of previous.contributions) {
              if (
                !contributions.has(id) &&
                !tombstones.has(id) &&
                belongsToIncompleteBranch(id, family.incompleteBranches, previous.contributions)
              ) {
                contributions.set(id, contribution);
              }
            }
          }
          const next = publishFamily(sessionID, contributions, family.incompleteBranches);
          for (const id of failedMembers) {
            if (!members.has(id)) failedMembers.delete(id);
          }
          return next;
        });
        const deferred = [...pendingBranches.values()];
        pendingBranches.clear();
        let progressed = true;
        while (deferred.length > 0 && progressed) {
          progressed = false;
          for (let i = deferred.length - 1; i >= 0; i--) {
            const session = deferred[i] as SessionRef;
            if (tombstones.has(session.id) || members.has(session.id)) {
              deferred.splice(i, 1);
              continue;
            }
            if (!isAttachable(session)) continue;
            deferred.splice(i, 1);
            refreshBranch(session.id, true);
            progressed = true;
          }
        }
      })
      .catch(() => {
        if (!isFresh(freshness)) return;
        setRemote((previous) =>
          previous?.sessionID === sessionID && previous.totals
            ? { ...previous, failed: true }
            : { sessionID, hasDescendants: false, failed: true },
        );
      });
  };

  solid.createEffect(() => {
    const sessionID = sessionId();
    clearProvisional();
    members = new Set([sessionID]);
    memberRequests.clear();
    branchRequests.clear();
    contributionRevisions.clear();
    appliedRevision = 0;
    pendingBranches.clear();
    failedMembers.clear();
    tombstones.clear();
    endedParts.clear();
    setRemote(undefined);
    solid.untrack(() => {
      const turn = scanTurnState(sessionID);
      ttftTurnShown = turn.shown;
      if (turn.seed) {
        ttftTurnShown = true;
        setLiveTtft({
          messageID: turn.seed.id,
          createdAt: turn.seed.time.created,
          now: Date.now(),
        });
        ensureTimer();
      }
      refresh(sessionID);
    });
  });

  const mergeContributions = (
    additions: ReadonlyMap<string, SessionContribution>,
    freshness: Freshness,
  ) => {
    if (!isFresh(freshness)) return;
    setRemote((previous) => {
      if (!isCurrent(previous, freshness) || !previous.contributions) return previous;
      const contributions = new Map(previous.contributions);
      for (const [id, contribution] of additions) contributions.set(id, contribution);
      markRevised(additions.keys());
      for (const id of additions.keys()) failedMembers.delete(id);
      return publishFamily(freshness.sessionID, contributions, previous.incompleteBranches);
    });
  };
  const refreshMember = (memberID: string) => {
    if (!members.has(memberID)) return;
    const freshness = captureFreshness();
    const memberRequest = ++nextAsyncRequest;
    memberRequests.set(memberID, memberRequest);
    void api.client.session.get({ sessionID: memberID })
      .then((data) => {
        if (!data) throw new Error("session unavailable");
        return fetchContribution(api.client, data);
      })
      .then((contribution) => {
        if (memberRequests.get(memberID) !== memberRequest) return;
        mergeContributions(new Map([[memberID, contribution]]), freshness);
      })
      .catch(() => {
        if (memberRequests.get(memberID) !== memberRequest) return;
        if (!isFresh(freshness)) return;
        failedMembers.add(memberID);
      });
  };
  const refreshBranch = (branchID: string, isNew: boolean) => {
    if (isNew) members = new Set([...members, branchID]);
    const freshness = captureFreshness();
    const branchRequest = ++nextAsyncRequest;
    branchRequests.set(branchID, branchRequest);
    void api.client.session.get({ sessionID: branchID })
      .then((root) => {
        if (!root) throw new Error("session unavailable");
        return fetchBranch(api.client, root);
      })
      .then((branch) => {
        setRemote((previous) => {
          if (
            !isCurrent(previous, freshness) ||
            branchRequests.get(branchID) !== branchRequest ||
            !previous.contributions
          ) {
            return previous;
          }
          const contributions = new Map(previous.contributions);
          const changedIds = new Set<string>();
          for (const id of previous.contributions.keys()) {
            if (
              belongsToBranch(id, branchID, previous.contributions) &&
              !branch.contributions.has(id) &&
              !belongsToIncompleteBranch(id, branch.incompleteBranches, previous.contributions) &&
              !hasNewerIncremental(id, freshness)
            ) {
              contributions.delete(id);
              changedIds.add(id);
            }
          }
          for (const [id, contribution] of branch.contributions) {
            if (!hasNewerIncremental(id, freshness)) {
              contributions.set(id, contribution);
              changedIds.add(id);
            }
          }
          const incompleteBranches = new Set(previous.incompleteBranches);
          for (const id of incompleteBranches) {
            if (belongsToBranch(id, branchID, previous.contributions)) {
              incompleteBranches.delete(id);
            }
          }
          for (const id of branch.incompleteBranches) incompleteBranches.add(id);
          markRevised(changedIds);
          for (const id of changedIds) failedMembers.delete(id);
          return publishFamily(freshness.sessionID, contributions, incompleteBranches);
        });
      })
      .catch(() => {
        if (isNew) members = new Set([...members].filter((id) => id !== branchID));
      });
  };
  const retryIncompleteBranches = () => {
    for (const branchID of remote()?.incompleteBranches ?? []) {
      refreshBranch(branchID, false);
    }
    for (const memberID of failedMembers) {
      if (!members.has(memberID)) {
        failedMembers.delete(memberID);
        continue;
      }
      refreshMember(memberID);
    }
  };
  const addBranch = (session: SessionRef) => {
    if (session.parentID) parents.set(session.id, session.parentID);
    if (members.has(session.id)) return;
    if (!session.parentID) return;
    if (!remote()?.contributions) {
      members = new Set([...members, session.id]);
      pendingBranches.set(session.id, session);
      return;
    }
    if (!isAttachable(session)) return;
    refreshBranch(session.id, true);
  };

  const offSessionCreated = api.data.on("session.created", (event) => {
    addBranch({
      id: event.data.sessionID,
      ...(event.data.parentID ? { parentID: event.data.parentID } : {}),
    });
  });
  const offSessionDeleted = api.data.on("session.deleted", (event) => {
    const deletedID = event.data.sessionID;
    const tracked = deletedID === sessionId() || members.has(deletedID) || pendingBranches.has(deletedID);
    const pruned = new Set<string>([deletedID]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [id, session] of pendingBranches) {
        if (!pruned.has(id) && session.parentID && pruned.has(session.parentID)) {
          pruned.add(id);
          expanded = true;
        }
      }
    }
    for (const id of pruned) {
      pendingBranches.delete(id);
      tombstones.add(id);
      failedMembers.delete(id);
      if (branchRequests.has(id)) {
        branchRequests.set(id, ++nextAsyncRequest);
      }
    }
    const previous = remote()?.contributions;
    if (previous) {
      for (const id of previous.keys()) {
        if (id === deletedID || belongsToBranch(id, deletedID, previous)) {
          tombstones.add(id);
          failedMembers.delete(id);
        }
      }
    }
    if (tracked) {
      clearProvisional();
      refresh(sessionId());
    }
  });
  const offUsageUpdated = api.data.on("session.usage.updated", (event) => {
    const { sessionID, cost, tokens } = event.data;
    if (pendingBranches.has(sessionID)) return;
    if (!members.has(sessionID)) return;
    const freshness = captureFreshness();
    setRemote((previous) => {
      if (!isCurrent(previous, freshness) || !previous.contributions) return previous;
      const prior = previous.contributions.get(sessionID);
      const parentID = prior?.parentID ?? parents.get(sessionID);
      const contributions = new Map(previous.contributions);
      contributions.set(sessionID, {
        ...(prior ?? { metrics: emptyMetrics() }),
        totals: totalsFromUsage(tokens, cost),
        ...(parentID ? { parentID } : {}),
      });
      markRevised([sessionID]);
      failedMembers.delete(sessionID);
      return publishFamily(freshness.sessionID, contributions, previous.incompleteBranches);
    });
    retryIncompleteBranches();
  });
  const offStepStarted = api.data.on("session.step.started", (event) => {
    const { sessionID, assistantMessageID, started } = event.data;
    if (sessionID !== sessionId()) return;
    if (ttftTurnShown) return;
    ttftTurnShown = true;
    setLiveTtft({ messageID: assistantMessageID, createdAt: started, now: Date.now() });
    ensureTimer();
  });
  const offExecutionStarted = api.data.on("session.execution.started", (event) => {
    if (event.data.sessionID !== sessionId()) return;
    ttftTurnShown = false;
  });
  const offStepStreamed = api.data.on("session.step.streamed", (event) => {
    const { sessionID, assistantMessageID } = event.data;
    if (sessionID !== sessionId()) return;
    if (liveTtft()?.messageID === assistantMessageID) clearLiveTtft();
  });
  const onStepSettled = (sessionID: string, assistantMessageID: string) => {
    if (sessionID === sessionId()) {
      if (liveTtft()?.messageID === assistantMessageID) clearLiveTtft();
      ttftTurnShown = true;
    }
    refreshMember(sessionID);
    retryIncompleteBranches();
  };
  const offStepEnded = api.data.on("session.step.ended", (event) => {
    onStepSettled(event.data.sessionID, event.data.assistantMessageID);
  });
  const offStepFailed = api.data.on("session.step.failed", (event) => {
    onStepSettled(event.data.sessionID, event.data.assistantMessageID);
  });
  const onStreamDelta = (
    kind: "text" | "reasoning",
    stream: { sessionID: string; assistantMessageID: string; ordinal: number; delta: string },
  ) => {
    const { sessionID, assistantMessageID, ordinal, delta } = stream;
    if (sessionID !== sessionId()) return;
    const partKey = `${kind}:${assistantMessageID}:${ordinal}`;
    if (endedParts.has(partKey)) return;
    let message: SessionMessageInfo | undefined;
    try {
      message = api.data.session.message
        .list(sessionID)
        .find((candidate) => candidate.id === assistantMessageID);
    } catch {
      return;
    }
    if (message?.type !== "assistant" || message.time.completed !== undefined) return;
    const streaming = message;

    const now = Date.now();
    const chars = codePoints(delta);
    setLiveSpeed((current) => {
      if (current?.partKey === partKey) {
        return { ...current, chars: current.chars + chars };
      }
      const calibration = remote()?.metrics?.calibrations.get(modelKey(streaming));
      const charsPerToken =
        (400 + (calibration?.chars ?? 0)) / (100 + (calibration?.tokens ?? 0));
      return {
        messageID: assistantMessageID,
        partKey,
        startedAt: now,
        now,
        chars,
        displayedChars: 0,
        charsPerToken,
        hasTicked: false,
      };
    });
    if (liveTtft()?.messageID === assistantMessageID) clearLiveTtft();
    ensureTimer();
  };
  const offTextDelta = api.data.on("session.text.delta", (event) => {
    onStreamDelta("text", event.data);
  });
  const offReasoningDelta = api.data.on("session.reasoning.delta", (event) => {
    onStreamDelta("reasoning", event.data);
  });
  const onStreamEnded = (
    kind: "text" | "reasoning",
    end: { sessionID: string; assistantMessageID: string; ordinal: number },
  ) => {
    const { sessionID, assistantMessageID, ordinal } = end;
    if (sessionID !== sessionId()) return;
    const partKey = `${kind}:${assistantMessageID}:${ordinal}`;
    endedParts.add(partKey);
    if (liveSpeed()?.partKey === partKey) clearLiveSpeed();
  };
  const offTextEnded = api.data.on("session.text.ended", (event) => {
    onStreamEnded("text", event.data);
  });
  const offReasoningEnded = api.data.on("session.reasoning.ended", (event) => {
    onStreamEnded("reasoning", event.data);
  });
  const offContentUpdated = api.data.on("session.revert.committed", (event) => {
    if (event.data.sessionID === sessionId()) clearProvisional();
    if (members.has(event.data.sessionID)) refresh(sessionId());
  });
  const offServerConnected = api.data.on("server.connected", () => {
    clearProvisional();
    refresh(sessionId());
  });
  const offExecutionFailed = api.data.on("session.execution.failed", (event) => {
    if (!event.data.sessionID || event.data.sessionID === sessionId()) clearProvisional();
  });
  const offSessionIdle = api.data.on("session.idle", (event) => {
    if (event.data.sessionID === sessionId()) clearProvisional();
  });
  solid.onCleanup(() => {
    request++;
    clearProvisional();
    offSessionCreated();
    offSessionDeleted();
    offUsageUpdated();
    offStepStarted();
    offExecutionStarted();
    offStepStreamed();
    offStepEnded();
    offStepFailed();
    offTextDelta();
    offReasoningDelta();
    offTextEnded();
    offReasoningEnded();
    offContentUpdated();
    offServerConnected();
    offExecutionFailed();
    offSessionIdle();
  });

  const snapshot = solid.createMemo<
    { status: UsageStatus; rows: readonly UsageRow[]; hasDescendants: boolean }
  >(() => {
    try {
      const sessionID = sessionId();
      const loaded = remote();
      if (loaded?.sessionID === sessionID && loaded.failed && !loaded.totals) {
        const speed = liveSpeed();
        const ttft = liveTtft();
        const diagnostics = speed || ttft ? buildDiagnosticRows(undefined, speed, ttft) : [];
        return { status: "unavailable", rows: diagnostics, hasDescendants: false };
      }
      const totals =
        loaded?.sessionID === sessionID && loaded.totals
          ? loaded.totals
          : totalsFromSession(api.data.session.get(sessionID));
      const hasDescendants = loaded?.sessionID === sessionID
        ? loaded.hasDescendants
        : false;
      if (!totals) {
        const speed = liveSpeed();
        const ttft = liveTtft();
        const diagnostics = speed || ttft ? buildDiagnosticRows(undefined, speed, ttft) : [];
        return {
          status: loaded?.sessionID === sessionID && loaded.failed ? "unavailable" : "loading",
          rows: diagnostics,
          hasDescendants: false,
        };
      }
      const metrics = loaded?.sessionID === sessionID ? loaded.metrics : undefined;
      const speed = liveSpeed();
      const ttft = liveTtft();
      if (allZero(totals)) {
        const diagnostics = speed || ttft ? buildDiagnosticRows(undefined, speed, ttft) : [];
        return { status: "empty", rows: diagnostics, hasDescendants: false };
      }
      const diagnostics = buildDiagnosticRows(metrics, speed, ttft);
      return {
        status: "ready",
        rows: [...buildUsageRows(totals, metrics), ...diagnostics],
        hasDescendants,
      };
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
