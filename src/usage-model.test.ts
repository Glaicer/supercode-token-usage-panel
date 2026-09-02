import { strict as assert } from "node:assert";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2";
import {
  USAGE_LABELS,
  USAGE_SECTION_TITLE,
  createUsageModel,
  formatTokens,
} from "./usage-model.ts";
import {
  loadHistoryFixtures,
  type SessionFixture,
} from "./test-fixtures.ts";
import { createFakeTuiApi, type FakeStore } from "./fake-tui-api.ts";

// Real local-history sessions frozen in src/fixtures/history.json.
const PAID = "ses_0dc2bb655ffeuhvaKtIFLQKpog"; // glm-5.2, cache-heavy
const EMPTY = "ses_fd3844d18ffeAB6W4jxWvqUPfx"; // user messages only

function withRoot(fn: () => void): void {
  createRoot((dispose) => {
    try {
      fn();
    } finally {
      dispose();
    }
  });
}

function withAsyncRoot(fn: () => Promise<void>): Promise<void> {
  return createRoot((dispose) => fn().finally(dispose));
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixtureStore(...sids: string[]): FakeStore {
  const fixtures = loadHistoryFixtures();
  const sessions = new Map<string, readonly import("@opencode-ai/sdk/v2").Message[]>();
  const parts = new Map<string, readonly import("@opencode-ai/sdk/v2").Part[]>();
  for (const sid of sids) {
    const fixture = fixtures.sessions.get(sid);
    if (!fixture) throw new Error(`missing fixture session ${sid}`);
    sessions.set(sid, fixture.messages);
    for (const [mid, messageParts] of fixture.parts) parts.set(mid, messageParts);
  }
  return { sessions, parts };
}

function rowValue(rows: readonly { label: string; value: string }[], label: string): string {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`no row labeled ${label}`);
  return row.value;
}

function assertLabels(rows: readonly unknown[]): void {
  assert.deepEqual(
    rows.map((r) => (r as { label: string }).label),
    [...USAGE_LABELS],
  );
}

function fakeAssistant(
  id: string,
  sessionID: string,
  overrides?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1_000, completed: 2_000 },
    parentID: "msg_parent",
    modelID: "model-a",
    providerID: "provider-a",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function fakeStepFinish(
  id: string,
  messageID: string,
  sessionID: string,
  tokens: StepFinishPart["tokens"],
): StepFinishPart {
  return { id, sessionID, messageID, type: "step-finish", reason: "stop", cost: 0, tokens };
}

test("section title and row labels are pinned", () => {
  assert.equal(USAGE_SECTION_TITLE, "Token Usage");
  assert.deepEqual([...USAGE_LABELS], [
    "Input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
    "Cache rate",
  ]);
});

test("real paid session: authoritative totals render exactly", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(PAID));
    const model = createUsageModel(fake.api, () => PAID);

    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rows.length, 6);
    assertLabels(rows);
    assert.equal(rowValue(rows, "Input"), "649,437");
    assert.equal(rowValue(rows, "Output"), "52,276");
    assert.equal(rowValue(rows, "Reasoning"), "40,717");
    assert.equal(rowValue(rows, "Cache read"), "2,202,512");
    assert.equal(rowValue(rows, "Cache write"), "0");
    assert.equal(rowValue(rows, "Cache rate"), "77.2%");
  });
});

test("real multi-message turn: every assistant message of the turn contributes", () => {
  withRoot(() => {
    // The paid fixture contains turns that produced several assistant
    // messages under one user parent; fold a store holding ONLY that turn and
    // check the totals equal exactly that turn's sum.
    const fixture = loadHistoryFixtures().sessions.get(PAID) as SessionFixture;
    const byParent = new Map<string, AssistantMessage[]>();
    for (const message of fixture.messages) {
      if (message.role !== "assistant") continue;
      const list = byParent.get(message.parentID) ?? [];
      list.push(message);
      byParent.set(message.parentID, list);
    }
    const multi = [...byParent.entries()].find(([, list]) => list.length > 1);
    assert.ok(multi, "fixture must contain a multi-assistant-message turn");
    const [parentID, turnMessages] = multi;

    const parts = new Map<string, readonly import("@opencode-ai/sdk/v2").Part[]>();
    for (const message of turnMessages) {
      const own = fixture.parts.get(message.id) ?? [];
      assert.ok(own.length > 0, `turn message ${message.id} must carry step-finishes`);
      parts.set(message.id, own);
    }
    const fake = createFakeTuiApi({
      sessions: new Map([[PAID, turnMessages]]),
      parts,
    });
    const model = createUsageModel(fake.api, () => PAID);
    assert.equal(model.status(), "ready");
    // Oracle folded from the PARTS, not from message-level token snapshots.
    const expectedInput = [...parts.values()].flat().reduce(
      (sum, p) => (p.type === "step-finish" ? sum + p.tokens.input : sum),
      0,
    );
    assert.ok(expectedInput > 0 && expectedInput < 649437, "turn must be a strict slice");
    assert.equal(rowValue(model.rows(), "Input"), formatTokens(expectedInput));
  });
});

