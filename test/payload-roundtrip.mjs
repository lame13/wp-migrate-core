#!/usr/bin/env node
/**
 * The Payload round trip, run on demand with `npm run test:payload`.
 *
 * The package's own test suite never boots Payload: it checks the generated
 * bundle as text. This script is the other half — it installs the Payload
 * release the bundle is written for, imports the demo export into a real
 * SQLite database, opens the admin host, and asserts the things a text check
 * cannot: that a repeated import is a no-op, that a source change updates and a
 * CMS edit is protected, that a delivered body image is a real media node, and
 * that `next build` compiles the generated app.
 *
 * It installs packages, so it is not part of `npm test`. Set
 * `PAYLOAD_ROUNDTRIP_DIR` to choose a workspace and keep the generated app for
 * inspection. Its `bundle` subdirectory is replaced on each run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repository, "dist/src/cli.js");
const testEnv = { ...process.env };
// Every subprocess uses this test's .env and temporary SQLite database.
delete testEnv.DATABASE_URI;
delete testEnv.PAYLOAD_SECRET;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 900_000,
    cwd: options.cwd ?? repository,
    env: { ...testEnv, ...options.env },
    stdio: options.capture === false ? "inherit" : "pipe"
  });
  if (result.status !== (options.expectedStatus ?? 0)) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`
    );
  }
  return result.stdout ?? "";
}

function npm(args, cwd, env = {}) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check with `npm run test:payload`.");
  return run(process.execPath, [npmCli, ...args], { cwd, env });
}

const extraItems = `
<item>
  <title>Home</title><wp:post_id>500</wp:post_id><wp:post_type>nav_menu_item</wp:post_type><wp:status>publish</wp:status>
  <category domain="nav_menu" nicename="primary">Primary</category>
  <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>custom</wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key>_menu_item_url</wp:meta_key><wp:meta_value>https://brightpath.example/</wp:meta_value></wp:postmeta>
</item>
<item>
  <title>Scheduled book</title>
  <link>https://brightpath.example/book/</link>
  <dc:creator><![CDATA[niko]]></dc:creator>
  <category domain="genre" nicename="fiction"><![CDATA[Fiction]]></category>
  <content:encoded><![CDATA[
<!-- wp:heading --><h2>Contents</h2><!-- /wp:heading -->
<p>A <strong>scheduled</strong> book.</p>
<!-- wp:image {"id":304,"sizeSlug":"large"} --><figure class="wp-block-image size-large"><a href="/pipes/"><img data-src="/placeholder.jpg" src="https://brightpath.example/wp-content/uploads/2026/05/pipes.jpg" alt="Pipes" /></a></figure><!-- /wp:image -->
<pre>one
two</pre>
<ol start="3"><li>parent<ul><li>nested</li></ul>after</li><li>next</li></ol>
  ]]></content:encoded>
  <wp:post_id>61</wp:post_id>
  <wp:post_date_gmt>2026-11-01 08:00:00</wp:post_date_gmt>
  <wp:post_name>book</wp:post_name>
  <wp:status>future</wp:status>
  <wp:post_type>book</wp:post_type>
</item>
<item>
  <title>Private page</title>
  <link>https://brightpath.example/private/</link>
  <content:encoded><![CDATA[<p>Private content</p>]]></content:encoded>
  <wp:post_id>62</wp:post_id>
  <wp:post_name>private</wp:post_name>
  <wp:status>private</wp:status>
  <wp:post_type>page</wp:post_type>
</item>
`;

/**
 * The checks that need a real database. It runs inside the bundle so `payload`
 * resolves from the bundle's own `node_modules`.
 */
const bundleCheck = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bundle = process.cwd();
const { default: config } = await import(pathToFileURL(join(bundle, "payload.config.js")).href);
const { getPayload } = await import("payload");
const { convertLexicalToHTML } = await import("@payloadcms/richtext-lexical/html");

