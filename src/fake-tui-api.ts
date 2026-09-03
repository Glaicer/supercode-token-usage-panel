import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2";
import { createSignal } from "solid-js";

/**
 * Fake TuiPluginApi for Usage Model tests: a solid-signal-backed stand-in for
 * the reactive TUI state plus throwing stubs for everything the model never
 * touches. Typed against the published @opencode-ai/plugin and
 * @opencode-ai/sdk surfaces, so an API drift fails HERE, on typecheck.
 *
 * Shortcut (deliberate): renderer/keymap/keymap-adjacent fields are identity
 * stubs behind one narrow cast — the plugin depends on none of them; their
 * internal shape drifting cannot break this plugin until it starts using them.
 */
export interface FakeStore {
  sessions: Map<string, readonly Message[]>;
  parts: Map<string, readonly Part[]>;
  stateUsage?: Map<string, FakeUsage>;
  serverUsage?: Map<string, FakeUsage>;
  /** Direct children by sessionID — what client.session.children returns. */
  children?: Map<string, readonly string[]>;
  /** Sessions that fail session.get / session.children (per-request blackholes). */
  serverFailures?: ReadonlySet<string>;
  /** Request-specific barriers used to exercise async ordering in tests. */
  serverDelays?: ReadonlyMap<string, Promise<void>>;
  serverError?: boolean;
}

export interface FakeUsage {
  tokens: NonNullable<Session["tokens"]>;
  cost?: number;
}

function fail(what: string): never {
  throw new Error(`fake-tui-api: ${what} is not implemented`)
}

/** Reverse lookup: which parent lists this sessionID as its child. */
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
  if (!messages) return undefined;  const usage: FakeUsage = {
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  for (const message of messages) {
    for (const part of store.parts.get(message.id) ?? []) {
      if (part.type !== "step-finish") continue;
      usage.tokens.input += part.tokens.input;
      usage.tokens.output += part.tokens.output;
      usage.tokens.reasoning += part.tokens.reasoning;
      usage.tokens.cache.read += part.tokens.cache.read;
      usage.tokens.cache.write += part.tokens.cache.write;
    }
  }
  return usage;
}

function makeSession(
  store: FakeStore,
  sessionID: string,
  source: "state" | "server",
  parentID?: string,
): Session | undefined {
  const usage =
    (source === "server" ? store.serverUsage?.get(sessionID) : undefined) ??
    store.stateUsage?.get(sessionID) ??
    deriveUsage(store, sessionID);
  if (!usage) return undefined;
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-test",
    directory: "/",
    title: sessionID,
    version: "0.0.0-test",
    ...(parentID ? { parentID } : {}),
    time: { created: 0, updated: 0 },
    cost: usage.cost ?? 0,
    tokens: structuredClone(usage.tokens),
  };
}

function makeState(get: () => FakeStore): TuiPluginApi["state"] {
  const store = () => get()
  const state: TuiPluginApi["state"] = {
    get ready() {
      return true
    },
    get config() {
      return fail("state.config");
    },
    provider: [],
    path: { state: "", config: "", worktree: "", directory: "" },
    vcs: undefined,
    session: {
      count: () => store().sessions.size,
      get: (sessionID) => makeSession(store(), sessionID, "state"),
      diff: () => [],
      todo: () => [],
      messages: (sessionID) => {
        const messages = store().sessions.get(sessionID)
        if (!messages) throw new Error(`fake-tui-api: unknown session ${sessionID}`)
        return messages
      },
      status: () => undefined,
      permission: () => [],
      question: () => [],
    },
    part: (messageID) => {
      const parts = store().parts.get(messageID)
      if (!parts) throw new Error(`fake-tui-api: unknown message ${messageID}`)
      return parts
    },
    lsp: () => [],
    mcp: () => [],
  }
  return state
}

// Shortcut (deliberate): RGBA is a native-backed @opentui/core class that
// cannot load headless under plain node, so the theme literal is one narrow
// cast. The View's use of these fields stays type-checked by tsc against
// TuiThemeCurrent; the model never reads the theme.
const TEST_COLOR = { r: 1, g: 0, b: 0, a: 1 };

const themeCurrent = {
  primary: TEST_COLOR,
  secondary: TEST_COLOR,
  accent: TEST_COLOR,
  error: TEST_COLOR,
  warning: TEST_COLOR,
  success: TEST_COLOR,
  info: TEST_COLOR,
  text: TEST_COLOR,
  textMuted: TEST_COLOR,
  selectedListItemText: TEST_COLOR,
  background: TEST_COLOR,
  backgroundPanel: TEST_COLOR,
  backgroundElement: TEST_COLOR,
  backgroundMenu: TEST_COLOR,
  border: TEST_COLOR,
  borderActive: TEST_COLOR,
  borderSubtle: TEST_COLOR,
  diffAdded: TEST_COLOR,
  diffRemoved: TEST_COLOR,
  diffContext: TEST_COLOR,
  diffHunkHeader: TEST_COLOR,
  diffHighlightAdded: TEST_COLOR,
  diffHighlightRemoved: TEST_COLOR,
  diffAddedBg: TEST_COLOR,
  diffRemovedBg: TEST_COLOR,
  diffContextBg: TEST_COLOR,
  diffLineNumber: TEST_COLOR,
  diffAddedLineNumberBg: TEST_COLOR,
  diffRemovedLineNumberBg: TEST_COLOR,
  markdownText: TEST_COLOR,
  markdownHeading: TEST_COLOR,
  markdownLink: TEST_COLOR,
  markdownLinkText: TEST_COLOR,
  markdownCode: TEST_COLOR,
  markdownBlockQuote: TEST_COLOR,
  markdownEmph: TEST_COLOR,
  markdownStrong: TEST_COLOR,
  markdownHorizontalRule: TEST_COLOR,
  markdownListItem: TEST_COLOR,
  markdownListEnumeration: TEST_COLOR,
  markdownImage: TEST_COLOR,
  markdownImageText: TEST_COLOR,
  markdownCodeBlock: TEST_COLOR,
  syntaxComment: TEST_COLOR,
  syntaxKeyword: TEST_COLOR,
  syntaxFunction: TEST_COLOR,
  syntaxVariable: TEST_COLOR,
  syntaxString: TEST_COLOR,
  syntaxNumber: TEST_COLOR,
  syntaxType: TEST_COLOR,
  syntaxOperator: TEST_COLOR,
  syntaxPunctuation: TEST_COLOR,
  thinkingOpacity: 0.5,
} as unknown as TuiPluginApi["theme"]["current"];

