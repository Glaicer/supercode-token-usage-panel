# token-usage-panel

<div>
  <img src="public/token-usage-panel.png" alt="token usage panel demo" />
</div>
<br>

An OpenCode plugin that adds a collapsible `Token Usage` section to the TUI session sidebar. This section shows what the session actually costs: total input/output/reasoning tokens, cache rate, spend, or speed.

Totals fold in the whole session family: the parent session plus all subagent descendants, from OpenCode's own `session.tokens` / `session.cost` aggregates. When descendants contribute, their usage sums up with parent agent usage.

Requires OpenCode v2 (`>=2.0.0`). On OpenCode v1 stay on `@glaicer/supercode-token-usage-panel@0.1.4`.

## Install

Install with the OpenCode CLI — it installs the package and registers the plugin in the global CLI configuration (`~/.config/opencode/cli.json`):

```bash
opencode plugin add @glaicer/supercode-token-usage-panel
```

Restart OpenCode after installing.

> [!IMPORTANT]
> **The first OpenCode load after installing this plugin may be slow.** That's OpenCode downloading the plugin's packages and managed tools into its cache — it happens once. Every subsequent start is fast.

Manual install also works: add the package to the `plugins` array in `~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": ["@glaicer/supercode-token-usage-panel"]
}
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: session history comes from fixtures
npm run build       # precompile Solid TSX into dist
npm pack --dry-run  # build and verify the publish artifact
```
