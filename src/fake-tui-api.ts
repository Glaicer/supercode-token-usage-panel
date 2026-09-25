import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client";
import { createSignal } from "solid-js";
import type { UsageApi } from "./usage-model.ts";

/** Test double for the UsageApi slice of the TUI plugin context. */
export interface FakeStore {
  /** Per-session message history, in transcript order. */
  sessions: Map<string, readonly SessionMessageInfo[]>;
  stateUsage?: Map<string, FakeUsage>;
  serverUsage?: Map<string, FakeUsage>;
  children?: Map<string, readonly string[]>;
  serverFailures?: ReadonlySet<string>;
  serverDelays?: ReadonlyMap<string, Promise<void>>;
  serverError?: boolean;
}

export interface FakeUsage {
  tokens: TokenUsageInfo;
  cost?: number;
}

function findParentID(
  children: Map<string, readonly string[]> | undefined,
  sessionID: string,
): string | undefined {
  for (const [parent, kids] of children ?? []) {
    if (kids.includes(sessionID)) return parent;
  }
  return undefined;
}

function deriveUsage(store: FakeStore, sessionID: string): FakeUsage | undefined {
  const messages = store.sessions.get(sessionID);
  if (!messages) return undefined;
  const usage: FakeUsage = {
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  for (const message of messages) {
    if (message.type !== "assistant" || !message.tokens) continue;
    usage.tokens.input += message.tokens.input;
    usage.tokens.output += message.tokens.output;
    usage.tokens.reasoning += message.tokens.reasoning;
    usage.tokens.cache.read += message.tokens.cache.read;
    usage.tokens.cache.write += message.tokens.cache.write;
  }
  return usage;
}

function makeSession(
  store: FakeStore,
  sessionID: string,
  source: "state" | "server",
  parentID?: string,
): SessionInfo | undefined {
  const usage =
    (source === "server" ? store.serverUsage?.get(sessionID) : undefined) ??
    store.stateUsage?.get(sessionID) ??
    deriveUsage(store, sessionID);
  if (!usage) return undefined;
  return {
    id: sessionID,
    projectID: "project-test",
    ...(parentID ? { parentID } : {}),
    title: sessionID,
    time: { created: 0, updated: 0 },
    cost: usage.cost ?? 0,
    tokens: structuredClone(usage.tokens),
    location: { directory: "/" },
  };
}

export interface FakeTuiApi {
  api: UsageApi
  setStore(next: FakeStore): void
  emit(type: OpenCodeEvent["type"], data: Record<string, unknown>): void
  readonly requests: string[]
}

export function createFakeTuiApi(initial: FakeStore): FakeTuiApi {
  const [store, setStore] = createSignal<FakeStore>(initial)
  const requests: string[] = []
  const listeners = new Map<string, Set<(event: never) => void>>()
  let sequence = 0

  const api: UsageApi = {
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          requests.push(`get:${sessionID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`get:${sessionID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(sessionID)) {
            throw new Error("fake-tui-api: session.get failed");
          }
          return makeSession(snapshot, sessionID, "server", findParentID(snapshot.children, sessionID));
        },
        list: async ({ parentID }: { parentID: string }) => {
          requests.push(`children:${parentID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`children:${parentID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(parentID)) {
            throw new Error("fake-tui-api: session.list failed");
          }
          const kids = snapshot.children?.get(parentID) ?? [];
          return {
            data: kids
              .map((kid) => makeSession(snapshot, kid, "server", findParentID(snapshot.children, kid)))
              .filter((session): session is SessionInfo => session !== undefined),
          };
        },
      },
      message: {
        list: async ({ sessionID }: { sessionID: string }) => {
          requests.push(`messages:${sessionID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`messages:${sessionID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(sessionID)) {
            throw new Error("fake-tui-api: message.list failed");
          }
          return {
            data: [...(snapshot.sessions.get(sessionID) ?? [])],
            cursor: {},
          };
        },
      },
    },
    data: {
      on: (type, handler) => {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(handler)
        return () => {
          set.delete(handler)
        }
      },
      session: {
        get: (sessionID: string) => makeSession(store(), sessionID, "state"),
        message: {
          list: (sessionID: string) => {
            const messages = store().sessions.get(sessionID)
            if (!messages) throw new Error(`fake-tui-api: unknown session ${sessionID}`)
            return messages
          },
        },
      },
    },
  }

  return {
    api,
    setStore: (next) => setStore(next),
    emit: (type, data) => {
      const event = { id: `evt_${++sequence}`, created: Date.now(), type, data }
      for (const handler of listeners.get(type) ?? []) handler(event as never)
    },
    requests,
  }
}