test("empty session: no-data state, no fabricated rows", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(EMPTY));
    const model = createUsageModel(fake.api, () => EMPTY);
    assert.equal(model.status(), "empty");
    assert.deepEqual(model.rows(), []);
  });
});

test("initial aggregate failure: unavailable state, never zeros", async () => {
  await withAsyncRoot(async () => {
    const fake = createFakeTuiApi({ sessions: new Map(), parts: new Map() });
    const model = createUsageModel(fake.api, () => "ses_missing");

    assert.equal(model.status(), "loading");
    await nextTask();
    assert.equal(model.status(), "unavailable");
    assert.deepEqual(model.rows(), []);
  });
});

test("authoritative aggregate is not capped by the TUI message window", () => {
  withRoot(() => {
    const sid = "ses_long";
    const message = fakeAssistant("msg_recent", sid);
    const recent = fakeStepFinish(
      "prt_recent",
      message.id,
      sid,
      { input: 10, output: 2, reasoning: 1, cache: { read: 20, write: 0 } },
    );
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [message]]]),
      parts: new Map([[message.id, [recent]]]),
      stateUsage: new Map([
        [
          sid,
          {
            tokens: { input: 1_000, output: 200, reasoning: 100, cache: { read: 5_000, write: 50 } },
          },
        ],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);

    assert.equal(rowValue(model.rows(), "Input"), "1,000");
    assert.equal(rowValue(model.rows(), "Cache read"), "5,000");
  });
});

test("usage event refreshes a stale TUI aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_live";
    const message = fakeAssistant("msg_live", sid);
    const first = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 200, write: 0 } },
    };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      parts: new Map<string, readonly import("@opencode-ai/sdk/v2").Part[]>([[message.id, []]]),
      stateUsage: new Map([[sid, first]]),
      serverUsage: new Map([[sid, first]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "100");

    const latest = {
      tokens: { input: 150, output: 15, reasoning: 5, cache: { read: 300, write: 0 } },
    };
    fake.setStore({ ...initial, serverUsage: new Map([[sid, latest]]) });
    fake.emit("message.part.updated", {
      part: fakeStepFinish("prt_live", message.id, sid, latest.tokens),
    });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "150");
    assert.equal(rowValue(model.rows(), "Reasoning"), "5");
  });
});

test("failed refresh preserves the last confirmed aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_refresh_failure";
    const message = fakeAssistant("msg_refresh_failure", sid);
    const stale = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 200, write: 0 } },
    };
    const confirmed = {
      tokens: { input: 150, output: 15, reasoning: 5, cache: { read: 300, write: 0 } },
    };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      parts: new Map<string, readonly import("@opencode-ai/sdk/v2").Part[]>([[message.id, []]]),
      stateUsage: new Map([[sid, stale]]),
      serverUsage: new Map([[sid, confirmed]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "150");

    fake.setStore({ ...initial, serverError: true });
    fake.emit("message.part.updated", {
      part: fakeStepFinish("prt_failed_refresh", message.id, sid, confirmed.tokens),
    });
    await nextTask();

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "150");
  });
});

test("multi-step-finish message: steps sum, the message.tokens snapshot is ignored", () => {
  withRoot(() => {
    // Two REAL step-finish payloads from two different real messages, placed
    // under one message id: the persisted runtime prunes intermediate
    // step-finishes, so history cannot provide this shape frozen — but the
    // API contract allows it, and folding over parts (not over the
    // message-level snapshot) is exactly what ticket 01 demands.
    const fixture = loadHistoryFixtures().sessions.get(PAID) as SessionFixture;
    const realParts: StepFinishPart[] = [];
    for (const parts of fixture.parts.values()) {
      const part = parts.find((p): p is StepFinishPart => p.type === "step-finish");
      if (part) realParts.push(part);
      if (realParts.length === 2) break;
    }
    assert.equal(realParts.length, 2);
    const [first, last] = realParts;
    assert.notEqual(first.tokens.input, last.tokens.input, "picked parts must differ");

    const sid = "ses_synthetic_multi";
    const messageID = "msg_multi";
    const message = fakeAssistant(messageID, sid, {
      // Snapshot lie: message-level field carries only the LAST step, which
      // the fold must ignore in favour of summing the parts.
      tokens: structuredClone(last.tokens),
    });
    const steps = [first, last].map((part, i) =>
      fakeStepFinish(`prt_step_${i}`, messageID, sid, structuredClone(part.tokens)),
    );

    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [message]]]),
      parts: new Map([[messageID, steps]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), formatTokens(first.tokens.input + last.tokens.input));
    assert.notEqual(rowValue(rows, "Input"), last.tokens.input.toLocaleString("en-US"));
  });
});

