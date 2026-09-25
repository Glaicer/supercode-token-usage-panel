// Local-install entry: a directory plugin target resolves "<dir>/tui.*"
// instead of package.json exports["./tui"]; npm installs use the export.
export { default } from "./dist/usage-panel.js";
