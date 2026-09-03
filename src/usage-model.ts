/**
 * Usage Model — every number, formula and string of the Token Usage section.
 *
 * Reads OpenCode's authoritative session aggregate and family message history,
 * folds completed speed/TTFT, and estimates the current visible stream from
 * deltas. Exposes only ready-to-render rows plus a state flag.
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { AssistantMessage, Message, Part, Session } from "@opencode-ai/sdk/v2";
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
  "Session cost",
  "Generation speed",
  "Time to first token",
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

interface CompletedMetrics {
  generated: number;
  decodeMs: number;
  ttftMs: number;
  ttftCount: number;
  calibrations: Map<string, { chars: number; tokens: number }>;
}

interface LiveSpeedState {
  messageID: string;
  partID: string;
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

function emptyMetrics(): CompletedMetrics {
  return {
    generated: 0,
    decodeMs: 0,
    ttftMs: 0,
    ttftCount: 0,
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

function totalsFromSession(session: Session | undefined): Totals | undefined {
  if (!session?.tokens) return undefined;
  return {
    input: safe(session.tokens.input),
    output: safe(session.tokens.output),
    reasoning: safe(session.tokens.reasoning),
    cacheRead: safe(session.tokens.cache.read),
    cacheWrite: safe(session.tokens.cache.write),
    cost: safe(session.cost),
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

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
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

function buildUsageRows(totals: Totals): UsageRow[] {
  return ROW_BUILDERS.map(({ label, value }) => ({ label, value: value(totals) }));
}

function formatLiveSpeed(live: LiveSpeedState): string {
  if (!live.hasTicked) return `~${USAGE_DASH}`;
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
      label: liveSpeed ? "Live speed" : USAGE_LABELS[7],
      value: liveSpeed ? formatLiveSpeed(liveSpeed) : formatGenerationSpeed(metrics),
    },
    {
      label: USAGE_LABELS[8],
      value: liveTtft ? formatLiveTtft(liveTtft) : formatTtft(metrics),
    },
  ];
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function modelKey(message: AssistantMessage): string {
  return JSON.stringify([message.providerID, message.modelID]);
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
  /** True when descendant sessions contribute to the totals. */
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
  /** True when at least one descendant session contributed. */
  hasDescendants: boolean;
  /** Root plus every discovered descendant — the refresh filter set. */
  members: ReadonlySet<string>;
  contributions: ReadonlyMap<string, SessionContribution>;
  incompleteBranches: ReadonlySet<string>;
}

interface SessionContribution {
  totals?: Totals;
  metrics: CompletedMetrics;
  parentID?: string;
}

/**
 * One sequencing snapshot shared by a full refresh and the incrementals that
 * race it: which family generation started the work, which session was
 * selected, and which incremental revisions were already applied.
 */
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

interface MessageWithParts {
  info: Message;
  parts: readonly Part[];
}

function completedMetrics(messages: readonly MessageWithParts[]): CompletedMetrics {
  const result = emptyMetrics();
  for (const { info, parts } of messages) {
    if (info.role !== "assistant") continue;
    const message = info as AssistantMessage;
    if (!positive(message.time.completed ?? 0)) continue;

    let stepChars = 0;
    let stepHasTool = false;
    for (const part of parts) {
      if (part.type === "text" || part.type === "reasoning") {
        if (positive(part.time?.end ?? 0)) stepChars += codePoints(part.text);
        continue;
      }
      if (part.type === "tool") {
        stepHasTool = true;
        continue;
      }
      if (part.type !== "step-finish") continue;
      const tokens = part.tokens.output + part.tokens.reasoning;
      if (!stepHasTool) addCalibration(result.calibrations, modelKey(message), stepChars, tokens);
      stepChars = 0;
      stepHasTool = false;
    }

    const visibleStarts = parts.flatMap((part) => {
      if (part.type !== "text" && part.type !== "reasoning") return [];
      if (!part.time || !positive(part.time.start) || !positive(part.time.end ?? 0)) return [];
      return [part.time.start];
    });
    if (visibleStarts.length === 0) continue;
    const firstVisibleAt = Math.min(...visibleStarts);
    const ttft = firstVisibleAt - message.time.created;
    if (!positive(ttft)) continue;

    result.ttftMs += ttft;
    result.ttftCount++;

    const generated = parts.reduce((sum, part) => {
      if (part.type !== "step-finish") return sum;
      return sum + part.tokens.output + part.tokens.reasoning;
    }, 0);
    const tools = parts.reduce((sum, part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return sum;
      const duration = part.state.time.end - part.state.time.start;
      return positive(duration) ? sum + duration : sum;
    }, 0);
    const decode = (message.time.completed as number) - message.time.created - ttft - tools;
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
  for (const [key, sourceCalibration] of source.calibrations) {
    addCalibration(target.calibrations, key, sourceCalibration.chars, sourceCalibration.tokens);
  }
}

function aggregateContributions(
  contributions: ReadonlyMap<string, SessionContribution>,
  incompleteBranches: ReadonlySet<string> = new Set(),
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
    hasDescendants: members.size > 1,
    members,
    contributions,
    incompleteBranches,
  };
}

