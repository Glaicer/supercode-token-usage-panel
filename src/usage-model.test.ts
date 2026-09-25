import { strict as assert } from "node:assert";
import test from "node:test";
import { createEffect, createMemo, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import type { SessionMessageAssistant, SessionMessageInfo, TokenUsageInfo } from "@opencode/client";
import {
  USAGE_LABELS,
  USAGE_SECTION_TITLE,
  USAGE_SECTION_TITLE_WITH_SUBAGENTS,
  createUsageModel,
  formatTokens,
  type SolidRuntime,
} from "./usage-model.ts";
import {
  loadHistoryFixtures,
  type SessionFixture,
} from "./test-fixtures.ts";
import { createFakeTuiApi, type FakeStore } from "./fake-tui-api.ts";

const PAID = "ses_0dc2bb655ffeuhvaKtIFLQKpog";
const EMPTY = "ses_fd3844d18ffeAB6W4jxWvqUPfx";

// Same-process solid-js copy stands in for the host runtime (see SolidRuntime).
const solid: SolidRuntime = { createSignal, createMemo, createEffect, onCleanup, untrack };

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
  const sessions = new Map<string, readonly SessionMessageInfo[]>();
  for (const sid of sids) {
    const fixture = fixtures.sessions.get(sid);
    if (!fixture) throw new Error(`missing fixture session ${sid}`);
    sessions.set(sid, fixture.messages);
  }
  return { sessions };
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

function tokens(
  input: number,
  output: number,
  reasoning: number,
  cacheRead = 0,
  cacheWrite = 0,
): TokenUsageInfo {
  return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } };
}

function fakeAssistant(
  id: string,
  overrides?: Partial<SessionMessageAssistant>,
): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    time: { created: 1_000, streamed: 1_100, completed: 2_000 },
    agent: "build",
    model: { providerID: "provider-a", id: "model-a" },
    content: [],
    cost: 0,
    tokens: tokens(0, 0, 0),
    ...overrides,
  };
}

/** An in-flight step: no streamed/completed time and no tokens yet. */
function fakeLiveAssistant(
  id: string,
  created: number,
  overrides?: Partial<SessionMessageAssistant>,
): SessionMessageAssistant {
  return {
    ...fakeAssistant(id, { time: { created }, ...overrides }),
    tokens: undefined,
  };
}

function fakeUser(id: string, created: number): SessionMessageInfo {
  return { id, type: "user", time: { created }, text: "" };
}

function fakeText(text: string): SessionMessageAssistant["content"][number] {
  return { type: "text", text };
}

function fakeReasoning(text: string, created: number, completed: number): SessionMessageAssistant["content"][number] {
  return { type: "reasoning", text, time: { created, completed } };
}

function fakeCompletedTool(created: number, ran: number, completed: number): SessionMessageAssistant["content"][number] {
  return {
    type: "tool",
    id: `tool_${created}`,
    name: "test",
    state: { status: "completed", input: {}, content: [{ type: "text", text: "" }] },
    time: { created, ran, completed },
  };
}

/** Consecutive assistant messages between non-assistant messages form a turn. */
function turnRuns(messages: readonly SessionMessageInfo[]): SessionMessageAssistant[][] {
  const runs: SessionMessageAssistant[][] = [];
  let current: SessionMessageAssistant[] = [];
  for (const message of messages) {
    if (message.type === "assistant") {
      current.push(message);
      continue;
    }
    if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

test("completed generation speed is weighted and excludes TTFT and tool time", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_speed";
    const first = fakeAssistant("msg_speed_1", {
      time: { created: 1_000, streamed: 4_000, completed: 5_000 },
      content: [fakeReasoning("first", 2_000, 3_000), fakeCompletedTool(3_000, 3_000, 5_000)],
      tokens: tokens(0, 80, 20),
    });
    const second = fakeAssistant("msg_speed_2", {
      time: { created: 10_000, streamed: 15_000, completed: 15_001 },
      content: [fakeReasoning("second", 11_000, 15_000)],
      tokens: tokens(0, 150, 50),
    });
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [first, second]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    // 300 generated tokens / (2 + 4) seconds = 50 tps.
    assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
  });
});

test("overlapping tool calls cannot inflate completed generation speed", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_parallel_speed";
    const message = fakeAssistant("msg_parallel_speed", {
      time: { created: 1_000, streamed: 4_000, completed: 6_001 },
      content: [
        fakeReasoning("done", 2_000, 4_000),
        fakeCompletedTool(4_000, 4_000, 6_000),
        fakeCompletedTool(4_001, 4_001, 6_001),
      ],
      tokens: tokens(0, 80, 20),
    });
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [message]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
  });
});

test("stream end is not first token, including interrupted and tool-only steps", async () => {
  for (const finish of ["stop", "error", "tool-calls"] as const) {
    await withAsyncRoot(async () => {
      const sid = "ses_stream_end";
      const message = fakeAssistant("msg_stream_end", {
        finish,
        time: { created: 1_000, streamed: 4_000, completed: 4_001 },
        content: finish === "tool-calls"
          ? [fakeCompletedTool(2_000, 3_000, 4_000)]
          : [fakeReasoning("thinking", 2_000, 3_000), fakeText("done")],
        tokens: tokens(0, 80, 20),
      });
      const fake = createFakeTuiApi({ sessions: new Map([[sid, [message]]]) });
      const model = createUsageModel(fake.api, () => sid, solid);
      await nextTask();

      assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
      assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
    });
  }
});

