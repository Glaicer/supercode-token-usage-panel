# Repository Guidance

## TUI Package Build

Published packages must export `./dist/usage-panel.js`, never raw TSX under
`src`. OpenCode's Solid transform excludes `node_modules`, so raw TSX can load
without Solid's reactive getter transform and leave the panel frozen.

`npm pack --dry-run` runs the Babel build and `scripts/check-package.mjs`. The
check requires compiled Solid getters and rejects raw source files in the
tarball.

## Verification

Run `npm run typecheck`, `npm test`, and `npm pack --dry-run` after changes.
