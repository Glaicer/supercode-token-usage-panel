# Repository Guidance

## Target runtime

OpenCode **v2** only (`@opencode/plugin`, TUI context `Plugin.Context`); the
package is a breaking migration of the v1 plugin, which stays available as
0.1.4. `src/usage-model.ts` depends on a narrow `UsageApi` slice of the context;
`usage-panel.tsx` passes the real `Plugin.Context`, so `npm run typecheck`
fails if the slice drifts from the host API.

In v2, `session.step.streamed` / `message.time.streamed` marks **stream end**,
not first token (verified against 2.0.16 session history and runner). Measure
decode from the first content-start event to stream end; tool execution can
overlap streaming. Historical text items have no start timestamp: use the
first reasoning/tool item's `time.created` only when it is the content head,
otherwise omit that diagnostic sample.

## TUI Package Build

Published packages must export `./dist/usage-panel.js`, never raw TSX under
`src`. The Solid runtime transform of `@opentui/solid` (the host installs it
via `runtime-plugin-support`) filters out `node_modules`, so raw TSX in an
npm-installed package compiles without Solid's reactive getter transform and
leaves the panel frozen at first paint. This holds for v2 exactly as it did for
v1; the precompiled Babel output (Solid `universal`, `moduleName:
"@opentui/solid"`) instead gets its `solid-js` / `@opentui/*` /
`@opencode/plugin/tui` imports rewritten to the host's own runtime modules.

`npm pack --dry-run` runs the Babel build and `scripts/check-package.mjs`. The
check requires compiled Solid getters and rejects raw source files in the
tarball.

## Local install (pre-publish testing)

`opencode plugin add` accepts only npm/Git specs. To run the working tree,
add this repo's absolute path to `plugins` in `~/.config/opencode/cli.json`:
a directory target resolves `<dir>/tui.*` and never consults package.json
`exports["./tui"]`, so the root `tui.js` (one-line re-export of
`./dist/usage-panel.js`; excluded from the tarball by `files: ["dist"]`) is
required. Verified 2026-09-25 on opencode 2.0.16 (Bun binary): the host
rewrites `solid-js` / `@opentui/*` for non-`node_modules` files as well, so
loading from the repo shares the host Solid instance, and a `dist` rebuild
hot-reloads in a running TUI (`stage=read` → `cleanup` → `setup` in the
`role=cli` log; no restart needed).

## Verification

Run `npm run typecheck`, `npm test`, and `npm pack --dry-run` after changes.
Verify OpenCode API claims by running against a real OpenCode (plugin load in a
TUI), not by reading types alone: the generated types have drifted from the
runtime before.
