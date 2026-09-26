# token-usage-panel

<div>
  <img src="public/token-usage-panel.png" alt="token usage panel demo" />
</div>
<br>

An OpenCode plugin that adds a collapsible `Token Usage` section to the TUI session sidebar. This section shows what the session actually costs: total input/output/reasoning tokens, cache rate, spend, or speed.

Totals fold in the whole session family: the parent session plus all subagent descendants, from OpenCode's own `session.tokens` / `session.cost` aggregates. When descendants contribute, their usage sums up with parent agent usage.

Requires OpenCode v2 (`>=2.0.0`). On OpenCode v1 stay on `@glaicer/supercode-token-usage-panel@0.1.4`.

## Install

Install with the OpenCode CLI — it installs the package and registers the plugin in the global server configuration (`~/.config/opencode/opencode.jsonc`):

```bash
opencode plugin add @glaicer/supercode-token-usage-panel
```

Restart OpenCode after installing.

> [!IMPORTANT]
> **The first OpenCode load after installing this plugin may be slow.** That's OpenCode downloading the plugin's packages and managed tools into its cache — it happens once. Every subsequent start is fast.

Manual install also works: add the package to the `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["@glaicer/supercode-token-usage-panel"]
}
```

### Sidebar order

The panel claims `after: "sidebar.content"`, and so do other plugins that extend the sidebar, so their relative order is the order in which they were registered. Entries in `opencode.jsonc` are always ordered before entries in `cli.json`, so register the panel here to place it relative to another sidebar plugin — for example, between `context-progress-bar` and `session-recap`:

```jsonc
{
  "plugins": [
    "@glaicer/supercode-context-progress-bar",
    "@glaicer/supercode-token-usage-panel",
    "@glaicer/supercode-session-recap"
  ]
}
```

The package ships a no-op server entry purely to make this possible: a `./tui`-only package can only be registered in `cli.json`, which always sorts last.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: session history comes from fixtures
npm run build       # precompile Solid TSX into dist
npm pack --dry-run  # build and verify the publish artifact
```