test("text-first history without first-output timing does not fabricate diagnostics", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_no_first_output";
    const message = fakeAssistant("msg_no_first_output", {
      time: { created: 1_000, streamed: 4_000, completed: 4_001 },
      content: [fakeText("answer"), fakeReasoning("later", 3_000, 4_000)],
      tokens: tokens(0, 80, 20),
    });
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [message]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    assert.equal(rowValue(model.rows(), "Generation speed"), "–");
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
    assert.equal(rowValue(model.rows(), "Output"), "80");
    assert.equal(rowValue(model.rows(), "Steps"), "1");
  });
});

test("live first-output events time text-first steps through completion and refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_first_output";
    const live = fakeLiveAssistant("msg_first_output", 1_000);
    const usage = new Map([[sid, { tokens: tokens(0, 80, 20) }]]);
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [live]]]), stateUsage: usage });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    t.mock.timers.tick(1_000);
    fake.emit("session.text.started", { sessionID: sid, assistantMessageID: live.id, ordinal: 0 });
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
    t.mock.timers.tick(1_000);
    fake.emit("session.reasoning.started", { sessionID: sid, assistantMessageID: live.id, ordinal: 0 });
    t.mock.timers.tick(1_000);
    fake.emit("session.step.streamed", { sessionID: sid, assistantMessageID: live.id });
    const completed = fakeAssistant(live.id, {
      time: { created: 1_000, streamed: 4_000, completed: 60_000 },
      content: [fakeText("answer"), fakeCompletedTool(3_000, 4_000, 60_000)],
      tokens: tokens(0, 80, 20),
    });
    fake.setStore({ sessions: new Map([[sid, [completed]]]), stateUsage: usage });
    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: live.id });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
    fake.emit("server.connected", {});
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
  });
});

test("live diagnostics tick from Unicode deltas using a snapshotted model calibration", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 20_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_live_speed";
    const completed = fakeAssistant("msg_calibration", {
      time: { created: 1_000, streamed: 3_000, completed: 3_001 },
      content: [fakeReasoning("x".repeat(600), 2_000, 3_000)],
      tokens: tokens(0, 80, 20),
    });
    const turnStart = fakeUser("msg_live_parent", 18_000);
    const live = fakeLiveAssistant("msg_streaming", 18_500);
    const initial = {
      sessions: new Map([[sid, [completed, turnStart, live]]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    fake.emit("session.step.started", { sessionID: sid, assistantMessageID: live.id, started: 18_500 });
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.5s");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Time to first token"), ">2.5s");

    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "🙂".repeat(10),
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");

    t.mock.timers.tick(1_000);
    // Calibration: (400 + 600 chars) / (100 + 100 tokens) = 5 chars/token.
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");

    const recalibrated = fakeAssistant("msg_calibration", {
      time: { created: 1_000, streamed: 3_000, completed: 3_001 },
      content: [fakeReasoning("x".repeat(1_600), 2_000, 3_000)],
      tokens: tokens(0, 80, 20),
    });
    fake.setStore({ sessions: new Map([[sid, [recalibrated, turnStart, live]]]) });
    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: completed.id });
    await nextTask();
    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "🙂".repeat(10),
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");

    fake.emit("session.text.ended", { sessionID: sid, assistantMessageID: live.id, ordinal: 0 });
    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("live calibration is weighted per model and excludes tool steps", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 30_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_calibration_groups";
    const modelA = fakeAssistant("msg_model_a", {
      time: { created: 1_000, streamed: 2_000, completed: 3_000 },
      content: [fakeText("a".repeat(100))],
      tokens: tokens(0, 100, 0),
    });
    const modelBStep = fakeAssistant("msg_model_b_step", {
      model: { providerID: "provider-b", id: "model-b" },
      time: { created: 4_000, streamed: 5_000, completed: 6_000 },
      content: [fakeText("b".repeat(1_400))],
      tokens: tokens(0, 100, 0),
    });
    const modelBToolStep = fakeAssistant("msg_model_b_tool_step", {
      model: { providerID: "provider-b", id: "model-b" },
      time: { created: 6_100, streamed: 6_200, completed: 8_000 },
      content: [fakeText("z".repeat(10_000)), fakeCompletedTool(7_000, 7_000, 7_500)],
      tokens: tokens(0, 1_000, 0),
    });
    const live = fakeLiveAssistant("msg_model_b_live", 29_000, {
      model: { providerID: "provider-b", id: "model-b" },
    });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [modelA, modelBStep, modelBToolStep, live]]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "x".repeat(100),
    });
    t.mock.timers.tick(1_000);

    // Only model B's tool-free step: (400 + 1400) / (100 + 100) = 9 chars/token.
    assert.equal(rowValue(model.rows(), "Live speed"), "~11 tps");
  });
});

