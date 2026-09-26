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
add this repo's absolute path to `plugins` in `~/.config/opencode/opencode.jsonc`
(never `cli.json` — see Registration). A directory target resolves
`<dir>/index.{ts,js}` for the server and `<dir>/tui.*` for the TUI and never
consults package.json `exports`, so the root `index.ts` / `tui.js` (one-line
re-exports of the built files) are required. Verified 2026-09-25 on opencode
2.0.16 (Bun binary): the host rewrites `solid-js` / `@opentui/*` for non-`node_modules`
files as well, so loading from the repo shares the host Solid instance, and a
`dist` rebuild hot-reloads in a running TUI (`stage=read` → `cleanup` → `setup`
in the `role=cli` log; no restart needed).

## Registration

The panel claims `after: "sidebar.content"`, shared with other sidebar plugins,
and the host renders same-anchor claims in registration order: `opencode.jsonc`
entries first, then `cli.json`. The panel therefore has to be registered in
`opencode.jsonc` to be placeable relative to another sidebar plugin — a
`cli.json`-only entry always sorts last. That is the whole reason for the no-op
`src/index.ts` server half: the server only reports `features.tui` for a package
it resolved through its server entry, and a `./tui`-only package cannot be
registered in `opencode.jsonc` at all (the server raises `LoadError: Plugin
entrypoint not found`). `opencode plugin add` picks its target from the
entrypoints, so it now writes to `opencode.jsonc` on its own.

## Verification

Run `npm run typecheck`, `npm test`, and `npm pack --dry-run` after changes.
Verify OpenCode API claims by running against a real OpenCode (plugin load in a
TUI), not by reading types alone: the generated types have drifted from the
runtime before.
