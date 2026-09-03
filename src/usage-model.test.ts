import { strict as assert } from "node:assert";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import type {
  AssistantMessage,
  Session,
  StepFinishPart,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2";
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

function fakeText(
  id: string,
  messageID: string,
  sessionID: string,
  text: string,
  start: number,
  end?: number,
): TextPart {
  return { id, sessionID, messageID, type: "text", text, time: { start, end } };
}

function fakeCompletedTool(
  id: string,
  messageID: string,
  sessionID: string,
  start: number,
  end: number,
): ToolPart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "test",
    state: { status: "completed", input: {}, output: "", title: "test", metadata: {}, time: { start, end } },
  };
}

function fakeSession(
  id: string,
  parentID: string | undefined,
  usage: { tokens: NonNullable<Session["tokens"]>; cost?: number },
): Session {
  return {
    id,
    slug: id,
    projectID: "project-test",
    directory: "/",
    title: id,
    version: "0.0.0-test",
    ...(parentID ? { parentID } : {}),
    time: { created: 0, updated: 0 },
    cost: usage.cost ?? 0,
    tokens: usage.tokens,
  };
}

test("completed generation speed is weighted and excludes TTFT and tool time", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_speed";
    const first = fakeAssistant("msg_speed_1", sid, {
      time: { created: 1_000, completed: 5_000 },
    });
    const second = fakeAssistant("msg_speed_2", sid, {
      time: { created: 10_000, completed: 15_000 },
    });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [first, second]]]),
      parts: new Map([
        [first.id, [
          fakeText("prt_text_1", first.id, sid, "first", 2_000, 5_000),
          fakeCompletedTool("prt_tool_1", first.id, sid, 3_000, 4_000),
          fakeStepFinish("prt_finish_1", first.id, sid, {
            input: 0,
            output: 80,
            reasoning: 20,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [second.id, [
          fakeText("prt_text_2", second.id, sid, "second", 11_000, 15_000),
          fakeStepFinish("prt_finish_2", second.id, sid, {
            input: 0,
            output: 150,
            reasoning: 50,
            cache: { read: 0, write: 0 },
          }),
        ]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    // 300 generated tokens / ((4-1-1) + (5-1)) seconds = 50 tps.
    assert.equal(rowValue(model.rows(), "Generation speed"), "50 tps");
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
  });
});

test("live diagnostics tick from Unicode deltas using a snapshotted model calibration", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 20_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_live_speed";
    const completed = fakeAssistant("msg_calibration", sid, {
      time: { created: 1_000, completed: 3_000 },
    });
    const live = fakeAssistant("msg_streaming", sid, {
      parentID: "msg_live_parent",
      time: { created: 18_500 },
    });
    const open = fakeText("prt_streaming", live.id, sid, "", 20_000);
    const initial = {
      sessions: new Map([[sid, [completed, live]]]),
      parts: new Map([
        [completed.id, [
          fakeText("prt_calibration", completed.id, sid, "x".repeat(600), 2_000, 3_000),
          fakeStepFinish("prt_calibration_finish", completed.id, sid, {
            input: 0,
            output: 80,
            reasoning: 20,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [live.id, [open]],
      ]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    fake.emit("message.updated", { sessionID: sid, info: live });
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.5s");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Time to first token"), ">2.5s");

    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: open.id,
      field: "text",
      delta: "🙂".repeat(10),
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");

    t.mock.timers.tick(1_000);
    // Calibration: (400 + 600 chars) / (100 + 100 tokens) = 5 chars/token.
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");

    const recalibrated = {
      ...initial,
      parts: new Map(initial.parts).set(completed.id, [
        fakeText("prt_calibration", completed.id, sid, "x".repeat(1_600), 2_000, 3_000),
        initial.parts.get(completed.id)?.[1] as StepFinishPart,
      ]),
    };
    fake.setStore(recalibrated);
    fake.emit("message.part.updated", {
      sessionID: sid,
      part: recalibrated.parts.get(completed.id)?.[1] as StepFinishPart,
      time: 22_000,
    });
    await nextTask();
    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: open.id,
      field: "text",
      delta: "🙂".repeat(10),
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");

    const closed = { ...open, time: { start: open.time?.start ?? 20_000, end: 23_000 } };
    fake.setStore({ ...recalibrated, parts: new Map(recalibrated.parts).set(live.id, [closed]) });
    fake.emit("message.part.updated", { sessionID: sid, part: closed, time: 23_000 });
    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("live calibration is weighted per model and excludes tool steps", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 30_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_calibration_groups";
    const modelA = fakeAssistant("msg_model_a", sid, {
      time: { created: 1_000, completed: 3_000 },
    });
    const modelB = fakeAssistant("msg_model_b", sid, {
      providerID: "provider-b",
      modelID: "model-b",
      time: { created: 4_000, completed: 8_000 },
    });
    const live = fakeAssistant("msg_model_b_live", sid, {
      providerID: "provider-b",
      modelID: "model-b",
      time: { created: 29_000 },
    });
    const open = fakeText("prt_model_b_live", live.id, sid, "", 30_000);
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [modelA, modelB, live]]]),
      parts: new Map([
        [modelA.id, [
          fakeText("prt_model_a_text", modelA.id, sid, "a".repeat(100), 2_000, 3_000),
          fakeStepFinish("prt_model_a_finish", modelA.id, sid, {
            input: 0,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [modelB.id, [
          fakeText("prt_model_b_text", modelB.id, sid, "b".repeat(1_400), 5_000, 6_000),
          fakeStepFinish("prt_model_b_finish", modelB.id, sid, {
            input: 0,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
          fakeText("prt_model_b_tool_text", modelB.id, sid, "z".repeat(10_000), 6_100, 7_000),
          fakeCompletedTool("prt_model_b_tool", modelB.id, sid, 7_000, 7_500),
          fakeStepFinish("prt_model_b_tool_finish", modelB.id, sid, {
            input: 0,
            output: 1_000,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
          fakeStepFinish("prt_model_b_hidden_finish", modelB.id, sid, {
            input: 0,
            output: 1_000,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [live.id, [open]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: open.id,
      field: "text",
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
    const live = fakeAssistant("msg_empty_live", sid, { time: { created: 39_000 } });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [live]]]),
      parts: new Map([[live.id, []]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "empty");

    fake.emit("message.updated", { sessionID: sid, info: live });
    assert.equal(model.status(), "empty");
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.0s");

    fake.emit("message.removed", { sessionID: sid, messageID: live.id });
    assert.equal(model.status(), "empty");
    assert.deepEqual(model.rows(), []);
  });

  await withAsyncRoot(async () => {
    const sid = "ses_unavailable_live";
    const live = fakeAssistant("msg_unavailable_live", sid, { time: { created: 39_500 } });
    const fake = createFakeTuiApi({ sessions: new Map(), parts: new Map() });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(model.status(), "unavailable");

    fake.emit("message.updated", { sessionID: sid, info: live });
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
    const rootMessage = fakeAssistant("msg_live_root", rootA, { time: { created: 49_000 } });
    const childMessage = fakeAssistant("msg_live_child", child, { time: { created: 49_000 } });
    const rootPart = fakeText("prt_live_root", rootMessage.id, rootA, "", 50_000);
    const childPart = fakeText("prt_live_child", childMessage.id, child, "", 50_000);
    const usage = {
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map([
        [rootA, [rootMessage]],
        [child, [childMessage]],
        [rootB, []],
      ]),
      parts: new Map([
        [rootMessage.id, [rootPart]],
        [childMessage.id, [childPart]],
      ]),
      stateUsage: new Map([[rootA, usage], [child, usage], [rootB, usage]]),
      children: new Map([[rootA, [child]]]),
    });
    const [sessionID, setSessionID] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionID);
    await nextTask();

    fake.emit("message.part.delta", {
      sessionID: child,
      messageID: childMessage.id,
      partID: childPart.id,
      field: "text",
      delta: "child",
    });
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("message.part.delta", {
      sessionID: rootA,
      messageID: rootMessage.id,
      partID: rootPart.id,
      field: "text",
      delta: "root",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");

    setSessionID(rootB);
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    setSessionID(rootA);
    fake.emit("message.part.delta", {
      sessionID: rootA,
      messageID: rootMessage.id,
      partID: rootPart.id,
      field: "text",
      delta: "again",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");
    fake.emit("server.connected", {});
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");
  });
});

test("live TTFT is shown only for the first assistant step of a turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 60_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_live_ttft_steps";
    const first = fakeAssistant("msg_live_ttft_first", sid, {
      parentID: "msg_user_turn",
      time: { created: 59_000 },
    });
    const second = fakeAssistant("msg_live_ttft_second", sid, {
      parentID: "msg_user_turn",
      time: { created: 60_000 },
    });
    const usage = {
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [first, second]]]),
      parts: new Map([[first.id, []], [second.id, []]]),
      stateUsage: new Map([[sid, usage]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    fake.emit("message.updated", { sessionID: sid, info: first });
    assert.equal(rowValue(model.rows(), "Time to first token"), ">1.0s");
    fake.emit("message.part.updated", {
      sessionID: sid,
      part: fakeStepFinish("prt_live_ttft_finish", first.id, sid, {
        input: 0,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
      time: 60_000,
    });
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");

    fake.emit("message.updated", { sessionID: sid, info: second });
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
  });
});

test("switching into a session mid-turn does not restart live TTFT", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 65_000 });
  await withAsyncRoot(async () => {
    const rootA = "ses_ttft_switch_a";
    const rootB = "ses_ttft_switch_b";
    const first = fakeAssistant("msg_ttft_switch_first", rootB, {
      parentID: "msg_ttft_switch_user",
      time: { created: 60_000, completed: 62_000 },
    });
    const later = fakeAssistant("msg_ttft_switch_later", rootB, {
      parentID: "msg_ttft_switch_user",
      time: { created: 64_000 },
    });
    const usage = {
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map([[rootA, []], [rootB, [first, later]]]),
      parts: new Map([
        [first.id, [fakeStepFinish("prt_ttft_switch_finish", first.id, rootB, {
          input: 0,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })]],
        [later.id, []],
      ]),
      stateUsage: new Map([[rootA, usage], [rootB, usage]]),
    });
    const [sessionID, setSessionID] = createSignal(rootA);
    const model = createUsageModel(fake.api, sessionID);
    await nextTask();

    setSessionID(rootB);
    fake.emit("message.updated", { sessionID: rootB, info: later });
    assert.equal(rowValue(model.rows(), "Time to first token"), "–");
  });
});

test("completed metrics preserve conservative multi-step timing and skip invalid turns", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_speed_boundaries";
    const valid = fakeAssistant("msg_speed_valid", sid, {
      time: { created: 1_000, completed: 5_000 },
    });
    const unfinishedPart = fakeAssistant("msg_speed_unfinished_part", sid, {
      time: { created: 10_000, completed: 12_000 },
    });
    const zeroTokens = fakeAssistant("msg_speed_zero_tokens", sid, {
      time: { created: 20_000, completed: 22_000 },
    });
    const zeroDecode = fakeAssistant("msg_speed_zero_decode", sid, {
      time: { created: 30_000, completed: 32_000 },
    });
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [valid, unfinishedPart, zeroTokens, zeroDecode]]]),
      parts: new Map([
        [valid.id, [
          fakeText("prt_reasoning_valid", valid.id, sid, "reasoning", 2_000, 2_500),
          fakeStepFinish("prt_reasoning_finish", valid.id, sid, {
            input: 0,
            output: 0,
            reasoning: 50,
            cache: { read: 0, write: 0 },
          }),
          fakeText("prt_text_valid", valid.id, sid, "text", 4_000, 5_000),
          fakeStepFinish("prt_text_finish", valid.id, sid, {
            input: 0,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [unfinishedPart.id, [
          fakeText("prt_unfinished", unfinishedPart.id, sid, "open", 11_000),
          fakeStepFinish("prt_unfinished_finish", unfinishedPart.id, sid, {
            input: 0,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [zeroTokens.id, [
          fakeText("prt_zero_tokens", zeroTokens.id, sid, "done", 21_000, 22_000),
          fakeStepFinish("prt_zero_tokens_finish", zeroTokens.id, sid, {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [zeroDecode.id, [
          fakeText("prt_zero_decode", zeroDecode.id, sid, "done", 31_000, 32_000),
          fakeCompletedTool("prt_zero_decode_tool", zeroDecode.id, sid, 31_000, 32_000),
          fakeStepFinish("prt_zero_decode_finish", zeroDecode.id, sid, {
            input: 0,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    // The 1.5s reasoning-to-text gap stays in the 3s decode denominator.
    assert.equal(rowValue(model.rows(), "Generation speed"), "33 tps");
    // Zero-token and zero-decode turns still have valid completed TTFT samples.
    assert.equal(rowValue(model.rows(), "Time to first token"), "1.0s");
  });
});

test("short streams never show a number and a later visible part starts a new measurement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 70_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_short_stream";
    const live = fakeAssistant("msg_short_stream", sid, { time: { created: 69_000 } });
    const first = fakeText("prt_short_first", live.id, sid, "", 70_000);
    const second = fakeText("prt_short_second", live.id, sid, "", 70_500);
    const usage = {
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map([[sid, [live]]]),
      parts: new Map([[live.id, [first]]]),
      stateUsage: new Map([[sid, usage]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: first.id,
      field: "text",
      delta: "short",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");
    const closed = { ...first, time: { start: 70_000, end: 70_500 } };
    fake.setStore({ ...initial, parts: new Map([[live.id, [closed, second]]]) });
    fake.emit("message.part.updated", { sessionID: sid, part: closed, time: 70_500 });
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: second.id,
      field: "text",
      delta: "12345678",
    });
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
  });
});

test("a pre-existing TTFT timer cannot publish live speed before its own first second", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 80_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_timer_alignment";
    const live = fakeAssistant("msg_timer_alignment", sid, {
      parentID: "msg_timer_alignment_user",
      time: { created: 79_000 },
    });
    const open = fakeText("prt_timer_alignment", live.id, sid, "", 80_900);
    const usage = {
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [live]]]),
      parts: new Map([[live.id, [open]]]),
      stateUsage: new Map([[sid, usage]]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();

    fake.emit("message.updated", { sessionID: sid, info: live });
    t.mock.timers.tick(900);
    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: open.id,
      field: "text",
      delta: "12345678",
    });
    t.mock.timers.tick(100);
    assert.equal(rowValue(model.rows(), "Live speed"), "~–");

    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "~2 tps");
  });
});

test("completed message update refreshes metrics after a step-finish race", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_completion_race";
    const live = fakeAssistant("msg_completion_race", sid, {
      time: { created: 1_000 },
    });
    const finish = fakeStepFinish("prt_completion_race_finish", live.id, sid, {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    const parts = new Map([[live.id, [
      fakeText("prt_completion_race_text", live.id, sid, "done", 2_000, 3_000),
      finish,
    ]]]);
    const initial = {
      sessions: new Map([[sid, [live]]]),
      parts,
      stateUsage: new Map([[sid, {
        tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("message.part.updated", { sessionID: sid, part: finish, time: 3_000 });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    const completed = { ...live, time: { created: 1_000, completed: 3_000 } };
    fake.setStore({ ...initial, sessions: new Map([[sid, [completed]]]) });
    fake.emit("message.updated", { sessionID: sid, info: completed });
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("completed descendant message update refreshes family diagnostics", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_descendant_completion_root";
    const child = "ses_descendant_completion_child";
    const live = fakeAssistant("msg_descendant_completion", child, {
      time: { created: 1_000 },
    });
    const finish = fakeStepFinish("prt_descendant_completion_finish", live.id, child, {
      input: 0,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    const parts = new Map([[live.id, [
      fakeText("prt_descendant_completion_text", live.id, child, "done", 2_000, 3_000),
      finish,
    ]]]);
    const usage = {
      tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map([[child, [live]]]),
      parts,
      stateUsage: new Map([[root, usage], [child, usage]]),
      children: new Map([[root, [child]]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    const completed = { ...live, time: { created: 1_000, completed: 3_000 } };
    fake.setStore({ ...initial, sessions: new Map([[child, [completed]]]) });
    fake.emit("message.updated", { sessionID: child, info: completed });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Generation speed"), "100 tps");
  });
});

test("positive speeds that round to zero render as unavailable", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 90_000 });
  await withAsyncRoot(async () => {
    const sid = "ses_rounds_to_zero";
    const completed = fakeAssistant("msg_rounds_to_zero", sid, {
      time: { created: 1_000, completed: 4_500 },
    });
    const live = fakeAssistant("msg_live_rounds_to_zero", sid, {
      parentID: "msg_live_rounds_to_zero_user",
      time: { created: 89_000 },
    });
    const open = fakeText("prt_live_rounds_to_zero", live.id, sid, "", 90_000);
    const fake = createFakeTuiApi({
      sessions: new Map([[sid, [completed, live]]]),
      parts: new Map([
        [completed.id, [
          fakeText("prt_rounds_to_zero", completed.id, sid, "done", 2_000, 4_500),
          fakeStepFinish("prt_rounds_to_zero_finish", completed.id, sid, {
            input: 0,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }),
        ]],
        [live.id, [open]],
      ]),
    });
    const model = createUsageModel(fake.api, () => sid);
    await nextTask();
    assert.equal(rowValue(model.rows(), "Generation speed"), "–");

    fake.emit("message.part.delta", {
      sessionID: sid,
      messageID: live.id,
      partID: open.id,
      field: "text",
      delta: "x",
    });
    t.mock.timers.tick(1_000);
    assert.equal(rowValue(model.rows(), "Live speed"), "–");
  });
});

test("section title and row labels are pinned", () => {
  assert.equal(USAGE_SECTION_TITLE, "Token Usage");
  assert.deepEqual([...USAGE_LABELS], [
    "Input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
    "Cache rate",
    "Session cost",
    "Generation speed",
    "Time to first token",
  ]);
});

test("real paid session: authoritative totals render exactly", () => {
  withRoot(() => {
    const fake = createFakeTuiApi(fixtureStore(PAID));
    const model = createUsageModel(fake.api, () => PAID);

    assert.equal(model.status(), "ready");
    const rows = model.rows();
    assert.equal(rows.length, 9);
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

test("initial family failure does not fall back to an incomplete local aggregate", async () => {
  await withAsyncRoot(async () => {
    const sid = "ses_local_only";
    const usage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[sid, usage]]),
      serverError: true,
    });
    const model = createUsageModel(fake.api, () => sid);

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
        ["msg_family", [
          fakeText("prt_family_text", "msg_family", sid, "root", 1_100, 1_900),
          fakeStepFinish("prt_family", "msg_family", sid, message.tokens),
        ]],
        [
          "msg_family_child",
          [
            fakeText("prt_family_child_text", "msg_family_child", child, "child", 1_100, 1_900),
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
      stateUsage: new Map([
        [sid, {
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 0 } },
          cost: 1.25,
        }],
        [child, {
          tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 60 } },
          cost: 2.5,
        }],
      ]),
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

test("opening a descendant resolves the root and includes the whole family", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_ancestor_root";
    const child = "ses_ancestor_child";
    const sibling = "ses_ancestor_sibling";
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [root, { tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }],
        [child, { tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }],
        [sibling, { tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
      ]),
      children: new Map([[root, [child, sibling]]]),
    });
    const model = createUsageModel(fake.api, () => child);
    await nextTask();

    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "147");
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
    fake.requests.length = 0;
    fake.emit("session.created", {
      sessionID: child,
      info: fakeSession(child, sid, childUsage),
    });
    await nextTask();
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "150");
    assert.ok(model.includesSubagents());
    assert.ok(fake.requests.every((request) => request.endsWith(child)), fake.requests.join(", "));

    const grownChild = {
      tokens: { input: 80, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    fake.setStore({
      ...initial,
      children: new Map([[sid, [child]]]),
      stateUsage: new Map([[sid, rootUsage], [child, grownChild]]),
    });
    fake.requests.length = 0;
    fake.emit("message.part.updated", {
      part: fakeStepFinish("prt_lf_child", "msg_lf_child", child, grownChild.tokens),
    });
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
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const grandchildUsage = {
      tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    });
    const grownChildUsage = {
      tokens: { input: 80, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    fake.setStore({
      ...initial,
      stateUsage: new Map([
        [root, rootUsage],
        [child, grownChildUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    });
    const createdInfo = fakeSession(child, root, childUsage);
    fake.emit("session.created", { sessionID: child, info: createdInfo });
    fake.emit("session.updated", {
      sessionID: child,
      info: fakeSession(child, root, grownChildUsage),
    });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "187");
  });
});

test("failed concurrent member update does not cancel branch contribution", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_failed_creation_race_root";
    const child = "ses_failed_creation_race_child";
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
    await nextTask();

    const childInfo = fakeSession(child, root, childUsage);
    fake.setStore({
      ...initial,
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      serverFailures: new Set([child]),
    });
    fake.emit("session.created", { sessionID: child, info: childInfo });
    fake.emit("session.updated", { sessionID: child, info: childInfo });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "140");
  });
});

test("events outside the current family do not trigger requests", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_membership_root";
    const external = "ses_membership_external";
    const usage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const fake = createFakeTuiApi({
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, usage], [external, usage]]),
    });
    createUsageModel(fake.api, () => root);
    await nextTask();
    fake.requests.length = 0;

    fake.emit("session.created", {
      sessionID: external,
      info: fakeSession(external, undefined, usage),
    });
    fake.emit("message.part.updated", {
      part: fakeStepFinish("prt_external", "msg_external", external, usage.tokens),
    });
    fake.emit("session.updated", {
      sessionID: external,
      info: fakeSession(external, undefined, usage),
    });
    await nextTask();

    assert.deepEqual(fake.requests, []);
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

test("partial family fetch failure keeps totals from resolved sessions", async () => {
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

    // The child's usage grows, but its own messages/children lookups now fail.
    // Its authoritative aggregate was still resolved in the root's child list.
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
    fake.emit("server.connected", {});
    await nextTask();

    // The resolved root and child aggregates still form a useful family total.
    assert.equal(model.status(), "ready");
    assert.equal(rowValue(model.rows(), "Input"), "190");
  });
});

test("failed descendant discovery retains known members and retries on invalidation", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_retry_root";
    const child = "ses_retry_child";
    const grandchild = "ses_retry_grandchild";
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const grandchildUsage = {
      tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const family = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([
        [root, rootUsage],
        [child, childUsage],
        [grandchild, grandchildUsage],
      ]),
      children: new Map([[root, [child]], [child, [grandchild]]]),
    };
    const fake = createFakeTuiApi(family);
    const model = createUsageModel(fake.api, () => root);
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
    fake.emit("session.updated", {
      sessionID: root,
      info: fakeSession(root, undefined, rootUsage),
    });
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "140");
  });
});

test("slow full refresh cannot overwrite a newer member contribution", async () => {
  await withAsyncRoot(async () => {
    const root = "ses_full_race_root";
    const child = "ses_full_race_child";
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
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

    const grownChild = {
      tokens: { input: 80, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    fake.setStore({ ...initial, stateUsage: new Map([[root, rootUsage], [child, grownChild]]) });
    fake.emit("session.updated", {
      sessionID: child,
      info: fakeSession(child, root, grownChild),
    });
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
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initial = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
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
    fake.emit("session.created", {
      sessionID: child,
      info: fakeSession(child, root, childUsage),
    });
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
    const rootUsage = {
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const childUsage = {
      tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initial = {
      sessions: new Map(),
      parts: new Map(),
      stateUsage: new Map([[root, rootUsage]]),
      children: new Map<string, readonly string[]>(),
      serverDelays: new Map([[`children:${root}`, barrier]]),
    };
    const fake = createFakeTuiApi(initial);
    const model = createUsageModel(fake.api, () => root);
    await nextTask();

    fake.setStore({
      ...initial,
      stateUsage: new Map([[root, rootUsage], [child, childUsage]]),
      children: new Map([[root, [child]]]),
      serverDelays: new Map(),
    });
    fake.emit("session.created", {
      sessionID: child,
      info: fakeSession(child, root, childUsage),
    });
    await nextTask();
    release();
    await nextTask();

    assert.equal(rowValue(model.rows(), "Input"), "150");
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
