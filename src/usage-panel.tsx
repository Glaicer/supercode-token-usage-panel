/**
 * supercode.token-usage — TUI sidebar section showing the cumulative Token
 * Usage of the current session family: token totals, cache rate, completed
 * step count, generation speed/TTFT, and provisional diagnostics for the
 * visible stream.
 * Family totals include all subagent descendants; when the current session
 * itself has descendant sessions the section title becomes
 * "Token Usage (including subagents)", otherwise it stays "Token Usage".
 *
 * This file is only the View plus slot registration: it computes no numbers
 * and formats nothing — all logic lives in ./usage-model.ts (the tested seam).
 *
 * Colors always come from the live host theme; collapse state is component
 * memory, expanded by default and not persisted (spec: Out of Scope).
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import {
  USAGE_SECTION_TITLE,
  USAGE_SECTION_TITLE_WITH_SUBAGENTS,
  USAGE_STATUS_TEXT,
  createUsageModel,
  type SolidRuntime,
} from "./usage-model.ts";

/**
 * The host rewrites this file's "solid-js" import to its own runtime. The
 * model builds all of its signals on these exact primitives (see
 * SolidRuntime), so the panel stays in the host's reactive graph even when
 * installed as an npm package under node_modules.
 */
const solid: SolidRuntime = { createSignal, createMemo, createEffect, onCleanup, untrack };

function Section(props: { context: Plugin.Context; sessionID: string }) {
  const theme = () => props.context.theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const model = createUsageModel(props.context, () => props.sessionID, solid);

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed(!collapsed())}>
        <text fg={theme().text.base}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text.base}>
          <b>{model.includesSubagents() ? USAGE_SECTION_TITLE_WITH_SUBAGENTS : USAGE_SECTION_TITLE}</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <Show when={model.status() !== "ready"}>
          <text fg={theme().text.muted}>{USAGE_STATUS_TEXT[model.status()]}</text>
        </Show>
        <For each={model.rows()}>
          {(row) => (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text.muted}>{row.label}</text>
              <text fg={theme().text.base}>{row.value}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: "supercode.token-usage",
  setup(context) {
    // `after`, not `append`: a replace takeover of this path (e.g.
    // context-progress-bar's hideMcp) suppresses every append/prepend claim
    // on it, while before/after claims render as siblings around the
    // boundary. Content still lands below the built-in sidebar sections.
    context.ui.slot({
      after: "sidebar.content",
      render: (props) => <Section context={context} sessionID={props.sessionID} />,
    });
  },
});