test("cache rate: zero denominator renders a dash even when output exists", () => {
  withRoot(() => {
    const sid = "ses_synthetic_nocache";
    const messageID = "msg_nocache";
    const message = fakeAssistant(messageID, sid, {
      tokens: { input: 0, output: 500, reasoning: 100, cache: { read: 0, write: 0 } },
    });
    const part = fakeStepFinish("prt_nc", messageID, sid, message.tokens);
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [message]]]),
      parts: new Map([[messageID, [part]]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Cache rate"), "–");
    assert.equal(rowValue(rows, "Output"), "500");
    assert.equal(rowValue(rows, "Reasoning"), "100");
  });
});

test("contributions from different provider/model pairs combine into totals", () => {
  withRoot(() => {
    const sid = "ses_synthetic_models";
    const a = fakeAssistant("msg_a", sid);
    const b = fakeAssistant("msg_b", sid, { providerID: "provider-b", modelID: "model-b" });
    const partA = fakeStepFinish("prt_a", "msg_a", sid, { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 40 } });
    const partB = fakeStepFinish("prt_b", "msg_b", sid, { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 60 } });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [a, b]]]),
      parts: new Map([
        ["msg_a", [partA]],
        ["msg_b", [partB]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "150");
    assert.equal(rowValue(rows, "Output"), "30");
    assert.equal(rowValue(rows, "Reasoning"), "5");
    assert.equal(rowValue(rows, "Cache read"), "200");
    assert.equal(rowValue(rows, "Cache write"), "100");
    assert.equal(rowValue(rows, "Cache rate"), "44.4%"); // 200 / (150+200+100) = 44.4
  });
});

test("frozen fixtures: aggregate matches the annotation frozen with them", () => {
  const fixtures = loadHistoryFixtures();
  for (const [sid, expected] of Object.entries(fixtures.expected)) {
    withRoot(() => {
      const fake = createFakeTuiApi(fixtureStore(sid));
      const model = createUsageModel(fake.api, () => sid);
      if (expected.denominator === 0) {
        assert.equal(model.status(), "empty");
        return;
      }
      assert.equal(model.status(), "ready");
      const rows = model.rows();
      assert.equal(rowValue(rows, "Input"), formatTokens(expected.input));
      assert.equal(rowValue(rows, "Output"), formatTokens(expected.output));
      assert.equal(rowValue(rows, "Reasoning"), formatTokens(expected.reasoning));
      assert.equal(rowValue(rows, "Cache read"), formatTokens(expected.cacheRead));
      assert.equal(rowValue(rows, "Cache write"), formatTokens(expected.cacheWrite));
      const rate = ((expected.cacheRead / expected.denominator) * 100).toFixed(1);
      assert.equal(rowValue(rows, "Cache rate"), `${rate}%`);
    });
  }
});

test("session switch: previous session's numbers do not leak", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(PAID, EMPTY));
    const [sessionId, setSessionId] = createSignal(PAID);
    const model = createUsageModel(fake.api, sessionId);

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "649,437");

    setSessionId(EMPTY);
    assert.equal(model.status(), "empty");
    assert.deepEqual(model.rows(), []);

    setSessionId(PAID);
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "649,437");
  });
});

test("subagent children: descendant usage merges into the root totals", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_family";
    const child = "ses_family_child";
    const message = fakeAssistant("msg_family", sid, {
      tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 0 } },
    });
    const fake = createFakeTuiApi({
      sessions: new Map([
        [sid, [message]],
        [child, [fakeAssistant("msg_family_child", child)]],
      ]),
      parts: new Map([
        ["msg_family", [fakeStepFinish("prt_family", "msg_family", sid, message.tokens)]],
        [
          "msg_family_child",
          [
            fakeStepFinish(
              "prt_family_child",
              "msg_family_child",
              child,
              { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 60 } },
            ),
          ],
        ],
      ]),
      children: new Map([[sid, [child]]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "150");
    assert.equal(rowValue(rows, "Output"), "30");
    assert.equal(rowValue(rows, "Reasoning"), "5");
    assert.equal(rowValue(rows, "Cache read"), "200");
    assert.equal(rowValue(rows, "Cache write"), "60");
    assert.ok(model.includesSubagents(), "indicator must be on when a child exists");
  });
});

