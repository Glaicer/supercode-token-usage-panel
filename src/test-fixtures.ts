import { readFileSync } from "node:fs";
import type { SessionMessageInfo } from "@opencode/client";

export interface ExpectedTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  denominator: number;
}

export interface SessionFixture {
  messages: readonly SessionMessageInfo[];
}

export interface HistoryFixtures {
  expected: Record<string, ExpectedTotals>;
  sessions: ReadonlyMap<string, SessionFixture>;
}

interface RawDoc {
  provenance: unknown;
  expected: Record<string, ExpectedTotals>;
  sessions: Record<string, { messages: unknown[] }>;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`fixture: ${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseMessage(raw: unknown, sid: string): SessionMessageInfo {
  const m = assertObject(raw, `session ${sid} message`)
  for (const key of ["id", "type", "time"]) {
    if (!(key in m)) throw new Error(`fixture: message missing ${key} in ${sid}`)
  }
  if (m["type"] === "assistant") {
    for (const key of ["model", "tokens"]) {
      if (!(key in m)) throw new Error(`fixture: assistant message missing ${key} in ${sid}`)
    }
  }
  return m as unknown as SessionMessageInfo
}

let cached: HistoryFixtures | undefined;

export function loadHistoryFixtures(): HistoryFixtures {
  if (cached) return cached
  const doc = JSON.parse(
    readFileSync(new URL("./fixtures/history.json", import.meta.url), "utf8"),
  ) as RawDoc

  const sessions = new Map<string, SessionFixture>()
  for (const [sid, rawSession] of Object.entries(doc.sessions)) {
    sessions.set(sid, { messages: rawSession.messages.map((raw) => parseMessage(raw, sid)) })
  }

  cached = { expected: doc.expected, sessions }
  return cached
}

export function asAssistant(message: SessionMessageInfo): Extract<SessionMessageInfo, { type: "assistant" }> {
  if (message.type !== "assistant") throw new Error("fixture: expected assistant message")
  return message
}