async function fetchContribution(
  client: TuiPluginApi["client"],
  session: Session,
): Promise<SessionContribution> {
  let metrics = emptyMetrics();
  try {
    const messages = (
      await client.session.messages({ sessionID: session.id }, { throwOnError: true })
    ).data;
    metrics = completedMetrics(messages);
  } catch {
    // Token and cost aggregates remain useful when diagnostic history is unavailable.
  }
  return {
    totals: totalsFromSession(session),
    metrics,
    ...(session.parentID ? { parentID: session.parentID } : {}),
  };
}

async function fetchBranch(
  client: TuiPluginApi["client"],
  root: Session,
): Promise<FamilyResult> {
  const contributions = new Map<string, SessionContribution>();
  const incompleteBranches = new Set<string>();
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const session = queue.shift() as Session;
    if (visited.has(session.id)) continue;
    visited.add(session.id);
    contributions.set(session.id, await fetchContribution(client, session));
    try {
      const children = (
        await client.session.children({ sessionID: session.id }, { throwOnError: true })
      ).data;
      for (const child of children) {
        if (child && !visited.has(child.id)) queue.push(child);
      }
    } catch {
      incompleteBranches.add(session.id);
      // Retry this unresolved branch on the next family invalidation.
    }
  }
  return aggregateContributions(contributions, incompleteBranches);
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
 * Fetches the root session, then walks its descendants breadth-first via
 * `session.children`. The visited set guards against duplicate listing (a
 * session reported as a child twice, or a cycle) so no usage is double-counted.
 * A failed descendant lookup prunes only that unresolved branch; aggregates
 * already returned by a parent remain authoritative and still contribute.
 */
async function fetchFamily(
  client: TuiPluginApi["client"],
  sessionID: string,
): Promise<FamilyResult> {
  let root = (await client.session.get({ sessionID }, { throwOnError: true })).data;
  if (!root) throw new Error("session unavailable");
  const ancestors = new Set([root.id]);
  while (root.parentID && !ancestors.has(root.parentID)) {
    ancestors.add(root.parentID);
    const parent = (
      await client.session.get({ sessionID: root.parentID }, { throwOnError: true })
    ).data;
    if (!parent) throw new Error("parent session unavailable");
    root = parent;
  }
  return fetchBranch(client, root);
}

/**
 * Usage Model over OpenCode's session aggregate. The TUI session list can lag
 * while a response is running, so usage-changing events trigger a fresh local
 * API read; request sequencing prevents slower responses from winning.
 * Totals cover the current session plus all of its descendants (subagents).
 */
