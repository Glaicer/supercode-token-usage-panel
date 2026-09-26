/**
 * Server entrypoint (required so the plugin loads at all).
 *
 * The panel itself is TUI-only; all behaviour lives in `src/usage-panel.tsx`.
 * This no-op server half exists for two host requirements: the server resolves
 * a package through its main/server entry and only then reports `features.tui`,
 * and sidebar claims from different plugins share one slot, so their relative
 * order is the order of the `plugins` array that loaded them. Registering in
 * `opencode.jsonc` is therefore the only way to place this panel relative to
 * another `sidebar.content` claim such as session-recap — a `cli.json`-only
 * entry is always ordered last.
 */
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "supercode.token-usage",
  setup() {},
});