test("empty and unavailable states keep their status while showing live TTFT", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 40_000 });

  await withAsyncRoot(async () => {
    const sid = "ses_empty_live";
    const live = fakeLiveAssistant("msg_empty_live", 39_000);
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [live]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "empty");

    fake.emit("session.step.started", { sessionID: sid, assistantMessageID: live.id, started: 39_000 });
    assert.equal(model.status(), "empty");
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.0s");

    fake.emit("session.revert.committed", { sessionID: sid, to: live.id });
    assert.equal(model.status(), "empty");
    assert.deepEqual(model.rows(), []);
  });

  await withAsyncRoot(async () => {
    const sid = "ses_unavailable_live";
    const fake = createFakeTuiApi({ sessions: new Map() });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "unavailable");

    fake.emit("session.step.started", {
      sessionID: sid,
      assistantMessageID: "msg_unavailable_live",
      started: 39_500,
    });
    assert.equal(model.status(), "unavailable");
    assert.equal(rowValue(model.rows(), "Time to first token"), ">0.5s");
  });
});

test("live speed ignores descendants and resets on session switch and reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 50_000 });
  await withAsyncRoot(async () => {
    const rootA = "ses_live_root_a";
    const child = "ses_live_child";
    const rootB = "ses_live_root_b";
    const rootMessage = fakeLiveAssistant("msg_live_root", 49_000);
    const childMessage = fakeLiveAssistant("msg_live_child", 49_000);
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([
        [rootA, [rootMessage]],
        [child, [childMessage]],
        [rootB, []],
      ]),
      stateUsage: new Map([[rootA, usage], [child, usage], [rootB, usage]]),
      children: new Map([[rootA, [child]]]),
    });
    const [sessionID, setSessionID] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionID, solid);
    await nextTask();

    fake.emit("session.text.delta", {
      sessionID: child,
      assistantMessageID: childMessage.id,
      ordinal: 0,
      delta: "child",
    });
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("session.text.delta", {
      sessionID: rootA,
      assistantMessageID: rootMessage.id,
      ordinal: 0,
      delta: "root",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "–");

    setSessionID(rootB);
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    setSessionID(rootA);
    fake.emit("session.text.delta", {
      sessionID: rootA,
      assistantMessageID: rootMessage.id,
      ordinal: 0,
      delta: "again",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
    fake.emit("server.connected", {});
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");
  });
});

test("live TTFT is shown only for the first assistant step of a turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 60_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_live_ttft_steps";
    const first = fakeLiveAssistant("msg_live_ttft_first", 59_000);
    const second = fakeLiveAssistant("msg_live_ttft_second", 60_000);
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [first, second]]]),
      stateUsage: new Map([[sid, usage]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    fake.emit("session.step.started", { sessionID: sid, assistantMessageID: first.id, started: 59_000 });
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.0s");
    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: first.id });
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");

    fake.emit("session.step.started", { sessionID: sid, assistantMessageID: second.id, started: 60_000 });
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
  });
});

test("switching into a session mid-turn does not restart live TTFT", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 65_000 });
  await withAsyncRoot(async () => {
    const rootA = "ses_ttft_switch_a";
    const rootB = "ses_ttft_switch_b";
    // The finished step carries no visible output, so it keeps no TTFT sample.
    const first = fakeAssistant("msg_ttft_switch_first", {
      time: { created: 60_000, completed: 62_000 },
      tokens: tokens(0, 1, 0),
    });
    const later = fakeLiveAssistant("msg_ttft_switch_later", 64_000);
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([[rootA, []], [rootB, [first, later]]]),
      stateUsage: new Map([[rootA, usage], [rootB, usage]]),
    });
    const [sessionID, setSessionID] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionID, solid);
    await nextTask();

    setSessionID(rootB);
    fake.emit("session.step.started", { sessionID: rootB, assistantMessageID: later.id, started: 64_000 });
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
  });
});

test("invalid steps are skipped and stream gaps stay in the decode denominator", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_speed_boundaries";
    const valid = fakeAssistant("msg_speed_valid", {
      time: { created: 1_000, streamed: 5_000, completed: 5_001 },
      content: [fakeReasoning("reasoning", 2_000, 2_500), fakeText("text")],
      tokens: tokens(0, 50, 50),
    });
    const unfinished = fakeAssistant("msg_speed_unfinished", {
      time: { created: 10_000, completed: 12_000 },
      content: [fakeText("open")],
      tokens: tokens(0, 100, 0),
    });
    const zeroTokens = fakeAssistant("msg_speed_zero_tokens", {
      time: { created: 20_000, streamed: 21_000, completed: 22_000 },
      content: [fakeReasoning("done", 21_000, 21_000)],
      tokens: tokens(0, 0, 0),
    });
    const zeroDecode = fakeAssistant("msg_speed_zero_decode", {
      time: { created: 30_000, streamed: 31_000, completed: 32_000 },
      content: [fakeReasoning("done", 31_000, 31_000), fakeCompletedTool(31_000, 31_000, 32_000)],
      tokens: tokens(0, 100, 0),
    });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [valid, unfinished, zeroTokens, zeroDecode]]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    // The 1.5s reasoning-to-text gap stays in the 3s decode denominator.
    assert.equal(rowValue(model.rows(), "Generation speed"), "33 tps");
    // Zero-token and zero-decode steps still have valid completed TTFT samples.
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
  });
});