const payload = await getPayload({ config });
try {
  const book = (await payload.find({ collection: "books", depth: 2, draft: true, pagination: false })).docs[0];
  assert.ok(book, "the custom content type was imported");
  assert.equal(book._status, "draft", "a WordPress future record stays a draft");
  // Payload gives every array row its own id; the source terms are what matter.
  assert.deepEqual(
    book.wordpressTerms.map(({ id, ...term }) => term),
    [{ domain: "genre", name: "Fiction", slug: "fiction" }]
  );

  const bodies = JSON.stringify(book.body);
  assert.match(bodies, /"type":"upload"/, "the delivered body image became a media node");
  const upload = book.body.root.children.find((node) => node.type === "upload");
  assert.ok(upload, "the upload node is at the top level, not nested in a paragraph");
  assert.equal(upload.relationTo, "media");
  assert.ok(upload.value && typeof upload.value === "object" && upload.value.url, "depth populates the media record");
  assert.match(upload.value.url, /pipes/);
  assert.equal(upload.fields.alt, "Pipes", "the image's own alt text is kept on the node");
  const html = convertLexicalToHTML({ data: book.body });
  assert.match(html, /<img/, "the image renders from the stored rich text");

  const privatePage = (await payload.find({ collection: "pages", where: { wordpressId: { equals: 62 } }, draft: true })).docs[0];
  assert.equal(privatePage._status, "draft", "a WordPress private record stays a draft");

  const media = await payload.find({ collection: "media", limit: 1 });
  assert.ok(media.totalDocs > 0, "media was uploaded");
  const navigation = await payload.find({ collection: "navigation", limit: 1 });
  assert.equal(navigation.docs[0].items[0].label, "Home", "the menu is stored in the editable collection");

  const post = (await payload.find({ collection: "posts", limit: 1 })).docs[0];
  await payload.update({ collection: "posts", id: post.id, draft: true, data: { title: "CMS draft edit" } });
  console.log("CHECK OK");
} finally {
  await payload.destroy();
}
`;

const workspace = process.env.PAYLOAD_ROUNDTRIP_DIR ?? (await mkdtemp(join(tmpdir(), "wp-migrate-payload-roundtrip-")));
const keep = process.env.PAYLOAD_ROUNDTRIP_DIR !== undefined || process.env.PAYLOAD_ROUNDTRIP_KEEP === "1";
const bundle = join(workspace, "bundle");
const exportPath = join(workspace, "export.xml");

try {
  await mkdir(workspace, { recursive: true });
  const base = await readFile(join(repository, "fixtures/demo-wordpress.xml"), "utf8");
  await writeFile(exportPath, base.replace("</channel>", `${extraItems}</channel>`));

  console.log(`Payload round trip in ${workspace}`);
  console.log("Generating the bundle ...");
  await rm(bundle, { recursive: true, force: true });
  run(
    process.execPath,
    [cliPath, "convert", exportPath, "--include-drafts", "--target", "payload", "--out", bundle, "--uploads", join(repository, "fixtures/uploads")],
    { capture: false }
  );

  console.log("Installing the bundle's dependencies ...");
  npm(["install", "--no-audit", "--no-fund", "--package-lock=false"], bundle);
  await writeFile(join(bundle, ".env"), "PAYLOAD_SECRET=roundtrip-secret\nDATABASE_URI=file:./roundtrip.db\n");

  const importReport = async () => {
    npm(["run", "import"], bundle);
    return JSON.parse(await readFile(join(bundle, "migration-import.json"), "utf8"));
  };

  console.log("Importing ...");
  const first = await importReport();
  assert.equal(first.summary.failed, 0, JSON.stringify(first.records.filter((record) => record.action === "failed"), null, 2));
  assert.equal(first.summary.created, first.summary.planned, "the first import creates every planned record");
  await stat(join(bundle, "roundtrip.db"));
  await assert.rejects(() => stat(join(bundle, "payload.db")), { code: "ENOENT" }, "the importer must use DATABASE_URI from .env");

  const second = await importReport();
  assert.equal(second.summary.unchanged, second.summary.planned, "a repeated import changes nothing");
  assert.equal(second.summary.created, 0);

  console.log("Checking the stored content, the admin host and the media nodes ...");
  await writeFile(join(bundle, "roundtrip-check.mjs"), bundleCheck);
  const checked = npm(["exec", "--", "payload", "run", "roundtrip-check.mjs"], bundle);
  assert.match(checked, /CHECK OK/);

  console.log("Re-importing after a source change and a CMS edit ...");
  const booksPath = join(bundle, "import/content/books.json");
  const books = JSON.parse(await readFile(booksPath, "utf8"));
  books[0].data.title = "Updated from source";
  delete books[0].data.author;
  await writeFile(booksPath, JSON.stringify(books));
  const third = await importReport();
  const actionOf = (report, sourceId) => report.records.find((record) => record.sourceId === sourceId)?.action;
  assert.equal(actionOf(third, books[0].wordpressSourceId), "updated", "a source change updates the record");
  assert.equal(actionOf(third, "wp:post:20"), "skipped", "a record edited in the CMS is protected");
  assert.equal(third.records.find((record) => record.sourceId === "wp:post:20")?.reason, "record-modified");

  const fourth = await importReport();
  assert.equal(fourth.summary.updated, 0, "the update is not repeated on the next run");
  assert.equal(fourth.summary.skipped, 1);

  console.log("Replacing a delivered file and checking the media re-import ...");
  const mediaJobs = JSON.parse(await readFile(join(bundle, "import/content/media.json"), "utf8"));
  const mediaJob = mediaJobs.find((job) => job.wordpressSourceId === "media:301");
  assert.ok(mediaJob);
  await writeFile(join(bundle, mediaJob.file), await readFile(join(repository, "fixtures/uploads/2026/05/pipes.jpg")));
  const changedMedia = await importReport();
  assert.equal(actionOf(changedMedia, mediaJob.wordpressSourceId), "updated");
  assert.equal(changedMedia.summary.failed, 0);
  const stableMedia = await importReport();
  assert.equal(actionOf(stableMedia, mediaJob.wordpressSourceId), "unchanged");

  console.log("Checking the import report against the plan ...");
  const verification = run(
    process.execPath,
    [cliPath, "verify", exportPath, "--include-drafts", "--import-report", join(bundle, "migration-import.json"), "--fail-on", "blocker", "--json"],
    { cwd: workspace }
  );
  const verified = JSON.parse(verification);
  assert.equal(verified.summary.launchBlockers, 0, "the import report leaves no blocker behind");
  assert.ok(
    verified.checks.some((check) => check.id === "import" && check.checked === true),
    "the import evidence is checked rather than skipped"
  );

  console.log("Checking failed imports return a nonzero exit status ...");
  const indexPath = join(bundle, "import/content/index.json");
  const originalIndex = await readFile(indexPath, "utf8");
  const invalidIndex = JSON.parse(originalIndex);
  invalidIndex.files.push({ collection: "missing-collection", file: "content/books.json", count: 1 });
  await writeFile(indexPath, JSON.stringify(invalidIndex));
  run(process.execPath, [process.env.npm_execpath, "run", "import"], { cwd: bundle, expectedStatus: 1 });
  const failed = JSON.parse(await readFile(join(bundle, "migration-import.json"), "utf8"));
  assert.equal(failed.summary.failed, 1);
  await writeFile(indexPath, originalIndex);

  console.log("Building the generated admin host with Next.js ...");
  npm(["run", "build"], bundle);

  console.log("PASS: real Payload + SQLite create, repeat import, source update, CMS draft protection, a media node in the body, the import gate and a Next build.");
} finally {
  if (keep) {
    console.log(`Kept ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
}
