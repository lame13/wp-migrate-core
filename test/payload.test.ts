import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { assertTargetEnabled, targetAdapters } from "../src/adapters.js";
import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generatePayloadBundle, htmlToPayloadRichText, renderPayloadImporter } from "../src/payload.js";
import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");
const fixturesRoot = dirname(resolve(demoFixturePath));

async function loadDemoProject() {
  return parseWxr(await readFile(demoFixturePath, "utf8"));
}

function extractFunction(source: string, name: string): string {
  const match = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\b[\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `the generated importer must define ${name}`);
  return match[0];
}

test("the destination boundary names each target's kind and refuses the planned ones", () => {
  assert.equal(targetAdapters.astro.kind, "static-site");
  assert.equal(targetAdapters.next.kind, "static-site");
  assert.equal(targetAdapters.payload.kind, "cms");
  assert.equal(targetAdapters.pruvious.kind, "cms");
  assert.doesNotThrow(() => assertTargetEnabled("astro"));
  assert.doesNotThrow(() => assertTargetEnabled("next"));
  assert.doesNotThrow(() => assertTargetEnabled("payload"));
  assert.doesNotThrow(() => assertTargetEnabled("pruvious"));
  for (const target of ["nuxt", "svelte"] as const) {
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

  const paragraph = root.children[1]! as { children: { type: string; text?: string; format?: number; fields?: object }[] };
  const bold = paragraph.children.find((node) => node.text === "bold");
  assert.equal(bold?.format, 1, "strong maps to the bold format bit");
  const link = paragraph.children.find((node) => node.type === "link");
  assert.deepEqual(link?.fields, { url: "/x", linkType: "custom", newTab: false });

  assert.deepEqual(
    review.map((item) => item.kind).sort(),
    ["img", "shortcode"],
    "an image and a shortcode become review items rather than guesses"
  );
});

test("preformatted code uses nodes supported by Payload's default editor", () => {
  const { body } = htmlToPayloadRichText("<pre><code>const x = 1;\nprint(x);</code></pre>");
  const root = body.root as { children: { type: string; children: { type: string; text?: string; format?: number }[] }[] };
  assert.equal(root.children[0]?.type, "paragraph");
  assert.deepEqual(root.children[0]?.children.map(({ type, text, format }) => ({ type, text, format })), [
    { type: "text", text: "const x = 1;", format: 16 },
    { type: "linebreak", text: undefined, format: undefined },
    { type: "text", text: "print(x);", format: 16 }
  ]);
});

test("nested lists keep their hierarchy, following text and ordered start", () => {
  const { body } = htmlToPayloadRichText('<ol start="3"><li>parent<ul><li>nested</li></ul>after</li><li>next</li></ol>');
  const root = body.root as { children: { start: number; children: { value: number; children: { type: string; text?: string; children?: unknown[] }[] }[] }[] };
  const list = root.children[0]!;
  assert.equal(list.start, 3);
  assert.deepEqual(list.children.map((item) => item.value), [3, 4]);
  assert.deepEqual(list.children[0]?.children.map((node) => node.type), ["text", "list", "text"]);
  assert.equal(list.children[0]?.children[2]?.text, "after");
  assert.match(JSON.stringify(list.children[0]?.children[1]), /nested/);
});

test("Next redirects match literal paths without matching their destinations", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-redirects-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const parsed = await loadDemoProject();
  const project = { ...parsed, routes: { ...parsed.routes, redirects: [
    { id: "slash", sourcePath: "/old", targetRoute: "/old/", reason: "normalization" },
    { id: "literal", sourcePath: "/a(b):c+", targetRoute: "/new/", reason: "normalization" }
  ] } };
  const bundle = join(workspace, "bundle");
  await generatePayloadBundle(project, bundle);
  // The generated config imports Payload's own Next wrapper. Stub it so this
  // check stays about the redirect rules and does not install Payload.
  const stub = join(workspace, "node_modules/@payloadcms/next");
  await mkdir(stub, { recursive: true });
  await writeFile(
    join(stub, "package.json"),
    JSON.stringify({ name: "@payloadcms/next", type: "module", exports: { "./withPayload": "./withPayload.js" } })
  );
  await writeFile(join(stub, "withPayload.js"), "export const withPayload = (config) => config;\nexport default withPayload;\n");
  const { default: config } = await import(pathToFileURL(join(bundle, "next.config.mjs")).href);
  assert.equal(config.skipTrailingSlashRedirect, true);
  const rules = await config.redirects();
  for (const [index, rule] of rules.entries()) {
    const pattern = new RegExp("^/" + rule.source.slice(2, -1));
    assert.ok(pattern.test(project.routes.redirects[index]!.sourcePath));
    assert.ok(!pattern.test(rule.destination));
  }
  assert.deepEqual(JSON.parse(await readFile(join(bundle, "import/redirects.json"), "utf8")).redirects, rules);
});