test("short streams never show a number and a later visible part starts a new measurement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 70_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_short_stream";
    const live = fakeLiveAssistant("msg_short_stream", 69_000);
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [live]]]),
      stateUsage: new Map([[sid, usage]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "short",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
    fake.emit("session.text.ended", { sessionID: sid, assistantMessageID: live.id, ordinal: 0 });
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 1,
      delta: "12345678",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
  });
});

test("a pre-existing TTFT timer cannot publish live speed before its own first second", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 80_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_timer_alignment";
    const live = fakeLiveAssistant("msg_timer_alignment", 79_000);
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [live]]]),
      stateUsage: new Map([[sid, usage]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();

    fake.emit("session.step.started", { sessionID: sid, assistantMessageID: live.id, started: 79_000 });
    t.mock.timers.tick(900);
    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "12345678",
    });
    t.mock.timers.tick(100);
    assert.equal(rowValue(model.rows(), "Live speed"), "–");

    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
  });
});

test("completed step update refreshes metrics after a settling race", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_completion_race";
    const live = fakeLiveAssistant("msg_completion_race", 1_000, { content: [fakeText("done")] });
    const initial = {
      sessions: new Map([[sid, [live]]]),
      stateUsage: new Map([[sid, { tokens: tokens(10, 100, 0) }]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: live.id });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    const completed = fakeAssistant("msg_completion_race", {
      time: { created: 1_000, streamed: 3_000, completed: 3_001 },
      content: [fakeReasoning("done", 2_000, 3_000)],
      tokens: tokens(0, 100, 0),
    });
    fake.setStore({ sessions: new Map([[sid, [completed]]]), stateUsage: initial.stateUsage });
    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: live.id });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("completed descendant step update refreshes family diagnostics", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_descendant_completion_root";
    const child = "ses_descendant_completion_child";
    const live = fakeLiveAssistant("msg_descendant_completion", 1_000, { content: [fakeText("done")] });
    const usage = { tokens: tokens(10, 100, 0) };
    const initial = {
      sessions: new Map([[child, [live]]]),
      stateUsage: new Map([[root, usage], [child, usage]]),
      children: new Map([[root, [child]]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    const completed = fakeAssistant("msg_descendant_completion", {
      time: { created: 1_000, streamed: 3_000, completed: 3_001 },
      content: [fakeReasoning("done", 2_000, 3_000)],
      tokens: tokens(0, 100, 0),
    });
    fake.setStore({ ...initial, sessions: new Map([[child, [completed]]]) });
    fake.emit("session.step.ended", { sessionID: child, assistantMessageID: live.id });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("positive speeds that round to zero render as unavailable", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 90_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_rounds_to_zero";
    const completed = fakeAssistant("msg_rounds_to_zero", {
      time: { created: 1_000, streamed: 4_500, completed: 4_501 },
      content: [fakeReasoning("done", 2_000, 4_500)],
      tokens: tokens(0, 1, 0),
    });
    const live = fakeLiveAssistant("msg_live_rounds_to_zero", 89_000);
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [completed, live]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("session.text.delta", {
      sessionID: sid,
      assistantMessageID: live.id,
      ordinal: 0,
      delta: "x",
    });
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
  });
});

test("section title and row labels are pinned", () => {
  assert.equal(USAGE_SECTION_TITLE, "Token Usage");
  assert.equal(USAGE_SECTION_TITLE_WITH_SUBAGENTS, "Token Usage (including subagents)");
  assert.deepEqual([...USAGE_LABELS], [
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
  ]);
});

test("real paid session: authoritative totals render exactly", async () => {
  await withAsyncRoot(async () => {
    const fake = createFakeTuiApi(fixtureStore(PAID));
    const model = createUsageModel(fake.api, () => PAID, solid);

    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rows.length, 10);
    assertLabels(rows);
    assert.equal(rowValue(rows, "Input"), "649,437");
    assert.equal(rowValue(rows, "Output"), "52,276");
    assert.equal(rowValue(rows, "Reasoning"), "40,717");
    assert.equal(rowValue(rows, "Cache read"), "2,202,512");
    assert.equal(rowValue(rows, "Cache write"), "0");
    assert.equal(rowValue(rows, "Cache rate"), "77.2%");
    // One finished assistant message per step in the frozen history.
    assert.equal(rowValue(rows, "Steps"), "42");
  });
});

test("real multi-step turn: every assistant message of the turn contributes", () => {
  withRoot(() => {
    const fixture = loadHistoryFixtures().sessions.get(PAID) as SessionFixture;
    const turn = turnRuns(fixture.messages).find((run) => run.length > 1);
    assert.ok(turn, "fixture must contain a multi-assistant-message turn");

    const fake = createFakeTuiApi({ sessions: new Map([[PAID, turn]]) });
    const model = createUsageModel(fake.api, () => PAID, solid);
    assert.equal(model.status(), "ready");
    const expectedInput = turn.reduce(
      (sum, message) => sum + (message.tokens?.input ?? 0),
      0,
    );
    assert.ok(expectedInput > 0 && expectedInput < 649437, "turn must be a strict slice");
    assert.equal(rowValue(model.rows(), "Input"), formatTokens(expectedInput));
  });
});