test("nested subagents: grandchildren contribute through recursion", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_nested";
    const child = "ses_nested_child";
    const grandchild = "ses_nested_grandchild";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [
          sid,
          {
            tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
        [
          child,
          {
            tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
        [
          grandchild,
          {
            tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 0, write: 0 } },
          },
        ],
      ]),
      children: new Map([
        [sid, [child]],
        [child, [grandchild]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "137"); // 100 + 30 + 7
    assert.equal(rowValue(rows, "Output"), "18"); // 10 + 5 + 3
    assert.equal(rowValue(rows, "Reasoning"), "2");
    assert.ok(model.includesSubagents());
  });
});

test("duplicate listing and cycles: each session counts once", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_cycle";
    const child = "ses_cycle_child";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [
          sid,
          {
            tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
        [
          child,
          {
            tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
      ]),
      children: new Map([
        // child listed twice by the root, and the child "reports" the root
        // back — the walk must neither double-count nor loop forever.
        [sid, [child, child]],
        [child, [sid]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "140"); // 100 + 40, counted once
    assert.equal(rowValue(rows, "Output"), "14");
    assert.ok(model.includesSubagents());
  });
});

test("live subagent: creation and usage events extend the totals", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_live_family";
    const message = fakeAssistant("msg_lf", sid);
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 200, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      parts: new Map<string, readonly import("@opencode-ai/sdk/v2").Part[]>([[message.id, []]]),
      stateUsage: new Map([[sid, rootUsage]]),
      children: new Map<string, readonly string[]>(),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "100");
    assert.equal(model.includesSubagents(), false);

    const child = "ses_live_family_child";
    fake.setStore({
      ...initial,
      children: new Map([[sid, [child]]]),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, childUsage],
      ]),
    });
    fake.emit("session.created", { sessionID: child, info: undefined });
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "150");
    assert.ok(model.includesSubagents());
  });
});

test("deleted child: totals drop back to the root session", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_shrink";
    const child = "ses_shrink_child";
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
    };
    const withChild = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, childUsage],
      ]),
      children: new Map([[sid, [child]]]),
    };
    const fake = createFakeTuiApi(withChild);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());

    fake.setStore({
      ...withChild,
      children: new Map<string, readonly string[]>(),
      stateUsage: new Map([[sid, rootUsage]]),
    });
    fake.emit("session.deleted", { sessionID: child, info: undefined });
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "100");
    assert.equal(rowValue(model.rows(), "Reasoning"), "0");
    assert.equal(model.includesSubagents(), false);
  });
});

test("partial family fetch failure: never a partial sum", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_partial_fail";
    const child = "ses_partial_fail_child";
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const withChild = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, childUsage],
      ]),
      children: new Map([[sid, [child]]]),
    };
    const fake = createFakeTuiApi(withChild);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");

    // The child's usage grows, but its children lookup now fails: the walk
    // must reject the whole snapshot instead of showing root + stale child.
    const grownChild = {
      tokens: { input: 90, output: 9, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    fake.setStore({
      ...withChild,
      stateUsage: new Map([
        [sid, rootUsage],
        [child, grownChild],
      ]),
      children: new Map([[sid, [child]], [child, []]]),
      serverFailures: new Set([child]),
    });
    fake.emit("message.part.updated", {
      part: fakeStepFinish("prt_pf", "msg_pf", child, grownChild.tokens),
    });
    await nextTask();

    // The whole walk failed, so the last confirmed family totals stand —
    // not the root-only slice (100) and not root + stale grown child (190).
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "140");
  });
});

test("root session switch: family resets, no leakage across roots", async () => {
  await withAsyncRoot(async () => {
    const rootA = "ses_root_a";
    const childA = "ses_root_a_child";
    const rootB = "ses_root_b";
    const usageA = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const usageChildA = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const usageB = {
      tokens: { input: 700, output: 70, reasoning: 7, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [rootA, usageA],
        [childA, usageChildA],
        [rootB, usageB],
      ]),
      children: new Map([[rootA, [childA]]]),
    });
    const [sessionId, setSessionId] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionId);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());

    setSessionId(rootB);
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "700");
    assert.equal(model.includesSubagents(), false);

    // And back — the family walk re-runs, child included again.
    setSessionId(rootA);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());
  });
});