function contentItem(id: number, type: string, status = "publish", extra = ""): string {
  return `<item><title>Item ${id}</title><link>https://example.test/item-${id}/</link>
    <wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type><wp:status>${status}</wp:status>
    <wp:post_name>item-${id}</wp:post_name>${extra}</item>`;
}

test("Payload preserves custom terms without jobs for nonexistent collections and keeps unpublished records as drafts", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-mapping-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const items = ["publish", "private", "future", "draft", "pending"].map((status, index) => contentItem(
    index + 1, "post", status,
    '<category domain="genre" nicename="fiction">Fiction</category><wp:post_date_gmt>2026-10-08 12:34:56</wp:post_date_gmt>'
  ));
  const project = parseWxr(`<rss><channel><title><![CDATA[Title */ test]]></title>${items.join("")}</channel></rss>`, { includeDrafts: true });
  const xml = join(workspace, "export.xml");
  await writeFile(xml, `<rss><channel>${items.join("")}</channel></rss>`);
  const bundle = join(workspace, "bundle");
  const converted = spawnSync(process.execPath, [cliPath, "convert", xml, "--include-drafts", "--target", "payload", "--out", bundle], {
    encoding: "utf8", env: { ...process.env, TZ: "Asia/Bangkok" }
  });
  assert.equal(converted.status, 0, converted.stderr);
  const jobs = JSON.parse(await readFile(join(bundle, "import/content/posts.json"), "utf8"));
  assert.deepEqual(jobs.map((job: { data: { _status: string } }) => job.data._status), ["published", "draft", "draft", "draft", "draft"]);
  assert.equal(jobs[0].data.publishedAt, "2026-10-08T12:34:56.000Z");
  assert.deepEqual(jobs[0].data.wordpressTerms, [{ domain: "genre", name: "Fiction", slug: "fiction" }]);
  const index = JSON.parse(await readFile(join(bundle, "import/content/index.json"), "utf8"));
  assert.deepEqual(index.files.map((entry: { collection: string }) => entry.collection), ["posts"]);

  const commentsBundle = join(workspace, "comments");
  await generatePayloadBundle(project, commentsBundle);
  for (const file of ["payload.config.js", "import/import.mjs"]) {
    const checked = spawnSync(process.execPath, ["--check", join(commentsBundle, file)], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test("Payload refuses collection collisions before writing output", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-collision-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  for (const types of [["author"], ["categories"], ["user"], ["foo-1", "foo1"]]) {
    const project = parseWxr(`<rss><channel>${types.map((type, index) => contentItem(index + 1, type)).join("")}</channel></rss>`);
    const bundle = join(workspace, types.join("-"));
    await assert.rejects(() => generatePayloadBundle(project, bundle), /collection name collision/);
    await assert.rejects(() => stat(bundle), { code: "ENOENT" });
  }
  const numeric = parseWxr(`<rss><channel>${contentItem(1, "123")}</channel></rss>`);
  await generatePayloadBundle(numeric, join(workspace, "numeric"));
  const checked = spawnSync(process.execPath, ["--check", join(workspace, "numeric/payload.config.js")], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("the importer updates source changes, clears removed fields, and preserves CMS edits and drafts", async () => {
  const source = renderPayloadImporter(await loadDemoProject());
  const names = ["stableStringify", "managedFieldsHash", "resolveReferences", "projectFields", "upsert"];
  const upsert = new Function("createHash", "resolve", "bundleRoot", names.map((name) => extractFunction(source, name)).join("\n") + "\nreturn upsert;")(
    createHash, resolve, "/unused"
  ) as (payload: object, entry: object, job: object, ids: object, counters: Record<string, number>, records: { action: string }[]) => Promise<void>;
  let saved: Record<string, unknown> | undefined;
  let draft: Record<string, unknown> | undefined;
  const payload = {
    async find(options: { draft: boolean }) {
      assert.equal(options.draft, true);
      const doc = draft ?? saved;
      return { docs: doc === undefined ? [] : [doc] };
    },
    async create({ data }: { data: Record<string, unknown> }) {
      saved = { ...structuredClone(data), id: 42, contentReview: [{ id: "payload-row-id", kind: "img" }] };
      return saved;
    },
    async update({ data }: { data: Record<string, unknown> }) {
      saved = { ...saved, ...structuredClone(data) };
      return saved;
    }
  };
  let data: Record<string, unknown> = { wordpressSourceId: "wp:post:1", title: "Original", author: 9, contentReview: [{ kind: "img" }] };
  const run = async () => {
    const counters = { created: 0, updated: 0, unchanged: 0, skipped: 0, unresolved: 0 };
    const records: { action: string }[] = [];
    await upsert(payload, { collection: "posts" }, { wordpressSourceId: "wp:post:1", data }, {}, counters, records);
    return records[0]!.action;
  };
  assert.equal(await run(), "created");
  assert.equal(await run(), "unchanged", "Payload array row IDs do not count as edits");
  data = { ...data, title: "Changed source", tags: [4] };
  delete data.author;
  assert.equal(await run(), "updated", "adding and removing fields must not look like a CMS edit");
  assert.equal(saved?.author, null);
  assert.equal(saved?.title, "Changed source");
  saved!.title = "CMS edit";
  assert.equal(await run(), "skipped", "the same source hash must not hide CMS edits");
  data = { ...data, title: "Another source edit" };
  assert.equal(await run(), "skipped");
  assert.equal(saved!.title, "CMS edit");
  saved!.title = "Changed source";
  draft = { ...saved, title: "Unpublished CMS edit" };
  assert.equal(await run(), "skipped", "read the latest draft before updating a published record");
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
  assert.equal(manifest.schemaVersion, "0.11");
  assert.equal(manifest.generator.target, "payload");
  assert.equal(manifest.destination.kind, "cms");
  assert.equal(manifest.destination.structure, "payload-next");
  assert.equal(manifest.destination.payloadVersion, "3.90.2");
  assert.equal(manifest.destination.config, "payload.config.js");
  assert.equal(manifest.destination.admin, "app/(payload)");
  assert.equal(manifest.destination.importer, "import/import.mjs");
  assert.equal(manifest.targets.payload.kind, "cms");
  assert.equal(manifest.targets.astro.kind, "static-site");
  assert.equal(manifest.targets.svelte.enabled, false);
  assert.equal(manifest.records.length, project.records.length);

  // One module per content collection, plus the shared ones.
  await Promise.all(
    ["Pages.mjs", "Posts.mjs", "Media.mjs", "Categories.mjs", "Tags.mjs", "Authors.mjs", "Navigation.mjs"].map((file) =>
      stat(join(bundle, "collections", file))
    )
  );
  const config = await readFile(join(bundle, "payload.config.js"), "utf8");
  assert.match(config, /buildConfig/);
  assert.match(config, /lexicalEditor/);
  assert.match(config, /Pages/);

  // The bundle is a runnable Payload + Next app, not only a config: the admin
  // host, the scripts that start it and the env file are all written.
  await Promise.all(
    [
      "app/(payload)/layout.jsx",
      "app/(payload)/custom.css",
      "app/(payload)/admin/importMap.js",
      "app/(payload)/admin/[[...segments]]/page.jsx",
      "app/(payload)/admin/[[...segments]]/not-found.jsx",
      "app/(payload)/api/[...slug]/route.js",
      "app/(payload)/api/graphql/route.js",
      "app/(payload)/api/graphql-playground/route.js",
      ".env.example",
      ".gitignore",
      "tsconfig.json"
    ].map((file) => stat(join(bundle, file)))
  );
  const packageJson = JSON.parse(await readFile(join(bundle, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.payload, "3.90.2");
  assert.equal(packageJson.dependencies.next, "^16.3.3");
  assert.equal(packageJson.devDependencies.typescript, "^7.0.0");
  assert.match(packageJson.scripts.dev, /next dev/);
  assert.match(packageJson.scripts.build, /next build/);
  assert.equal(packageJson.scripts.import, "payload run import/import.mjs");

  // The drop resolves relationships through the same stable ids the manifest uses.
  const pages = JSON.parse(await readFile(join(bundle, "import/content/pages.json"), "utf8"));
  assert.equal(pages.length, project.records.filter((record) => record.type === "page").length);
  const posts = JSON.parse(await readFile(join(bundle, "import/content/posts.json"), "utf8"));
  const serialized = JSON.stringify([...pages, ...posts]);
  assert.match(serialized, /"\$ref":\s*"wp:author:niko"/);
  assert.match(serialized, /"\$ref":\s*"wp:term:category:guides"/, "the post's category becomes a relationship");

  // A body image the run delivered becomes a media node; one it did not stays
  // a review row rather than pointing at a record that will never exist.
  const tapPost = posts.find((job: { wordpressSourceId: string }) => job.wordpressSourceId === "wp:post:20");
  assert.match(JSON.stringify(tapPost.data.body), /"type":"upload"/, "the delivered body image is a media node");
  assert.match(JSON.stringify(tapPost.data.body), /"\$ref":"media:302"/);
  assert.equal(tapPost.data.body.root.children.filter((node: { type: string }) => node.type === "upload").length, 1);
  assert.ok(
    !tapPost.data.contentReview.some((item: { kind: string }) => item.kind === "img"),
    "a delivered image is not also left in the review queue"
  );
  const contactPage = pages.find((job: { wordpressSourceId: string }) => job.wordpressSourceId === "wp:page:12");
  assert.ok(
    contactPage.data.contentReview.some((item: { kind: string }) => item.kind === "img"),
    "an image with no delivered upload stays a review row"
  );

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
  assert.match(nextConfig, /withPayload/, "a Next + Payload app needs the Payload wrapper, not only redirects");
  assert.match(nextConfig, /async redirects\(\)/);
  const redirects = JSON.parse(await readFile(join(bundle, "import/redirects.json"), "utf8"));
  assert.equal(redirects.redirects.length, project.routes.redirects.length);
});

test("an image the importer can link becomes a media node, and one it cannot stays review", () => {
  const tap = "https://example.test/wp-content/uploads/2026/05/tap-768x512.jpg";
  const { body, review } = htmlToPayloadRichText(
    `<figure><img src="${tap}" alt="Tap handle removed"></figure>` +
      '<p>before <img src="/other.jpg" alt=""> after</p>',
    new Map(),
    (image) => (image.src === tap ? { sourceId: "media:302", ...(image.alt === undefined ? {} : { alt: image.alt }) } : undefined)
  );

  const root = body.root as { children: { type: string; children?: { type: string; text?: string }[]; value?: unknown; fields?: unknown; relationTo?: string; id?: string }[] };
  assert.deepEqual(root.children.map((child) => child.type), ["upload", "paragraph"]);
  const upload = root.children[0]!;
  assert.equal(upload.relationTo, "media");
  assert.deepEqual(upload.value, { $ref: "media:302" });
  assert.deepEqual(upload.fields, { alt: "Tap handle removed" });
  assert.equal(upload.id, "upload-1");
  assert.deepEqual(root.children[1]?.children?.map((node) => node.text), ["before ", " after"]);
  assert.deepEqual(review.map((item) => item.kind), ["img"], "the image with no delivered upload is still a review row");
});

test("a paragraph's image splits the paragraph instead of nesting a block node", () => {
  const { body } = htmlToPayloadRichText(
    '<p>before <img src="/tap.jpg"> after</p>',
    new Map(),
    () => ({ sourceId: "media:302" })
  );
  const root = body.root as { children: { type: string; children?: { type: string; text?: string }[] }[] };
  assert.deepEqual(root.children.map((child) => child.type), ["paragraph", "upload", "paragraph"]);
  assert.equal(root.children[0]?.children?.[0]?.text, "before ");
  assert.equal(root.children[2]?.children?.[0]?.text, " after");
});

test("linked images convert and use real src and alt attributes", () => {
  const seen: unknown[] = [];
  const { body, review } = htmlToPayloadRichText(
    '<figure><a href="/full.jpg"><img data-src="/lazy.jpg" src="/real.jpg" data-alt="Wrong" alt="Right"></a></figure>',
    new Map(),
    (image) => {
      seen.push(image);
      return { sourceId: "media:302", ...(image.alt === undefined ? {} : { alt: image.alt }) };
    }
  );
  assert.deepEqual(seen, [{ src: "/real.jpg", alt: "Right" }]);
  assert.deepEqual((body.root as { children: { type: string }[] }).children.map((node) => node.type), ["upload"]);
  assert.deepEqual(review, []);
});

test("body image matching keeps different hosts and exact attachment paths distinct", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-images-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = await loadDemoProject();
  const record = base.records.find((record) => record.sourceId === "wp:post:20")!;
  const html = '<p><img src="https://brightpath.example/wp-content/uploads/2026/05/tap-768x512.jpg">' +
    '<img src="https://other.example/wp-content/uploads/2026/05/tap.jpg">' +
    '<img src="https://brightpath.example/wp-content/uploads/2026/05/tap.jpg">' +
    '<img src="/wp-content/uploads/2026/05/tap.jpg?version=1">' +
    '<img src="//brightpath.example/wp-content/uploads/2026/05/tap.jpg">' +
    '<img src="//other.example/wp-content/uploads/2026/05/tap.jpg">' +
    '<img src="https://brightpath.example/wp-content/uploads/2026/05/tap-640x480.jpg"></p>';
  const project = applyMediaDelivery(base, await planMediaDelivery(base, { uploadsDirectory: join(fixturesRoot, "uploads") }));
  const reference = project.media.references.find((ref) => ref.sourceId === record.sourceId && ref.assetId === "media:302")!;
  const changed = {
    ...project,
    records: [{ ...record, rawContent: html, nodes: [] }],
    media: { ...project.media, references: [
      { ...reference, url: "https://brightpath.example/wp-content/uploads/2026/05/tap-768x512.jpg", path: "/wp-content/uploads/2026/05/tap-768x512.jpg" },
      { ...reference, assetId: "media:304", url: "https://brightpath.example/wp-content/uploads/2026/05/tap.jpg", path: "/wp-content/uploads/2026/05/tap.jpg" }
    ] }
  };
  await generatePayloadBundle(changed, join(workspace, "bundle"));
  const [job] = JSON.parse(await readFile(join(workspace, "bundle/import/content/posts.json"), "utf8"));
  const uploads = job.data.body.root.children.filter((node: { type: string }) => node.type === "upload");
  assert.deepEqual(uploads.map((node: { value: unknown }) => node.value), [
    { $ref: "media:302" }, { $ref: "media:304" }, { $ref: "media:304" }, { $ref: "media:304" }
  ]);
  assert.equal(job.data.contentReview.filter((row: { kind: string }) => row.kind === "img").length, 3);
});

test("Payload refuses duplicate routes before writing output", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-route-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const item = (id: number) =>
    `<item><title>Same route</title><wp:post_id>${id}</wp:post_id><wp:post_type>post</wp:post_type>` +
    `<wp:status>publish</wp:status><wp:post_name>same</wp:post_name></item>`;
  const project = parseWxr(`<rss><channel>${item(11)}${item(12)}</channel></rss>`);
  const bundle = join(workspace, "bundle");
  await assert.rejects(() => generatePayloadBundle(project, bundle), /duplicate route/);
  await assert.rejects(() => stat(bundle), { code: "ENOENT" });
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
  assert.deepEqual(unresolved.data, { featuredImage: null }, "an unresolved reference stays empty, not a fake id");
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

  const unavailableDemo = spawnSync(process.execPath, [cliPath, "demo", "--target", "svelte", "--out", "unavailable-demo"], {
    cwd: workspace, encoding: "utf8"
  });
  assert.notEqual(unavailableDemo.status, 0);
  await assert.rejects(() => stat(join(workspace, "unavailable-demo")), { code: "ENOENT" });
});

function menuXml(options: {
  readonly id: number;
  readonly title: string;
  readonly order: number;
  readonly type: string;
  readonly object?: string;
  readonly objectId?: number;
  readonly url?: string;
  readonly parent?: number;
}): string {
  const meta = (key: string, value: string): string =>
    `<wp:postmeta><wp:meta_key>${key}</wp:meta_key><wp:meta_value>${value}</wp:meta_value></wp:postmeta>`;
  return [
    "<item>",
    `<title>${options.title}</title>`,
    `<wp:post_id>${options.id}</wp:post_id>`,
    "<wp:post_type>nav_menu_item</wp:post_type>",
    "<wp:status>publish</wp:status>",
    `<wp:menu_order>${options.order}</wp:menu_order>`,
    '<category domain="nav_menu" nicename="primary"><![CDATA[Primary]]></category>',
    meta("_menu_item_type", options.type),
    ...(options.object === undefined ? [] : [meta("_menu_item_object", options.object)]),
    ...(options.objectId === undefined ? [] : [meta("_menu_item_object_id", String(options.objectId))]),
    ...(options.url === undefined ? [] : [meta("_menu_item_url", options.url)]),
    ...(options.parent === undefined ? [] : [meta("_menu_item_menu_item_parent", String(options.parent))]),
    "</item>"
  ].join("");
}

test("the Payload bundle turns the WordPress menu into an editable collection", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-menu-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const project = parseWxr(
    `<rss><channel>${contentItem(1, "page")}${menuXml({
      id: 500,
      title: "Home",
      order: 1,
      type: "post_type",
      object: "page",
      objectId: 1
    })}${menuXml({
      id: 501,
      title: "Elsewhere",
      order: 2,
      type: "custom",
      url: "https://elsewhere.test/",
      parent: 500
    })}${[502, 503, 504, 505].map((id) => menuXml({ id, title: `Level ${id}`, order: id, type: "custom", url: "https://elsewhere.test/", parent: id - 1 })).join("")}</channel></rss>`
  );
  assert.ok(project.menus.trees.length > 0, "the fixture carries a menu");

  const bundle = join(workspace, "bundle");
  await generatePayloadBundle(project, bundle);

  const module = await readFile(join(bundle, "collections/Navigation.mjs"), "utf8");
  assert.match(module, /"slug":\s*"navigation"/);
  assert.match(module, /"wordpressSourceId"/);
  assert.match(module, /"children"/, "the tree nests rather than flattening");
  const { default: collection } = await import(pathToFileURL(join(bundle, "collections/Navigation.mjs")).href);
  let fields = collection.fields.find((field: { name: string }) => field.name === "items").fields;
  for (let depth = 0; depth < 5; depth += 1) {
    fields = fields.find((field: { name: string }) => field.name === "children").fields;
  }
  assert.ok(fields.some((field: { name: string }) => field.name === "label"), "deep menu entries have fields rather than being dropped");

  const drop = JSON.parse(await readFile(join(bundle, "import/content/navigation.json"), "utf8"));
  assert.equal(drop.length, project.menus.trees.length);
  assert.equal(drop[0].collection, "navigation");
  assert.match(JSON.stringify(drop[0].data), /"label":"Home"/);

  const index = JSON.parse(await readFile(join(bundle, "import/content/index.json"), "utf8"));
  assert.ok(
    index.files.some((file: { collection: string }) => file.collection === "navigation"),
    "the importer loads the menu"
  );
  const manifest = JSON.parse(await readFile(join(bundle, "migration/manifest.json"), "utf8"));
  assert.equal(manifest.destination.admin, "app/(payload)");
  assert.ok(
    manifest.collections.some((collection: { slug: string }) => collection.slug === "navigation"),
    "the manifest lists the navigation collection"
  );
});

test("a link to an uploaded file travels with the site and becomes media", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-file-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const uploads = join(workspace, "uploads");
  await mkdir(join(uploads, "2026/05"), { recursive: true });
  await writeFile(join(uploads, "2026/05/price-list.pdf"), "PDF placeholder bytes");

  const page = [
    "<item>",
    "<title>Pricing</title>",
    "<link>https://example.test/pricing/</link>",
    "<wp:post_id>1</wp:post_id>",
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>pricing</wp:post_name>",
    '<content:encoded><![CDATA[<p><a href="https://example.test/wp-content/uploads/2026/05/price-list.pdf">Price list</a></p>]]></content:encoded>',
    "</item>"
  ].join("");
  const attachment = [
    "<item><title>Price list</title><wp:post_id>401</wp:post_id>",
    "<wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>",
    "<wp:attachment_url>https://example.test/wp-content/uploads/2026/05/price-list.pdf</wp:attachment_url>",
    "<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/05/price-list.pdf</wp:meta_value></wp:postmeta>",
    "</item>"
  ].join("");

  const parsed = parseWxr(`<rss><channel>${page}${attachment}</channel></rss>`);
  const reference = parsed.media.references.find((entry) => entry.kind === "linked-file");
  assert.ok(reference, "a link to an uploaded file is tracked as a media reference");
  assert.equal(reference.status, "matched");
  assert.equal(reference.assetId, "media:401");

  const project = applyMediaDelivery(parsed, await planMediaDelivery(parsed, { uploadsDirectory: uploads }));
  const bundle = join(workspace, "bundle");
  await generatePayloadBundle(project, bundle);

  await stat(join(bundle, "import/media/public/wp-content/uploads/2026/05/price-list.pdf"));
  const media = JSON.parse(await readFile(join(bundle, "import/content/media.json"), "utf8"));
  assert.ok(
    media.some((job: { wordpressSourceId: string }) => job.wordpressSourceId === "media:401"),
    "the linked file becomes an importable media record"
  );
  await stat(join(bundle, "public/wp-content/uploads/2026/05/price-list.pdf"));
  const pages = await readFile(join(bundle, "import/content/pages.json"), "utf8");
  assert.match(pages, /"url": "\/wp-content\/uploads\/2026\/05\/price-list.pdf"/);
  const astro = join(workspace, "astro");
  await generateAstroProject(project, astro);
  const markdown = await readFile(join(astro, "src/content/pages/pricing.md"), "utf8");
  assert.match(markdown, /href="\/wp-content\/uploads\/2026\/05\/price-list.pdf"/);
});

test("the importer re-uploads a media record whose delivered file changed", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-payload-mediahash-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const bundleRoot = join(workspace, "bundle");
  const relative = "import/media/public/wp-content/uploads/2026/05/hero.jpg";
  await mkdir(join(bundleRoot, "import/media/public/wp-content/uploads/2026/05"), { recursive: true });
  const filePath = join(bundleRoot, relative);
  await writeFile(filePath, "first bytes");

  const source = renderPayloadImporter(await loadDemoProject());
  const names = ["stableStringify", "managedFieldsHash", "resolveReferences", "projectFields", "messageOf", "fileDigest", "upsert"];
  const upsert = new Function(
    "createHash",
    "readFile",
    "resolve",
    "bundleRoot",
    names.map((name) => extractFunction(source, name)).join("\n") + "\nreturn upsert;"
  )(createHash, readFile, resolve, bundleRoot) as (
    payload: object,
    entry: object,
    job: object,
    ids: object,
    counters: Record<string, number>,
    records: { action: string }[]
  ) => Promise<void>;

  let saved: Record<string, unknown> | undefined;
  const payload = {
    async find() {
      return { docs: saved === undefined ? [] : [saved] };
    },
    async create({ data }: { data: Record<string, unknown> }) {
      saved = { ...structuredClone(data), id: 7 };
      return saved;
    },
    async update({ data }: { data: Record<string, unknown> }) {
      saved = { ...saved, ...structuredClone(data) };
      return saved;
    }
  };
  const job = { wordpressSourceId: "media:301", data: { wordpressSourceId: "media:301" }, file: relative };
  const run = async (): Promise<string> => {
    const counters = { created: 0, updated: 0, unchanged: 0, skipped: 0, unresolved: 0 };
    const records: { action: string }[] = [];
    await upsert(payload, { collection: "media" }, job, {}, counters, records);
    return records[0]!.action;
  };

  assert.equal(await run(), "created");
  assert.equal(await run(), "unchanged", "the same file and fields are unchanged");
  await writeFile(filePath, "second, different bytes");
  assert.equal(await run(), "updated", "a replaced file re-uploads instead of reading as unchanged");

  const importer = renderPayloadImporter(await loadDemoProject());
  assert.match(importer, /WP_MIGRATE_IMPORT_REPORT/, "the report path is overridable and defaults to the bundle");
  assert.match(importer, /Cannot read the drop index/, "a missing index still leaves a report");
});

test("the Payload importer writes failed-drop reports at the bundle or explicit file path", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-payload-report-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const here = join(workspace, "import");
  await mkdir(join(here, "content"), { recursive: true });
  const source = renderPayloadImporter(await loadDemoProject());
  const functions = source.slice(source.indexOf("function stableStringify"), source.indexOf("\nawait main().catch"));
  const env: Record<string, string> = {};
  let destroyed = 0;
  const main = new Function("getPayload", "config", "readFile", "writeFile", "resolve", "here", "bundleRoot", "process", "console", functions + "\nreturn main;")(
    async () => ({ async destroy() { destroyed += 1; } }), {}, readFile, writeFile, resolve, here, workspace,
    { env }, { log() {} }
  ) as () => Promise<void>;
  await assert.rejects(main, /1 record\(s\) failed/);
  const report = JSON.parse(await readFile(join(workspace, "migration-import.json"), "utf8"));
  assert.equal(report.summary.failed, 1);
  assert.match(report.records[0].reason, /Cannot read the drop index/);
  env.WP_MIGRATE_IMPORT_REPORT = join(workspace, "custom.json");
  await writeFile(join(here, "content/index.json"), '{"files":[{"collection":"posts","file":"content/posts.json"}]}');
  await assert.rejects(main, /1 record\(s\) failed/);
  assert.match(JSON.parse(await readFile(env.WP_MIGRATE_IMPORT_REPORT, "utf8")).records[0].reason, /Cannot read content\/posts.json/);
  await writeFile(join(here, "content/index.json"), '{"files":{}}');
  await assert.rejects(main, /1 record\(s\) failed/);
  assert.equal(destroyed, 3, "each failure releases the CMS connection");
});

test("download links do not hide missing alt text on the same image", () => {
  const url = "https://example.test/wp-content/uploads/photo.jpg";
  const project = parseWxr(`<rss><channel>
    <item><title>Photo</title><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
    <content:encoded><![CDATA[<!-- wp:image --><a title="Photo > original" href="${url}"><img src="${url}"></a><!-- /wp:image -->]]></content:encoded></item>
    <item><wp:post_id>2</wp:post_id><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><wp:attachment_url>${url}</wp:attachment_url></item>
  </channel></rss>`);
  assert.equal(project.media.references.find((reference) => reference.kind === "linked-file")?.status, "matched");
  assert.ok(project.media.references.some((reference) => reference.kind !== "linked-file" && reference.status === "missing-alt-text"));
});
