import { readFileSync } from "node:fs";
import type {
  AssistantMessage,
  Message,
  Part,
  StepFinishPart,
} from "@opencode-ai/sdk/v2";

export interface ExpectedTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  denominator: number;
}

export interface SessionFixture {
  messages: readonly Message[];
  /** step-finish parts by messageID */
  parts: ReadonlyMap<string, readonly Part[]>;
}

export interface HistoryFixtures {
  expected: Record<string, ExpectedTotals>;
  sessions: ReadonlyMap<string, SessionFixture>;
}

interface RawDoc {
  provenance: unknown;
  expected: Record<string, ExpectedTotals>;
  sessions: Record<
    string,
    { messages: unknown[]; parts: Record<string, unknown[]> }
  >;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`fixture: ${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseAssistantMessage(raw: unknown, sid: string): AssistantMessage {
  const m = assertObject(raw, `session ${sid} message`)
  for (const key of ["id", "role", "providerID", "modelID", "time", "tokens"]) {
    if (!(key in m)) throw new Error(`fixture: assistant message missing ${key} in ${sid}`)
  }
  return m as unknown as AssistantMessage
}

function parseUserMessage(raw: unknown, sid: string): Message {
  const m = assertObject(raw, `session ${sid} message`)
  for (const key of ["id", "role", "time"]) {
    if (!(key in m)) throw new Error(`fixture: user message missing ${key} in ${sid}`)
  }
  return m as unknown as Message
}

function parseStepFinish(raw: unknown, mid: string): StepFinishPart {
  const p = assertObject(raw, `part of ${mid}`)
  if (p["type"] !== "step-finish") {
    throw new Error(`fixture: unexpected non-step-finish part kept for ${mid}`)
  }
  for (const key of ["id", "messageID", "sessionID", "tokens"]) {
    if (!(key in p)) throw new Error(`fixture: step-finish part missing ${key} of ${mid}`)
  }
  return p as unknown as StepFinishPart
}

let cached: HistoryFixtures | undefined;

export function loadHistoryFixtures(): HistoryFixtures {
  if (cached) return cached
  const doc = JSON.parse(
    readFileSync(new URL("./fixtures/history.json", import.meta.url), "utf8"),
  ) as RawDoc

  const sessions = new Map<string, SessionFixture>()
  for (const [sid, rawSession] of Object.entries(doc.sessions)) {
    const messages: Message[] = rawSession.messages.map((raw) => {
      const role = assertObject(raw, `message in ${sid}`)["role"]
      return role === "assistant" ? parseAssistantMessage(raw, sid) : parseUserMessage(raw, sid)
    })
    const parts = new Map<string, readonly Part[]>()
    for (const [mid, rawParts] of Object.entries(rawSession.parts)) {
      parts.set(mid, rawParts.map((raw) => parseStepFinish(raw, mid)))
    }
    // Cover assistant messages that carry no step-finishes.
    for (const m of messages) {
      if (m.role === "assistant" && !parts.has(m.id)) {
        parts.set(m.id, [])
      }
    }
    sessions.set(sid, { messages, parts })
  }

  cached = { expected: doc.expected, sessions }
  return cached
}

export function asAssistant(message: Message): AssistantMessage {
  if (message.role !== "assistant") throw new Error("fixture: expected assistant message")
  return message
}

export type { StepFinishPart };