test("empty session: no-data state, no fabricated rows", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(EMPTY));
    const model = createUsageModel(fake.api, () => EMPTY, solid);
    assert.equal(model.status(), "empty");
    assert.deepEqual(model.rows(), []);
  });
});

test("initial aggregate failure: unavailable state, never zeros", async () => {
  await withAsyncRoot(async () => {
    const fake = createFakeTuiApi({ sessions: new Map() });
    const model = createUsageModel(fake.api, () => "ses_missing", solid);

    assert.equal(model.status(), "loading");
    await nextTask();
    assert.equal(model.status(), "unavailable");
    assert.deepEqual(model.rows(), []);
  });
});

test("initial family failure does not fall back to an incomplete local aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_local_only";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([[sid, { tokens: tokens(100, 10, 0) }]]),
      serverError: true,
    });
    const model = createUsageModel(fake.api, () => sid, solid);

    await nextTask();
    assert.equal(model.status(), "unavailable");
    assert.deepEqual(model.rows(), []);
  });
});

test("authoritative aggregate is not capped by the TUI message window", () => {
  withRoot(() => {
    const sid = "ses_long";
    const message = fakeAssistant("msg_recent", { tokens: tokens(10, 2, 1, 20, 0) });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [message]]]),
      stateUsage: new Map([
        [sid, { tokens: tokens(1_000, 200, 100, 5_000, 50) }],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);

    assert.equal(rowValue(model.rows(), "Input"), "1,000");
    assert.equal(rowValue(model.rows(), "Cache read"), "5,000");
  });
});

test("usage event refreshes a stale TUI aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_live";
    const message = fakeAssistant("msg_live");
    const first = { tokens: tokens(100, 10, 0, 200, 0) };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      stateUsage: new Map([[sid, first]]),
      serverUsage: new Map([[sid, first]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "100");

    const latest = { tokens: tokens(150, 15, 5, 300, 0) };
    fake.setStore({ ...initial, serverUsage: new Map([[sid, latest]]) });
    fake.emit("session.usage.updated", { sessionID: sid, cost: 0, tokens: latest.tokens });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "150");
    assert.equal(rowValue(model.rows(), "Reasoning"), "5");
  });
});

test("failed refresh preserves the last confirmed aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_refresh_failure";
    const message = fakeAssistant("msg_refresh_failure");
    const stale = { tokens: tokens(100, 10, 0, 200, 0) };
    const confirmed = { tokens: tokens(150, 15, 5, 300, 0) };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      stateUsage: new Map([[sid, stale]]),
      serverUsage: new Map([[sid, confirmed]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "150");

    fake.setStore({ ...initial, serverError: true });
    fake.emit("session.step.ended", { sessionID: sid, assistantMessageID: message.id });
    await nextTask();

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "150");
  });
});

test("steps and totals count each finished assistant message once", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_step_sum";
    const first = fakeAssistant("msg_step_1", { tokens: tokens(649, 33, 204) });
    const last = fakeAssistant("msg_step_2", { tokens: tokens(2_901, 252, 65) });

    const fake = createFakeTuiApi({ sessions: new Map([[sid, [first, last]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), formatTokens(649 + 2_901));
    assert.equal(rowValue(rows, "Steps"), "2");
  });
});

