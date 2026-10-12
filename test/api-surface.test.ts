import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The public surface, frozen.
 *
 * `src/index.ts` is the only entry point the package exposes — the `exports`
 * map in `package.json` names that one file and nothing else — so the names
 * reachable from it *are* the API. This test reads the declarations the build
 * emitted, compares them with `test/api-surface.json`, and refuses a change
 * nobody meant to make.
 *
 * A name that disappears, or changes meaning, is a release decision. Adding one
 * is a minor release; removing or renaming one needs a deprecation release
 * first and a major release after that. `docs/api.md` documents every name in
 * the list, and this test checks that too, so the reference cannot fall behind
 * the code.
 */

const entryName = "index.d.ts";

/** Every name a declaration file exports, values and types together. */
function declaredNames(contents: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of [
    /^export declare const ([A-Za-z0-9_]+)/gm,
    /^export declare function ([A-Za-z0-9_]+)/gm,
    /^export declare class ([A-Za-z0-9_]+)/gm,
    /^export interface ([A-Za-z0-9_]+)/gm,
    /^export type ([A-Za-z0-9_]+)/gm
  ]) {
    for (const match of contents.matchAll(pattern)) {
      names.add(match[1] as string);
    }
  }

  // A module can also pass a name through rather than declare it, which is how
  // `htmlToPayloadRichText` and the rich-text types reach the entry point.
  for (const match of contents.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const entry of (match[1] as string).split(",")) {
      const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }

  return names;
}

/** Resolve `export * from "./x.js"` against the declaration files beside it. */
async function surfaceFrom(directory: string, file: string): Promise<Set<string>> {
  const contents = await readFile(join(directory, file), "utf8");
  const names = declaredNames(contents);

  for (const line of contents.split("\n")) {
    const reexport = /^export \* from "\.\/([A-Za-z0-9_-]+)\.js";$/.exec(line.trim());
    if (reexport === null) continue;
    const module = await readFile(join(directory, `${reexport[1] as string}.d.ts`), "utf8");
    for (const name of declaredNames(module)) names.add(name);
  }

  return names;
}

test("the exported surface is the frozen list, and every name is documented", async () => {
  const declarations = new URL("../src/", import.meta.url);
  const directory = fileURLToPath(declarations);
  const baseline = JSON.parse(
    await readFile(join(process.cwd(), "test", "api-surface.json"), "utf8")
  ) as { readonly contractVersion: string; readonly exports: readonly string[] };

  const actual = [...(await surfaceFrom(directory, entryName))].sort();
  const expected = [...baseline.exports].sort();

  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    "The public surface changed. Decide whether the change is intended, then update test/api-surface.json and docs/api.md in the same commit."
  );

  assert.equal(baseline.contractVersion, "1.0");
  assert.equal(expected.length, new Set(expected).size, "the baseline lists each name once");

  const api = await readFile(join(process.cwd(), "docs", "api.md"), "utf8");
  const undocumented = actual.filter((name) => !api.includes(`\`${name}\``));
  assert.deepEqual(
    undocumented,
    [],
    "Every exported name needs an entry in docs/api.md. This is the reference a caller reads instead of the source."
  );
});
