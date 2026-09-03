import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const target = manifest.exports?.["./tui"];

assert.equal(target, "./dist/usage-panel.js", "./tui must export compiled JavaScript");

const entry = readFileSync(resolve(root, target), "utf8");
assert.doesNotMatch(entry, /<(?:box|text)\b/, "compiled entry must not contain raw JSX");
assert.doesNotMatch(entry, /from ["'][^"']+\.tsx?["']/, "compiled entry must not import TypeScript");
assert.match(entry, /get session_id\(\)/, "Solid transform must preserve the session_id getter");
assert.match(entry, /get when\(\)/, "Solid transform must preserve reactive Show getters");

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const pack = Array.isArray(packed) ? packed[0] : packed[manifest.name] ?? Object.values(packed)[0];
const files = pack.files.map((file) => file.path);

assert.ok(files.includes("dist/usage-panel.js"), "tarball must include the compiled TUI entry");
assert.ok(files.includes("dist/usage-model.js"), "tarball must include the compiled model");
assert.ok(!files.some((file) => file.startsWith("src/")), "tarball must not include raw source files");

console.log("package artifact: compiled Solid JS only");
