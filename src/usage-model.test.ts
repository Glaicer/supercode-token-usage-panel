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
const PAID = "ses_0dc2bb655ffeuhvaKtIFLQKpog"; // glm-5.2, $1.89, cache-heavy
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
  cost: number,
): StepFinishPart {
  return { id, sessionID, messageID, type: "step-finish", reason: "stop", cost, tokens };
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
    "Cost",
  ]);
});

test("real paid session: totals are the fold of all step-finish parts", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(PAID));
    const model = createUsageModel(fake.api, () => PAID);

    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rows.length, 7);
    assertLabels(rows);
    assert.equal(rowValue(rows, "Input"), "649,437");
    assert.equal(rowValue(rows, "Output"), "52,276");
    assert.equal(rowValue(rows, "Reasoning"), "40,717");
    assert.equal(rowValue(rows, "Cache read"), "2,202,512");
    assert.equal(rowValue(rows, "Cache write"), "0");
    assert.equal(rowValue(rows, "Cache rate"), "77.2%");
    assert.equal(rowValue(rows, "Cost"), "$1.89");
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

test("initial fold failure: unavailable state, never zeros", () => {
  withRoot(() => {
    const fake = createFakeTuiApi({ sessions: new Map(), parts: new Map() });
    const model = createUsageModel(fake.api, () => "ses_missing");
    assert.equal(model.status(), "unavailable");
    assert.deepEqual(model.rows(), []);
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
      cost: last.cost,
    });
    const steps = [first, last].map((part, i) =>
      fakeStepFinish(`prt_step_${i}`, messageID, sid, structuredClone(part.tokens), part.cost),
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
    assert.equal(
      rowValue(rows, "Cost"),
      `$${(first.cost + last.cost).toFixed(2)}`,
    );
  });
});

test("cache rate: zero denominator renders a dash even when output exists", () => {
  withRoot(() => {
    const sid = "ses_synthetic_nocache";
    const messageID = "msg_nocache";
    const message = fakeAssistant(messageID, sid, {
      cost: 0.01,
      tokens: { input: 0, output: 500, reasoning: 100, cache: { read: 0, write: 0 } },
    });
    const part = fakeStepFinish("prt_nc", messageID, sid, message.tokens, 0.01);
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
    assert.equal(rowValue(rows, "Cost"), "$0.01");
  });
});

test("contributions from different provider/model pairs combine into totals", () => {
  withRoot(() => {
    const sid = "ses_synthetic_models";
    const a = fakeAssistant("msg_a", sid);
    const b = fakeAssistant("msg_b", sid, { providerID: "provider-b", modelID: "model-b" });
    const partA = fakeStepFinish("prt_a", "msg_a", sid, { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 40 } }, 0.001);
    const partB = fakeStepFinish("prt_b", "msg_b", sid, { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 60 } }, 0.002);
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
    assert.equal(rowValue(rows, "Cost"), "$0.00"); // rounds up display-wise from 0.003
  });
});

test("frozen fixtures: fold matches the annotation frozen with them", () => {
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
      assert.equal(rowValue(rows, "Cost"), `$${expected.cost.toFixed(2)}`);
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
