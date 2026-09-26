/**
 * Root server entry for local-directory loading.
 *
 * When this package is referenced by directory path in `opencode.json(c)`
 * `plugins`, the host loads `<dir>/index.{ts,js}` directly and does not consult
 * `package.json` `exports`. The npm route keeps using `exports["."]` →
 * `./dist/index.js`. Both entries define the same plugin; the host loads
 * exactly one per package.
 */
export { default } from "./dist/index.js";
