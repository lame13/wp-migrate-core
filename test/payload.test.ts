import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { assertTargetEnabled, targetAdapters } from "../src/adapters.js";
import { parseWxr } from "../src/core.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generatePayloadBundle, htmlToPayloadRichText, renderPayloadImporter } from "../src/payload.js";
import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");
const fixturesRoot = dirname(resolve(demoFixturePath));

async function loadDemoProject() {
  return parseWxr(await readFile(demoFixturePath, "utf8"));
}

function extractFunction(source: string, name: string): string {
  const match = new RegExp(`(?:^|\\n)function ${name}\\b[\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `the generated importer must define ${name}`);
  return match[0];
}

test("the destination boundary names each target's kind and refuses the planned ones", () => {
  assert.equal(targetAdapters.astro.kind, "static-site");
  assert.equal(targetAdapters.payload.kind, "cms");
  assert.doesNotThrow(() => assertTargetEnabled("astro"));
  assert.doesNotThrow(() => assertTargetEnabled("payload"));
  for (const target of ["next", "nuxt", "svelte"] as const) {
    assert.throws(() => assertTargetEnabled(target), /planned but not available/);
  }
});

test("converts the documented HTML subset and marks everything else for review", () => {
  const { body, review } = htmlToPayloadRichText(
    "<h2>Title</h2>" +
      '<p>Hello <strong>bold</strong> and <a href="/x">a link</a>.</p>' +
      "<ul><li>one</li><li>two</li></ul>" +
      '<img src="/a.jpg">' +
      '<p>[gallery id="1"]</p>'
  );

  const root = body.root as { children: { type: string; children?: unknown[] }[] };
  assert.deepEqual(
    root.children.map((child) => child.type),
    ["heading", "paragraph", "list", "paragraph"]
  );

  const paragraph = root.children[1]! as { children: { type: string; text?: string; format?: number; url?: string }[] };
  const bold = paragraph.children.find((node) => node.text === "bold");
  assert.equal(bold?.format, 1, "strong maps to the bold format bit");
  const link = paragraph.children.find((node) => node.type === "link");
  assert.equal(link?.url, "/x");

  assert.deepEqual(
    review.map((item) => item.kind).sort(),
    ["img", "shortcode"],
    "an image and a shortcode become review items rather than guesses"
  );
});

test("writes a Payload bundle with collections, a drop and an importer", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const bundle = join(output, "bundle");

  const parsed = await loadDemoProject();
  const plan = await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") });
  const project = applyMediaDelivery(parsed, plan);
  await generatePayloadBundle(project, bundle);

  const manifest = JSON.parse(await readFile(join(bundle, "migration/manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "0.9");
  assert.equal(manifest.generator.target, "payload");
  assert.equal(manifest.destination.kind, "cms");
  assert.equal(manifest.destination.structure, "payload-next");
  assert.equal(manifest.destination.payloadVersion, "^3.0.0");
  assert.equal(manifest.destination.importer, "import/import.mjs");
  assert.equal(manifest.targets.payload.kind, "cms");
  assert.equal(manifest.targets.astro.kind, "static-site");
  assert.equal(manifest.targets.svelte.enabled, false);
  assert.equal(manifest.records.length, project.records.length);

  // One module per content collection, plus the shared ones.
  await Promise.all(
    ["Pages.mjs", "Posts.mjs", "Media.mjs", "Categories.mjs", "Tags.mjs", "Authors.mjs"].map((file) =>
      stat(join(bundle, "collections", file))
    )
  );
  const config = await readFile(join(bundle, "payload.config.mjs"), "utf8");
  assert.match(config, /buildConfig/);
  assert.match(config, /lexicalEditor/);
  assert.match(config, /Pages/);

  // The drop resolves relationships through the same stable ids the manifest uses.
  const pages = JSON.parse(await readFile(join(bundle, "import/content/pages.json"), "utf8"));
  assert.equal(pages.length, project.records.filter((record) => record.type === "page").length);
  const posts = JSON.parse(await readFile(join(bundle, "import/content/posts.json"), "utf8"));
  const serialized = JSON.stringify([...pages, ...posts]);
  assert.match(serialized, /"\$ref":\s*"wp:author:niko"/);
  assert.match(serialized, /"\$ref":\s*"wp:term:category:guides"/, "the post's category becomes a relationship");

  const index = JSON.parse(await readFile(join(bundle, "import/content/index.json"), "utf8"));
  assert.equal(index.schemaVersion, "0.9");
  const loadedCollections = index.files.map((file: { collection: string }) => file.collection);
  assert.equal(loadedCollections[0], "categories", "taxonomies load before the content that references them");
  const mediaIndex = loadedCollections.indexOf("media");
  for (const name of ["pages", "posts"]) {
    const index = loadedCollections.indexOf(name);
    if (index >= 0) assert.ok(mediaIndex < index, "media loads before the content that references it");
  }

  // The importer is self-contained and reports the failure mode it guards.
  const importer = await readFile(join(bundle, "import/import.mjs"), "utf8");
  assert.match(importer, /from "payload"/);
  assert.match(importer, /migration-import\.json/);
  assert.match(importer, /record-modified/);

  // Delivered media is copied into the bundle, and the redirect map is written
  // where a Next front end and the common hosts can read it.
  await stat(join(bundle, "import/media/public/wp-content/uploads/2026/05/hero.jpg"));
  const nextConfig = await readFile(join(bundle, "next.config.mjs"), "utf8");
  assert.match(nextConfig, /async redirects\(\)/);
  const redirects = JSON.parse(await readFile(join(bundle, "import/redirects.json"), "utf8"));
  assert.equal(redirects.redirects.length, project.routes.redirects.length);
});

test("the generated importer's hash and reference logic behave as the drop expects", async () => {
  const project = await loadDemoProject();
  const source = renderPayloadImporter(project);

  const factory = new Function(
    "createHash",
    `${extractFunction(source, "stableStringify")}\n${extractFunction(source, "managedFieldsHash")}\n` +
      `${extractFunction(source, "resolveReferences")}\nreturn { stableStringify, managedFieldsHash, resolveReferences };`
  ) as (hash: typeof createHash) => {
    stableStringify: (value: unknown) => string;
    managedFieldsHash: (value: unknown) => string;
    resolveReferences: (value: unknown, ids: Record<string, number>) => { data: unknown; missing: string[] };
  };
  const { stableStringify, managedFieldsHash, resolveReferences } = factory(createHash);

  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}', "key order cannot change the hash");
  assert.equal(managedFieldsHash({ a: [1, 2] }), managedFieldsHash({ a: [1, 2] }));
  assert.notEqual(managedFieldsHash({ a: [1, 2] }), managedFieldsHash({ a: [1, 3] }));

  const resolved = resolveReferences({ author: { $ref: "wp:author:niko" }, tags: [{ $ref: "wp:term:post_tag:repair" }] }, {
    "wp:author:niko": 7,
    "wp:term:post_tag:repair": 3
  });
  assert.deepEqual(resolved.data, { author: 7, tags: [3] });
  assert.deepEqual(resolved.missing, []);

  const unresolved = resolveReferences({ featuredImage: { $ref: "media:99" } }, {});
  assert.deepEqual(unresolved.data, {}, "an unresolved reference is dropped, not left as a fake id");
  assert.deepEqual(unresolved.missing, ["media:99"]);
});

test("convert --target payload writes a bundle through the installed executable", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [cliPath, "convert", demoFixturePath, "--out", "bundle", "--target", "payload", "--uploads", join(fixturesRoot, "uploads"), "--json"],
    { cwd: workspace, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.command, "convert");

  const manifest = JSON.parse(await readFile(join(workspace, "bundle/migration/manifest.json"), "utf8"));
  assert.equal(manifest.generator.target, "payload");
  assert.equal(manifest.destination.kind, "cms");

  const unavailable = spawnSync(
    process.execPath,
    [cliPath, "convert", demoFixturePath, "--out", "other", "--target", "svelte"],
    { cwd: workspace, encoding: "utf8" }
  );
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /planned but not available/);
});
