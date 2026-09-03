# token-usage-panel

<div>
  <img src="public/token-usage-panel.png" alt="token usage panel demo" />
</div>
<br>

An OpenCode plugin that adds a collapsible `Token Usage` section to the TUI session sidebar. This section shows what the session actually costs: total input/output/reasoning tokens, cache rate, spend, or speed.

Totals fold in the whole session family: the parent session plus all subagent descendants, from OpenCode's own `session.tokens` / `session.cost` aggregates. When descendants contribute, their usage sums up with parent agent usage.

## Install

Install with the OpenCode CLI — it detects the TUI target and registers the plugin in `tui.json` for you:

```bash
opencode plugin @glaicer/supercode-token-usage-panel
```

- `--global` installs into the global config (`~/.config/opencode`); default is local (`.opencode` in the current project).
- `--force` replaces an already-installed version.
- Restart OpenCode after installing.

Manual install also works: add the package to the `plugin` array in `tui.json` (global `~/.config/opencode/tui.json` or local `<project>/.opencode/tui.json`):

```jsonc
{
  "plugin": ["@glaicer/supercode-token-usage-panel"]
}
```

> [!IMPORTANT]
> **The first OpenCode load after installing this plugin may be slow.** That's OpenCode downloading the plugin's packages and managed tools into its cache — it happens once. Every subsequent start is fast.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: session history comes from fixtures
npm run build       # precompile Solid TSX into dist
npm pack --dry-run  # build and verify the publish artifact
```
