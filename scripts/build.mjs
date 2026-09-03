import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const sources = ["usage-model.ts", "usage-panel.tsx"];

function rewriteTypeScriptExtensions() {
  const rewrite = (path) => {
    const source = path.node.source;
    if (!source?.value.startsWith(".")) return;
    source.value = source.value.replace(/\.tsx?$/, ".js");
  };

  return {
    visitor: {
      ExportAllDeclaration: rewrite,
      ExportNamedDeclaration: rewrite,
      ImportDeclaration: rewrite,
    },
  };
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const source of sources) {
  const input = resolve(root, "src", source);
  const output = resolve(dist, source.replace(/\.tsx?$/, ".js"));
  const result = await transformAsync(await readFile(input, "utf8"), {
    babelrc: false,
    configFile: false,
    filename: input,
    plugins: [rewriteTypeScriptExtensions],
    presets: [
      [solid, { generate: "universal", moduleName: "@opentui/solid" }],
      [typescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
    ],
    sourceMaps: false,
    sourceType: "module",
  });

  if (!result?.code) throw new Error(`Babel produced no output for ${source}`);
  await writeFile(output, `${result.code}\n`);
}