export function createUsageModel(api: TuiPluginApi, sessionId: () => string): UsageModel {
  const [remote, setRemote] = createSignal<RemoteState>();
  const [liveSpeed, setLiveSpeed] = createSignal<LiveSpeedState>();
  const [liveTtft, setLiveTtft] = createSignal<LiveTtftState>();
  let request = 0;
  let nextAsyncRequest = 0;
  const memberRequests = new Map<string, number>();
  const branchRequests = new Map<string, number>();
  let appliedRevision = 0;
  const contributionRevisions = new Map<string, number>();
  const pendingBranches = new Map<string, Session>();
  /** Member ids whose last incremental get failed; retried on next invalidation. */
  const failedMembers = new Set<string>();
  /** Deleted session ids; a full refresh must never resurrect their totals. */
  const tombstones = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ttftTurns = new Set<string>();
  /** Sessions of the last confirmed family walk; membership-filtered events. */
  let members: ReadonlySet<string> = new Set();

  /** A queued or live session joins the family only via a known parent. */
  const isAttachable = (session: Session): boolean =>
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
  /** True when an incremental touched this contribution after the work started. */
  const hasNewerIncremental = (id: string, freshness: Freshness): boolean =>
    (contributionRevisions.get(id) ?? 0) > freshness.startRevision;
  const markRevised = (ids: Iterable<string>): void => {
    const revision = ++appliedRevision;
    for (const id of ids) contributionRevisions.set(id, revision);
  };
  /**
   * The shared merge-and-publish tail: fold contributions, adopt the member
   * set, and shape the remote snapshot the View reads.
   */
  const publishFamily = (
    sessionID: string,
    contributions: ReadonlyMap<string, SessionContribution>,
    incompleteBranches: ReadonlySet<string> | undefined,
  ): RemoteState => {
    const aggregate = aggregateContributions(contributions, incompleteBranches);
    members = aggregate.members;
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
  const completedTurns = (sessionID: string): Set<string> => {
    const turns = new Set<string>();
    try {
      for (const message of api.state.session.messages(sessionID)) {
        if (message.role !== "assistant") continue;
        const hasFinishedStep = api.state
          .part(message.id)
          .some((part) => part.type === "step-finish");
        if (message.time.completed !== undefined || hasFinishedStep) turns.add(message.parentID);
      }
    } catch {
      // State can be incomplete during a session transition; live events fill it in.
    }
    return turns;
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
        // Attach parent-first to a fixpoint: out-of-order queued chains resolve
        // once their parent commits, while true orphans never attach.
        let progressed = true;
        while (deferred.length > 0 && progressed) {
          progressed = false;
          for (let i = deferred.length - 1; i >= 0; i--) {
            const session = deferred[i] as Session;
            if (tombstones.has(session.id) || members.has(session.id)) {
              deferred.splice(i, 1);
              continue;
            }
            if (!isAttachable(session)) continue;
            deferred.splice(i, 1);
            refreshBranch(session, true);
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

  createEffect(() => {
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
    setRemote(undefined);
    untrack(() => {
      ttftTurns = completedTurns(sessionID);
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
    void api.client.session.get({ sessionID: memberID }, { throwOnError: true })
      .then(({ data }) => {
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
        // The last confirmed contribution stays; track the failed member on
        // its own retry list so the next family invalidation retries it. A
        // recovered member clears its own flag on success, unlike branch
        // failures which only a branch refetch can resolve.
        failedMembers.add(memberID);
      });
  };
  const refreshBranch = (session: Session, isNew: boolean) => {
    if (isNew) members = new Set([...members, session.id]);
    const freshness = captureFreshness();
    const branchRequest = ++nextAsyncRequest;
    branchRequests.set(session.id, branchRequest);
    void fetchBranch(api.client, session)
      .then((branch) => {
        setRemote((previous) => {
          if (
            !isCurrent(previous, freshness) ||
            branchRequests.get(session.id) !== branchRequest ||
            !previous.contributions
          ) {
            return previous;
          }
          const contributions = new Map(previous.contributions);
          const changedIds = new Set<string>();
          for (const id of previous.contributions.keys()) {
            if (
              belongsToBranch(id, session.id, previous.contributions) &&
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
            if (belongsToBranch(id, session.id, previous.contributions)) {
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
        if (isNew) members = new Set([...members].filter((id) => id !== session.id));
      });
  };
  const retryIncompleteBranches = () => {
    for (const sessionID of remote()?.incompleteBranches ?? []) {
      void api.client.session.get({ sessionID }, { throwOnError: true })
        .then(({ data }) => {
          if (data) refreshBranch(data, false);
        })
        .catch(() => {
          // The next invalidation retries again.
        });
    }
    for (const memberID of failedMembers) {
      if (!members.has(memberID)) {
        failedMembers.delete(memberID);
        continue;
      }
      refreshMember(memberID);
    }
  };
  const addBranch = (session: Session) => {
    if (members.has(session.id)) return;
    if (!session.parentID) return;
    if (!remote()?.contributions) {
      // Initial load: queue every chained session; the replay resolves
      // out-of-order chains to a fixpoint and drops true orphans.
      members = new Set([...members, session.id]);
      pendingBranches.set(session.id, session);
      return;
    }
    if (!isAttachable(session)) return;
    refreshBranch(session, true);
  };
  const offSessionCreated = api.event.on("session.created", (event) => {
    addBranch(event.properties.info);
  });
  const offSessionDeleted = api.event.on("session.deleted", (event) => {
    const deletedID = event.properties.sessionID;
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
  const offPartUpdated = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part;
    if (
      part.sessionID === sessionId() &&
      (part.type === "text" || part.type === "reasoning") &&
      part.time?.end !== undefined &&
      liveSpeed()?.partID === part.id
    ) {
      clearLiveSpeed();
    }
    if (event.properties.part.type === "step-finish") {
      if (
        event.properties.part.sessionID === sessionId() &&
        liveTtft()?.messageID === event.properties.part.messageID
      ) {
        clearLiveTtft();
      }
      if (event.properties.part.sessionID === sessionId()) {
        const message = api.state.session
          .messages(sessionId())
          .find((candidate) => candidate.id === event.properties.part.messageID);
        if (message?.role === "assistant") ttftTurns.add(message.parentID);
      }
      refreshMember(event.properties.part.sessionID);
      retryIncompleteBranches();
    }
  });
  const offPartRemoved = api.event.on("message.part.removed", (event) => {
    if (event.properties.sessionID === sessionId()) clearProvisional();
    if (members.has(event.properties.sessionID)) refresh(sessionId());
  });
  const offMessageRemoved = api.event.on("message.removed", (event) => {
    if (event.properties.sessionID === sessionId()) clearProvisional();
    if (members.has(event.properties.sessionID)) refresh(sessionId());
  });
  const offSessionUpdated = api.event.on("session.updated", (event) => {
    if (pendingBranches.has(event.properties.info.id)) {
      pendingBranches.set(event.properties.info.id, event.properties.info);
      return;
    }
    if (members.has(event.properties.info.id)) {
      refreshMember(event.properties.info.id);
      retryIncompleteBranches();
      return;
    }
    addBranch(event.properties.info);
  });
  const offMessageUpdated = api.event.on("message.updated", (event) => {
    const message = event.properties.info;
    if (!members.has(event.properties.sessionID) || message.role !== "assistant") return;
    if (event.properties.sessionID !== sessionId()) {
      if (message.time.completed !== undefined) {
        refreshMember(event.properties.sessionID);
        retryIncompleteBranches();
      }
      return;
    }
    if (message.time.completed !== undefined) {
      ttftTurns.add(message.parentID);
      if (liveTtft()?.messageID === message.id) clearLiveTtft();
      refreshMember(event.properties.sessionID);
      return;
    }
    if (ttftTurns.has(message.parentID)) return;
    ttftTurns.add(message.parentID);
    const now = Date.now();
    setLiveTtft({ messageID: message.id, createdAt: message.time.created, now });
    ensureTimer();
  });
  const offPartDelta = api.event.on("message.part.delta", (event) => {
    const { sessionID, messageID, partID, field, delta } = event.properties;
    if (sessionID !== sessionId() || field !== "text") return;
    let part: Part | undefined;
    let message: Message | undefined;
    try {
      part = api.state.part(messageID).find((candidate) => candidate.id === partID);
      message = api.state.session.messages(sessionID).find((candidate) => candidate.id === messageID);
    } catch {
      return;
    }
    if (
      (part?.type !== "text" && part?.type !== "reasoning") ||
      part.time?.end !== undefined ||
      message?.role !== "assistant"
    ) {
      return;
    }

    const now = Date.now();
    const chars = codePoints(delta);
    setLiveSpeed((current) => {
      if (current?.partID === partID && current.messageID === messageID) {
        return { ...current, chars: current.chars + chars };
      }
      const calibration = remote()?.metrics?.calibrations.get(modelKey(message));
      const charsPerToken =
        (400 + (calibration?.chars ?? 0)) / (100 + (calibration?.tokens ?? 0));
      return {
        messageID,
        partID,
        startedAt: now,
        now,
        chars,
        displayedChars: 0,
        charsPerToken,
        hasTicked: false,
      };
    });
    if (liveTtft()?.messageID === messageID) clearLiveTtft();
    ensureTimer();
  });
  const offServerConnected = api.event.on("server.connected", () => {
    clearProvisional();
    refresh(sessionId());
  });
  const offSessionError = api.event.on("session.error", (event) => {
    if (!event.properties.sessionID || event.properties.sessionID === sessionId()) clearProvisional();
  });
  const offSessionIdle = api.event.on("session.idle", (event) => {
    if (event.properties.sessionID === sessionId()) clearProvisional();
  });
  onCleanup(() => {
    request++;
    clearProvisional();
    offSessionCreated();
    offSessionDeleted();
    offPartUpdated();
    offPartRemoved();
    offMessageRemoved();
    offSessionUpdated();
    offMessageUpdated();
    offPartDelta();
    offServerConnected();
    offSessionError();
    offSessionIdle();
  });

  const snapshot = createMemo<
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
          : totalsFromSession(api.state.session.get(sessionID));
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
        rows: [...buildUsageRows(totals), ...diagnostics],
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
