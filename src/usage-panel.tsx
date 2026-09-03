/**
 * supercode.token-usage — TUI sidebar section showing the cumulative Token
 * Usage of the current session family: token totals, cache rate, completed
 * step count, generation speed/TTFT, and provisional diagnostics for the
 * visible stream.
 * Family totals include all subagent descendants; when they contribute the
 * section title becomes "Token Usage (including subagents)".
 *
 * This file is only the View plus slot registration: it computes no numbers
 * and formats nothing — all logic lives in ./usage-model.ts (the tested seam).
 *
 * Colors always come from the live host theme; collapse state is component
 * memory, expanded by default and not persisted (spec: Out of Scope).
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
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

function Section(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current;
  const [collapsed, setCollapsed] = createSignal(false);
  const model = createUsageModel(props.api, () => props.session_id, solid);

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed(!collapsed())}>
        <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text}>
          <b>{model.includesSubagents() ? USAGE_SECTION_TITLE_WITH_SUBAGENTS : USAGE_SECTION_TITLE}</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <Show when={model.status() !== "ready"}>
          <text fg={theme().textMuted}>{USAGE_STATUS_TEXT[model.status()]}</text>
        </Show>
        <For each={model.rows()}>
          {(row) => (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}>{row.label}</text>
              <text fg={theme().text}>{row.value}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  // Order 150: internal sidebar sections sit at 100/200/300/400/500, so this
  // lands right after the first block without moving any existing section.
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <Section api={api} session_id={props.session_id} />;
      },
    },
  });
};

const plugin: TuiPluginModule = {
  id: "supercode.token-usage",
  tui,
};

export default plugin;