test("cache rate: zero denominator renders a dash even when output exists", () => {
  withRoot(() => {
    const sid = "ses_synthetic_nocache";
    const message = fakeAssistant("msg_nocache", {
      tokens: tokens(0, 500, 100),
    });
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [message]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
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
    const a = fakeAssistant("msg_a", { tokens: tokens(100, 10, 5, 200, 40) });
    const b = fakeAssistant("msg_b", {
      model: { providerID: "provider-b", id: "model-b" },
      tokens: tokens(50, 20, 0, 0, 60),
    });
    const fake = createFakeTuiApi({ sessions: new Map([[sid, [a, b]]]) });
    const model = createUsageModel(fake.api, () => sid, solid);
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
      const model = createUsageModel(fake.api, () => sid, solid);
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
    const model = createUsageModel(fake.api, sessionId, solid);

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
    const message = fakeAssistant("msg_family", {
      time: { created: 1_000, streamed: 2_000, completed: 2_001 },
      content: [fakeReasoning("root", 1_100, 2_000)],
      tokens: tokens(100, 10, 5, 200, 0),
    });
    const childMessage = fakeAssistant("msg_family_child", {
      time: { created: 1_000, streamed: 2_000, completed: 2_001 },
      content: [fakeReasoning("child", 1_100, 2_000)],
      tokens: tokens(50, 20, 0, 0, 60),
    });
    const fake = createFakeTuiApi({
      sessions: new Map([
        [sid, [message]],
        [child, [childMessage]],
      ]),
      children: new Map([[sid, [child]]]),
      stateUsage: new Map([
        [sid, { tokens: tokens(100, 10, 5, 200, 0), cost: 1.25 }],
        [child, { tokens: tokens(50, 20, 0, 0, 60), cost: 2.5 }],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "150");
    assert.equal(rowValue(rows, "Output"), "30");
    assert.equal(rowValue(rows, "Reasoning"), "5");
    assert.equal(rowValue(rows, "Cache read"), "200");
    assert.equal(rowValue(rows, "Cache write"), "60");
    assert.equal(rowValue(rows, "Steps"), "2");
    assert.equal(rowValue(rows, "Session cost"), "$3.75");
    assert.equal(rowValue(rows, "Generation speed"), "19 tps");
    assert.equal(rowValue(rows, "Time to first token"), "0.1s");
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
      stateUsage: new Map([
        [sid, { tokens: tokens(100, 10, 0) }],
        [child, { tokens: tokens(30, 5, 0) }],
        [grandchild, { tokens: tokens(7, 3, 2) }],
      ]),
      children: new Map([
        [sid, [child]],
        [child, [grandchild]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "137");
    assert.equal(rowValue(rows, "Output"), "18");
    assert.equal(rowValue(rows, "Reasoning"), "2");
    assert.ok(model.includesSubagents());
  });
});

test("steps: parent and subagent steps sum across the whole family", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_steps_root";
    const child = "ses_steps_child";
    const grandchild = "ses_steps_grandchild";
    const usage = { tokens: tokens(10, 1, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map([
        [sid, [fakeAssistant("msg_steps_root")]],
        [child, [fakeAssistant("msg_steps_child_1"), fakeAssistant("msg_steps_child_2")]],
        [grandchild, [fakeAssistant("msg_steps_grandchild")]],
      ]),
      stateUsage: new Map([[sid, usage], [child, usage], [grandchild, usage]]),
      children: new Map([[sid, [child]], [child, [grandchild]]]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Steps"), "4");
    assert.ok(model.includesSubagents());
  });
});

test("opening a descendant resolves the root and includes the whole family", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_ancestor_root";
    const child = "ses_ancestor_child";
    const sibling = "ses_ancestor_sibling";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([
        [root, { tokens: tokens(100, 10, 0) }],
        [child, { tokens: tokens(40, 4, 0) }],
        [sibling, { tokens: tokens(7, 1, 0) }],
      ]),
      children: new Map([[root, [child, sibling]]]),
    });
    const model = createUsageModel(fake.api, () => child, solid);
    await nextTask();

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "147");
    // Totals still cover the whole family, but the title suffix is reserved
    // for sessions that launched subagents themselves: the viewed child has
    // no descendants of its own (the sibling is not its subagent).
    assert.equal(model.includesSubagents(), false);
  });
});

test("title suffix only when the viewed session has descendants", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_title_root";
    const child = "ses_title_child";
    const grandchild = "ses_title_grandchild";
    const usage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grandchildUsage = { tokens: tokens(7, 1, 0) };
    const store = {
      sessions: new Map(),
      stateUsage: new Map([
        [root, usage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([
        [root, [child]],
        [child, [grandchild]],
      ]),
    };
    const [sessionID, setSessionID] = createSignal(root);
    const fake = createFakeTuiApi(store);
    const model = createUsageModel(fake.api, sessionID, solid);
    await nextTask();

    // Root launched a subagent chain.
    assert.equal(model.includesSubagents(), true);

    // Middle session launched its own subagent.
    setSessionID(child);
    await nextTask();
    assert.equal(model.includesSubagents(), true);

    // Leaf session launched nothing: plain "Token Usage".
    setSessionID(grandchild);
    await nextTask();
    assert.equal(model.includesSubagents(), false);
  });
});

test("duplicate listing and cycles: each session counts once", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_cycle";
    const child = "ses_cycle_child";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([
        [sid, { tokens: tokens(100, 10, 0) }],
        [child, { tokens: tokens(40, 4, 0) }],
      ]),
      children: new Map([
        [sid, [child, child]],
        [child, [sid]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rowValue(rows, "Input"), "140");
    assert.equal(rowValue(rows, "Output"), "14");
    assert.ok(model.includesSubagents());
  });
});

test("live subagent: creation and usage events extend the totals", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_live_family";
    const message = fakeAssistant("msg_lf");
    const rootUsage = { tokens: tokens(100, 10, 0, 200, 0) };
    const childUsage = { tokens: tokens(50, 5, 0) };
    const grownChild = { tokens: tokens(80, 8, 0) };
    const initial = {
      sessions: new Map([[sid, [message]]]),
      stateUsage: new Map([[sid, rootUsage]]),
      children: new Map<string, readonly string[]>(),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid, solid);
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
    fake.requests.length = 0;
    fake.emit("session.created", { sessionID: child, parentID: sid });
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "150");
    assert.ok(model.includesSubagents());
    assert.ok(fake.requests.every((request) => request.endsWith(child)), fake.requests.join(", "));

    fake.setStore({
      ...initial,
      children: new Map([[sid, [child]]]),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, grownChild],
      ]),
    });
    fake.requests.length = 0;
    fake.emit("session.step.ended", { sessionID: child, assistantMessageID: "msg_lf_child" });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "180");
    assert.ok(fake.requests.every((request) => request.endsWith(child)), fake.requests.join(", "));
  });
});

