import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parseWxr } from "../src/core.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generatePruviousBundle, renderPruviousImporterRoute } from "../src/pruvious.js";
import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");
const fixturesRoot = dirname(resolve(demoFixturePath));

async function loadDemoProject() {
  return parseWxr(await readFile(demoFixturePath, "utf8"));
}

test("the Pruvious bundle is a Nuxt app with collections, a drop and an importer", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-pruvious-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const bundle = join(output, "bundle");

  const parsed = await loadDemoProject();
  const project = applyMediaDelivery(parsed, await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") }));
  await generatePruviousBundle(project, bundle);

  // The app files: a Nuxt config with the module, a package with the scripts,
  // and the env/gitignore that keep the database out of git.
  const nuxtConfig = await readFile(join(bundle, "nuxt.config.ts"), "utf8");
  assert.match(nuxtConfig, /modules:\s*\['pruvious'\]/);
  const packageJson = JSON.parse(await readFile(join(bundle, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.pruvious, "~3.9.0");
  assert.equal(packageJson.dependencies.nuxt, "~3.9.0");
  assert.equal(packageJson.dependencies["@tiptap/extension-blockquote"], "2.1.13");
  assert.equal(packageJson.scripts.dev, "pruvious dev");
  assert.equal(packageJson.scripts.build, "nuxt build");
  assert.match(nuxtConfig, /standardCollections: \{ pages: false \}/);
  assert.equal(packageJson.scripts.migrate, "node import/migrate.mjs");
  await Promise.all(
    [".env.example", ".gitignore", "app.vue", "import/migrate.mjs", "server/api/migrate.post.ts", "server/middleware/migrate-redirects.ts"].map((file) =>
      stat(join(bundle, file))
    )
  );

  // One collection module per content type, plus the shared ones.
  await Promise.all(
    ["pages.ts", "posts.ts", "media.ts", "categories.ts", "tags.ts", "authors.ts", "navigation.ts"].map((file) =>
      stat(join(bundle, "collections", file))
    )
  );
  const pages = await readFile(join(bundle, "collections/pages.ts"), "utf8");
  assert.match(pages, /defineCollection/);
  assert.match(pages, /wordpressSourceId/);
  assert.match(pages, /'editor'|"editor"/, "the body is a rich-text editor field");

  // The drop resolves relationships through the same stable ids the manifest uses.
  const index = JSON.parse(await readFile(join(bundle, "import/content/index.json"), "utf8"));
  assert.equal(index.schemaVersion, "0.11");
  const loaded = index.files.map((file: { collection: string }) => file.collection);
  assert.equal(loaded[0], "categories", "taxonomies load before the content that references them");
  const mediaIndex = loaded.indexOf("media");
  for (const name of ["pages", "posts"]) {
    const at = loaded.indexOf(name);
    if (at >= 0) assert.ok(mediaIndex < at, "media loads before the content that references it");
  }
  const posts = JSON.parse(await readFile(join(bundle, "import/content/posts.json"), "utf8"));
  assert.match(JSON.stringify(posts), /"\$ref":\s*"wp:term:category:guides"/);

  // Delivered media is served from public/, at the source upload path.
  await stat(join(bundle, "public/wp-content/uploads/2026/05/hero.jpg"));

  const manifest = JSON.parse(await readFile(join(bundle, "migration/manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "0.11");
  assert.equal(manifest.generator.target, "pruvious");
  assert.equal(manifest.destination.kind, "cms");
  assert.equal(manifest.destination.structure, "pruvious-nuxt");
  assert.equal(manifest.destination.pruviousVersion, "~3.9.0");
  assert.equal(manifest.targets.pruvious.kind, "cms");
  assert.equal(manifest.targets.svelte.enabled, false);
  assert.equal(manifest.records.length, project.records.length);

  const pageJobs = JSON.parse(await readFile(join(bundle, "import/content/pages.json"), "utf8"));
  assert.ok(posts.some((job: { data: { body: string } }) => job.data.body.includes('src="/wp-content/uploads/')), "delivered body images use the local copy");
  assert.ok(pageJobs.some((job: { data: { body: string } }) => job.data.body.includes("Residential plumbing handled by licensed technicians.")), "Elementor widget text is preserved");
});

test("Pruvious refuses a collection collision before writing output", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-pruvious-collision-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  // A post type whose collection name collides with the reserved uploads collection.
  const project = parseWxr(
    `<rss><channel><item><title>Upload</title><link>https://example.test/upload/</link><wp:post_id>1</wp:post_id><wp:post_type>upload</wp:post_type><wp:status>publish</wp:status><wp:post_name>upload</wp:post_name></item></channel></rss>`
  );
  const bundle = join(workspace, "bundle");
  await assert.rejects(() => generatePruviousBundle(project, bundle), /collection name collision/);
  await assert.rejects(() => stat(bundle), { code: "ENOENT" });
});

test("the Pruvious importer leaves a report when a drop file cannot be read", () => {
  const route = renderPruviousImporterRoute(parseWxr("<rss><channel></channel></rss>"));
  assert.match(route, /#pruvious\/server/);
  assert.match(route, /migration-import\.json/);
  assert.match(route, /Cannot read the drop index/, "a missing index still writes a report");
  assert.match(route, /WP_MIGRATE_IMPORT_REPORT/, "the report path is overridable");
  assert.match(route, /wordpressSourceId/, "records are found by their stable source id");
});

test("every generated Pruvious collection module carries valid configuration", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-pruvious-ts-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const bundle = join(output, "bundle");

  const parsed = await loadDemoProject();
  const project = applyMediaDelivery(parsed, await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") }));
  await generatePruviousBundle(project, bundle);

  const files = await readdir(join(bundle, "collections"));
  assert.ok(files.length >= 6, "the bundle writes a module per collection");
  for (const name of files) {
    const source = await readFile(join(bundle, "collections", name), "utf8");
    assert.match(source, /import \{ defineCollection \} from '#pruvious'/, `${name} imports defineCollection`);
    const match = /defineCollection\(([\s\S]*)\)\s*$/.exec(source);
    assert.ok(match, `${name} calls defineCollection`);
    const config = JSON.parse(match[1]!) as { name: string; mode: string; fields: Record<string, unknown> };
    assert.equal(typeof config.name, "string");
    assert.equal(config.mode, "multi");
    assert.ok(Object.keys(config.fields).length > 0, `${name} defines fields`);
    assert.ok(
      Object.values(config.fields).every((field: unknown) => typeof (field as { type?: unknown }).type === "string"),
      `${name} gives every field a type`
    );
  }

  // The server files are present and import Pruvious's server API.
  const route = await readFile(join(bundle, "server/api/migrate.post.ts"), "utf8");
  assert.match(route, /from '#pruvious\/server'/);
  const middleware = await readFile(join(bundle, "server/middleware/migrate-redirects.ts"), "utf8");
  assert.match(middleware, /defineEventHandler/);
});

test("convert --target pruvious writes a bundle through the installed executable", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-pruvious-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [cliPath, "convert", demoFixturePath, "--out", "bundle", "--target", "pruvious", "--uploads", join(fixturesRoot, "uploads"), "--json"],
    { cwd: workspace, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.command, "convert");

  const manifest = JSON.parse(await readFile(join(workspace, "bundle/migration/manifest.json"), "utf8"));
  assert.equal(manifest.generator.target, "pruvious");
  assert.equal(manifest.destination.kind, "cms");
});

test("the generated Pruvious importer protects edits, reports failures and requires a token", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-pruvious-import-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "import/content"), { recursive: true });
  const indexFile = join(workspace, "import/content/index.json");
  const dropFile = join(workspace, "import/content/pages.json");
  const index = { files: [{ collection: "pages", file: "content/pages.json" }] };
  await writeFile(indexFile, JSON.stringify(index));
  const job = { wordpressSourceId: "wp:post:1", data: { wordpressSourceId: "wp:post:1", title: "Original", categories: [1] } };
  await writeFile(dropFile, JSON.stringify([job]));

  let saved: Record<string, unknown> | undefined;
  let failUpdate = false;
  const query = () => ({
    where() { return this; },
    async first() { return saved; },
    async create(data: Record<string, unknown>) {
      saved = { ...structuredClone(data), id: 1 };
      return { success: true, record: saved };
    },
    async update(data: Record<string, unknown>) {
      if (failUpdate) return { success: false, errors: { title: "Rejected" } };
      saved = { ...saved, ...structuredClone(data) };
      return { success: true, records: [saved] };
    }
  });
  const source = renderPruviousImporterRoute(await loadDemoProject())
    .replace(/^import .*$/gm, "")
    .replace("export default defineEventHandler", "return defineEventHandler");
  const reportPath = join(workspace, "custom-report.json");
  const run = new Function("createHash", "readFile", "writeFile", "resolve", "query", "process", "defineEventHandler", "getHeader", "createError", source)(
    createHash, readFile, writeFile, resolve, query,
    { cwd: () => workspace, env: { WP_MIGRATE_IMPORT_TOKEN: "test-token", WP_MIGRATE_IMPORT_REPORT: reportPath } },
    (handler: unknown) => handler,
    (event: string) => event,
    (error: { statusCode: number }) => Object.assign(new Error("Forbidden"), error)
  ) as (authorization?: string) => Promise<Record<string, number>>;
  const report = async () => JSON.parse(await readFile(reportPath, "utf8"));

  await assert.rejects(() => run(), { statusCode: 403 });
  assert.equal(saved, undefined, "an unauthorized request performs no import");
  assert.equal((await run("Bearer test-token")).created, 1);
  assert.equal((await run("Bearer test-token")).unchanged, 1);
  job.data.title = "Source update";
  job.data.categories = [];
  await writeFile(dropFile, JSON.stringify([job]));
  assert.equal((await run("Bearer test-token")).updated, 1);
  assert.deepEqual(saved!.categories, [], "removed relationships are cleared");
  saved!.title = "Dashboard edit";
  assert.equal((await run("Bearer test-token")).skipped, 1, "edits are protected even with an unchanged drop");
  job.data.title = "Another source update";
  await writeFile(dropFile, JSON.stringify([job]));
  assert.equal((await run("Bearer test-token")).skipped, 1);
  assert.equal(saved!.title, "Dashboard edit");
  assert.equal((await report()).records[0].reason, "record-modified");

  saved!.title = "Source update";
  failUpdate = true;
  const failed = await run("Bearer test-token");
  assert.equal(failed.failed, 1);
  assert.equal(failed.updated, 0, "a rejected update is not also counted as successful");

  await rm(dropFile);
  assert.equal((await run("Bearer test-token")).failed, 1);
  assert.match((await report()).records[0].reason, /Cannot read content\/pages.json/);
  await writeFile(indexFile, '{"files":{}}');
  assert.equal((await run("Bearer test-token")).failed, 1);
  assert.match((await report()).records[0].reason, /Cannot read the drop index/);
});

test("Pruvious redirect middleware matches literal paths and never redirects its destination", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-pruvious-redirect-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const parsed = await loadDemoProject();
  const project = { ...parsed, routes: { ...parsed.routes, redirects: [
    { id: "slash", sourcePath: "/old", targetRoute: "/old/", reason: "normalization" },
    { id: "literal", sourcePath: "/a(b):c+", targetRoute: "/new/", reason: "normalization" }
  ] } };
  const bundle = join(workspace, "bundle");
  await generatePruviousBundle(project, bundle);
  const source = (await readFile(join(bundle, "server/middleware/migrate-redirects.ts"), "utf8"))
    .replace(/: \{ source: string; destination: string; statusCode: number \}\[\]/, "")
    .replace("path: string", "path")
    .replace("export default defineEventHandler", "return defineEventHandler");
  const handler = new Function("defineEventHandler", "getRequestURL", "sendRedirect", source)(
    (fn: unknown) => fn, (path: string) => new URL(path, "https://example.test"),
    (_event: unknown, destination: string) => destination
  ) as (path: string) => string | undefined;
  assert.equal(handler("/old"), "/old/");
  assert.equal(handler("/old/"), undefined);
  assert.equal(handler("/a(b):c+"), "/new/");
  assert.equal(handler("/abc"), undefined);
});

test("the generated migrate command sends its token and exits unsuccessfully on import failures", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-pruvious-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const bundle = join(workspace, "bundle");
  await generatePruviousBundle(await loadDemoProject(), bundle);
  const source = (await readFile(join(bundle, "import/migrate.mjs"), "utf8"))
    .replace(/^import .*$/gm, "")
    .replace("import.meta.url", JSON.stringify("file:///test/import/migrate.mjs"));
  const run = new Function("existsSync", "fileURLToPath", "process", "fetch", "console", `return (async () => { ${source} })()`);
  const fakeProcess = { env: { WP_MIGRATE_IMPORT_TOKEN: "secret" }, exitCode: 0 };
  let requested = false;
  await run(() => false, String, fakeProcess, async (url: URL, options: { headers: { authorization: string } }) => {
    requested = true;
    assert.equal(url.href, "http://localhost:3000/api/migrate");
    assert.equal(options.headers.authorization, "Bearer secret");
    return { ok: true, json: async () => ({ failed: 1 }) };
  }, { log() {}, error() {} });
  assert.equal(requested, true);
  assert.equal(fakeProcess.exitCode, 1);
});