export interface FakeTuiApi {
  api: TuiPluginApi
  /** Pushes a new store snapshot through a solid signal, invalidating memos. */
  setStore(next: FakeStore): void
  /** Delivers an event to handlers registered via api.event.on. */
  emit(type: string, properties: unknown): void
  /** Toasts recorded here instead of going to a UI. */
  readonly toasts: { variant: string; title?: string; message: string }[]
  /** Client requests, exposed so tests can pin incremental refresh boundaries. */
  readonly requests: string[]
}

export function createFakeTuiApi(initial: FakeStore): FakeTuiApi {
  const [store, setStore] = createSignal<FakeStore>(initial)
  const toasts: { variant: string; title?: string; message: string }[] = []
  const requests: string[] = []
  const listeners = new Map<string, Set<(event: never) => void>>()

  const api: TuiPluginApi = {
    app: { version: "0.0.0-test" },
    attention: {
      notify: () => fail("attention.notify"),
      soundboard: {
        registerPack: () => fail("soundboard.registerPack"),
        activate: () => fail("soundboard.activate"),
        current: () => fail("soundboard.current"),
        list: () => [],
      },
    },
    keys: {
      formatSequence: () => "",
      formatBindings: () => undefined,
    },
    mode: {
      current: () => fail("mode.current"),
      push: () => fail("mode.push"),
    },
    route: {
      register: () => fail("route.register"),
      navigate: () => fail("route.navigate"),
      get current() {
        return fail("route.current")
      },
    },
    ui: {
      Dialog: () => fail("ui.Dialog"),
      DialogAlert: () => fail("ui.DialogAlert"),
      DialogConfirm: () => fail("ui.DialogConfirm"),
      DialogPrompt: () => fail("ui.DialogPrompt"),
      DialogSelect: () => fail("ui.DialogSelect"),
      Slot: () => null,
      Prompt: () => fail("ui.Prompt"),
      toast: (input: { variant?: string; title?: string; message: string }) => {
        toasts.push({ variant: input.variant ?? "info", title: input.title, message: input.message })
      },
      get dialog() {
        return fail("ui.dialog");
      },
    },
    kv: {
      get: <Value>(_key: string, fallback?: Value) => fallback as Value,
      set: () => {},
      get ready() {
        return true
      },
    },
    state: makeState(() => store()),
    theme: {
      current: themeCurrent,
      selected: "test",
      has: () => false,
      set: () => false,
      install: () => fail("theme.install"),
      mode: () => "dark",
      get ready() {
        return true
      },
    },
    event: {
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
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: () => () => {},
    },
    // Unused host giants below: identity stubs behind narrow casts. The
    // top-level shape stays checked by the TuiPluginApi annotation above.
    keymap: {} as TuiPluginApi["keymap"],
    renderer: {} as TuiPluginApi["renderer"],
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          requests.push(`get:${sessionID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`get:${sessionID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(sessionID)) {
            throw new Error("fake-tui-api: session.get failed");
          }
          return {
            data: makeSession(
              snapshot,
              sessionID,
              "server",
              findParentID(snapshot.children, sessionID),
            ),
          };
        },
        children: async ({ sessionID }: { sessionID: string }) => {
          requests.push(`children:${sessionID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`children:${sessionID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(sessionID)) {
            throw new Error("fake-tui-api: session.children failed");
          }
          const kids = snapshot.children?.get(sessionID) ?? [];
          return {
            data: kids.map((kid) =>
              makeSession(snapshot, kid, "server", findParentID(snapshot.children, kid)),
            ),
          };
        },
        messages: async ({ sessionID }: { sessionID: string }) => {
          requests.push(`messages:${sessionID}`);
          const snapshot = store();
          await snapshot.serverDelays?.get(`messages:${sessionID}`);
          if (snapshot.serverError || snapshot.serverFailures?.has(sessionID)) {
            throw new Error("fake-tui-api: session.messages failed");
          }
          const messages = snapshot.sessions.get(sessionID) ?? [];
          return {
            data: messages.map((info) => ({
              info,
              parts: [...(snapshot.parts.get(info.id) ?? [])],
            })),
          };
        },
      },
    } as unknown as TuiPluginApi["client"],
    tuiConfig: {} as TuiPluginApi["tuiConfig"],
    slots: {
      register: () => fail("slots.register"),
    },
    plugins: {
      list: () => [],
      activate: () => fail("plugins.activate"),
      deactivate: () => fail("plugins.deactivate"),
      add: () => fail("plugins.add"),
      install: () => fail("plugins.install"),
    },
  }

  return {
    api,
    setStore: (next) => setStore(next),
    emit: (type, properties) => {
      for (const handler of listeners.get(type) ?? []) handler({ type, properties } as never)
    },
    toasts,
    requests,
  }
}