test("new branch discovery survives a concurrent member update", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_creation_race_root";
    const child = "ses_creation_race_child";
    const grandchild = "ses_creation_race_grandchild";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const grownChildUsage = { tokens: tokens(80, 8, 0) };
    const grandchildUsage = { tokens: tokens(7, 1, 0) };
    const initial = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([
        [root, rootUsage],
        [child, grownChildUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    });
    fake.emit("session.created", { sessionID: child, parentID: root });
    fake.emit("session.usage.updated", {
      sessionID: child,
      cost: 0,
      tokens: grownChildUsage.tokens,
    });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "187");
  });
});

test("failed concurrent member update does not cancel branch contribution", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_failed_creation_race_root";
    const child = "ses_failed_creation_race_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const initial = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      serverFailures: new Set([child]),
    });
    fake.emit("session.created", { sessionID: child, parentID: root });
    fake.emit("session.usage.updated", { sessionID: child, cost: 0, tokens: childUsage.tokens });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "140");
  });
});

test("events outside the current family do not trigger requests", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_membership_root";
    const external = "ses_membership_external";
    const usage = { tokens: tokens(100, 10, 0) };
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([[root, usage], [external, usage]]),
    });
    createUsageModel(fake.api, () => root, solid);
    await nextTask();
    fake.requests.length = 0;

    fake.emit("session.created", { sessionID: external });
    fake.emit("session.step.ended", { sessionID: external, assistantMessageID: "msg_external" });
    fake.emit("session.usage.updated", { sessionID: external, cost: 0, tokens: usage.tokens });
    await nextTask();

    assert.deepEqual(fake.requests, []);
  });
});

test("deleted child: totals drop back to the root session", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_shrink";
    const child = "ses_shrink_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 1) };
    const withChild = {
      sessions: new Map(),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, childUsage],
      ]),
      children: new Map([[sid, [child]]]),
    };
    const fake = createFakeTuiApi(withChild);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());

    fake.setStore({
      ...withChild,
      children: new Map<string, readonly string[]>(),
      stateUsage: new Map([[sid, rootUsage]]),
    });
    fake.emit("session.deleted", { sessionID: child });
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "100");
    assert.equal(rowValue(model.rows(), "Reasoning"), "0");
    assert.equal(model.includesSubagents(), false);
  });
});

test("partial family fetch failure keeps totals from resolved sessions", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_partial_fail";
    const child = "ses_partial_fail_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grownChild = { tokens: tokens(90, 9, 0) };
    const withChild = {
      sessions: new Map(),
      stateUsage: new Map([
        [sid, rootUsage],
        [child, childUsage],
      ]),
      children: new Map([[sid, [child]]]),
    };
    const fake = createFakeTuiApi(withChild);
    const model = createUsageModel(fake.api, () => sid, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");

    fake.setStore({
      ...withChild,
      stateUsage: new Map([
        [sid, rootUsage],
        [child, grownChild],
      ]),
      children: new Map([[sid, [child]], [child, []]]),
      serverFailures: new Set([child]),
    });
    fake.emit("server.connected", {});
    await nextTask();

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "190");
  });
});

test("failed descendant discovery retains known members and retries on invalidation", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_retry_root";
    const child = "ses_retry_child";
    const grandchild = "ses_retry_grandchild";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grandchildUsage = { tokens: tokens(7, 1, 0) };
    const family = {
      sessions: new Map(),
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    };
    const fake = createFakeTuiApi(family);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "147");

    fake.setStore({ ...family, serverFailures: new Set([child]) });
    fake.emit("server.connected", {});
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "147");

    fake.setStore({
      ...family,
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
      ]),
      children: new Map([[root, [child]], [child, []]]),
    });
    fake.emit("session.usage.updated", { sessionID: root, cost: 0, tokens: rootUsage.tokens });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "140");

    fake.requests.length = 0;
    fake.emit("session.usage.updated", { sessionID: root, cost: 0, tokens: rootUsage.tokens });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(
      fake.requests.every((request) => request !== `children:${child}`),
      fake.requests.join(", "),
    );
  });
});

test("transient member refresh failure retries on the next invalidation", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_member_retry_root";
    const child = "ses_member_retry_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grownChild = { tokens: tokens(90, 9, 0) };
    const family = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
    };
    const fake = createFakeTuiApi(family);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");

    fake.setStore({
      ...family,
      stateUsage: new Map([[root, rootUsage], [child, grownChild]]),
      serverFailures: new Set([child]),
    });
    // A failed member refresh keeps the confirmed totals and queues a retry.
    fake.emit("session.step.ended", { sessionID: child, assistantMessageID: "msg_member_retry" });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");

    fake.setStore({
      ...family,
      stateUsage: new Map([[root, rootUsage], [child, grownChild]]),
    });
    fake.emit("session.usage.updated", { sessionID: root, cost: 0, tokens: rootUsage.tokens });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "190");
    fake.requests.length = 0;
    fake.emit("session.usage.updated", { sessionID: root, cost: 0, tokens: rootUsage.tokens });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "190");
    assert.ok(
      fake.requests.every((request) => request !== `children:${child}`),
      fake.requests.join(", "),
    );
  });
});

test("deleted session is not resurrected by a partial full refresh", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_tombstone_root";
    const child = "ses_tombstone_child";
    const grandchild = "ses_tombstone_grandchild";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grandchildUsage = { tokens: tokens(7, 1, 0) };
    const family = {
      sessions: new Map(),
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    };
    const fake = createFakeTuiApi(family);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "147");

    fake.setStore({ ...family, serverFailures: new Set([child]) });
    fake.emit("server.connected", {});
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "147");

    fake.setStore({
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]], [child, []]]),
      serverFailures: new Set([child]),
    });
    fake.emit("session.deleted", { sessionID: grandchild });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
  });
});

test("slow full refresh cannot overwrite a newer member contribution", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_full_race_root";
    const child = "ses_full_race_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(40, 4, 0) };
    const grownChild = { tokens: tokens(80, 8, 0) };
    const initial = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");

    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.setStore({
      ...initial,
      serverDelays: new Map([[`children:${root}`, barrier]]),
    });
    fake.emit("server.connected", {});
    await nextTask();

    fake.setStore({ ...initial, stateUsage: new Map([[root, rootUsage], [child, grownChild]]) });
    fake.emit("session.usage.updated", { sessionID: child, cost: 0, tokens: grownChild.tokens });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "180");

    release();
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "180");
  });
});

test("slow full refresh cannot remove a concurrently created branch", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_full_creation_race_root";
    const child = "ses_full_creation_race_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(50, 5, 0) };
    const initial = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.setStore({
      ...initial,
      serverDelays: new Map([[`children:${root}`, barrier]]),
    });
    fake.emit("server.connected", {});
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
    });
    fake.emit("session.created", { sessionID: child, parentID: root });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "150");

    release();
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "150");
  });
});

test("child created during initial family load is applied after the snapshot", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_initial_creation_race_root";
    const child = "ses_initial_creation_race_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(50, 5, 0) };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initial = {
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
      serverDelays: new Map([[`children:${root}`, barrier]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
      serverDelays: new Map(),
    });
    fake.emit("session.created", { sessionID: child, parentID: root });
    await nextTask();
    release();
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "150");
  });
});

test("queued startup branch uses updates received before initial load completes", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_initial_update_root";
    const child = "ses_initial_update_child";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const grownChild = { tokens: tokens(80, 8, 0) };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
      serverDelays: new Map([[`children:${root}`, barrier]]),
    });
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.setStore({
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage], [child, grownChild]]),
      children: new Map([[root, [child]]]),
      serverDelays: new Map(),
    });
    fake.emit("session.created", { sessionID: child, parentID: root });
    fake.emit("session.usage.updated", {
      sessionID: child,
      cost: 0,
      tokens: grownChild.tokens,
    });
    release();
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "180");
  });
});

test("queued startup branch is discarded when deleted before initial load completes", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_initial_delete_root";
    const child = "ses_initial_delete_child";
    const grandchild = "ses_initial_delete_grandchild";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
      serverDelays: new Map([[`children:${root}`, barrier]]),
    });
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.emit("session.created", { sessionID: child, parentID: root });
    fake.emit("session.created", { sessionID: grandchild, parentID: child });
    fake.emit("session.deleted", { sessionID: child });
    release();
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "100");
  });
});

test("out-of-order queued chain attaches parent-first after initial load", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_chain_root";
    const child = "ses_chain_child";
    const grandchild = "ses_chain_grandchild";
    const rootUsage = { tokens: tokens(100, 10, 0) };
    const childUsage = { tokens: tokens(50, 5, 0) };
    const grandchildUsage = { tokens: tokens(7, 1, 0) };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map<string, readonly string[]>(),
      serverDelays: new Map([[`children:${root}`, barrier]]),
    });
    const model = createUsageModel(fake.api, () => root, solid);
    await nextTask();

    fake.emit("session.created", { sessionID: grandchild, parentID: child });
    fake.emit("session.created", { sessionID: child, parentID: root });
    release();
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "157");
  });
});

test("root session switch: family resets, no leakage across roots", async () => {
  await withAsyncRoot(async () => {
    const rootA = "ses_root_a";
    const childA = "ses_root_a_child";
    const rootB = "ses_root_b";
    const usageA = { tokens: tokens(100, 10, 0) };
    const usageChildA = { tokens: tokens(40, 4, 0) };
    const usageB = { tokens: tokens(700, 70, 7) };
    const fake = createFakeTuiApi({
      sessions: new Map(),
      stateUsage: new Map([
        [rootA, usageA],
        [childA, usageChildA],
        [rootB, usageB],
      ]),
      children: new Map([[rootA, [childA]]]),
    });
    const [sessionId, setSessionId] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionId, solid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());

    setSessionId(rootB);
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "700");
    assert.equal(model.includesSubagents(), false);

    setSessionId(rootA);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Input"), "140");
    assert.ok(model.includesSubagents());
  });
});
