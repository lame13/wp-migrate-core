import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generateAstroProject } from "../src/generate.js";
import { generateNextProject } from "../src/next.js";
import { parseWxr } from "../src/core.js";
import { demoFixturePath } from "./fixture-path.js";

const fixturesRoot = join(demoFixturePath, "..");

/**
 * A menu item the demo export does not carry, so the navigation path is
 * exercised here and in the round trip rather than only when a site happens to
 * have a menu.
 */
const navigationItem = `
<item>
  <title>Home</title><wp:post_id>500</wp:post_id><wp:post_type>nav_menu_item</wp:post_type><wp:status>publish</wp:status>
  <category domain="nav_menu" nicename="primary">Primary</category>
  <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>custom</wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key>_menu_item_url</wp:meta_key><wp:meta_value>https://brightpath.example/</wp:meta_value></wp:postmeta>
</item>
`;

async function demoProject(withMenu = false) {
  const xml = await readFile(demoFixturePath, "utf8");
  const parsed = parseWxr(withMenu ? xml.replace("</channel>", `${navigationItem}</channel>`) : xml);
  return applyMediaDelivery(parsed, await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") }));
}

test("the Next destination writes an App Router project the same plan describes", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-next-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const project = join(output, "site");

  await generateNextProject(await demoProject(true), project);

  const packageJson = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.next, "^16.3.3");
  assert.equal(packageJson.dependencies.react, "^19.2.1");
  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.build, "next build");
  // A static export has no server, so claiming a `next start` script would be
  // a script that cannot work.
  assert.equal(packageJson.scripts.start, undefined);

  const nextConfig = await readFile(join(project, "next.config.mjs"), "utf8");
  assert.match(nextConfig, /output: "export"/);
  assert.match(nextConfig, /trailingSlash: true/);

  await Promise.all(
    [
      "app/layout.tsx",
      "app/page.tsx",
      "app/[...segments]/page.tsx",
      "app/globals.css",
      "components/Nav.tsx",
      "lib/content.ts",
      "content/routes.json",
      "next-env.d.ts",
      "tsconfig.json",
      "public/robots.txt",
      "public/sitemap.xml",
      "migration/manifest.json"
    ].map((file) => stat(join(project, file)))
  );

  // A menu is a component the layout renders, built from the same escaped tree
  // the Astro handoff writes.
  const nav = await readFile(join(project, "components/Nav.tsx"), "utf8");
  const navigationLiteral = /const navigation = (".*");/.exec(nav)?.[1];
  assert.ok(navigationLiteral, "the component carries the navigation HTML");
  const navigation = JSON.parse(navigationLiteral) as string;
  assert.match(navigation, /<nav aria-label="Primary navigation">/);
  // A confirmed internal target is rewritten to the generated route, exactly
  // as it is in the Astro handoff.
  assert.match(navigation, /<a href="\/">Home<\/a>/);
  const layout = await readFile(join(project, "app/layout.tsx"), "utf8");
  assert.match(layout, /import Nav from "\.\.\/components\/Nav";/);

  // The route index is the app's own contract: every planned route, in plan
  // order, pointing at a page file that exists.
  const routes = JSON.parse(await readFile(join(project, "content/routes.json"), "utf8"));
  assert.equal(routes.schemaVersion, "0.12");
  assert.deepEqual(
    routes.routes.map((entry: { route: string }) => entry.route),
    ["/", "/services/", "/contact/", "/guides/stop-a-leaking-tap/", "/category/guides/", "/author/niko/"]
  );
  for (const entry of routes.routes) {
    const page = JSON.parse(await readFile(join(project, entry.file), "utf8"));
    assert.equal(page.route, entry.route);
    assert.equal(typeof page.html, "string");
    assert.ok(page.html.length > 0, `${entry.route} has a rendered body`);
  }

  const manifest = JSON.parse(await readFile(join(project, "migration", "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "0.12");
  assert.equal(manifest.generator.target, "next");
  assert.equal(manifest.destination.structure, "next-app-router");
  assert.equal(manifest.destination.buildDirectory, "out");
  assert.equal(manifest.destination.routesIndex, "content/routes.json");
  assert.equal(manifest.targets.next.enabled, true);
  assert.equal(manifest.targets.svelte.enabled, false);
  assert.equal(manifest.records.length, routes.routes.length - 2, "listings are not content records");
  for (const record of manifest.records) {
    assert.ok(routes.routes.some((entry: { route: string; file: string }) => entry.route === record.route && entry.file === record.outputFile));
  }

  // The paired preview check names the port Next actually serves.
  const previewCheck = await readFile(join(project, "migration/checks/ssrwire-preview.yml"), "utf8");
  assert.match(previewCheck, /url: "http:\/\/localhost:3000\//);
  assert.match(previewCheck, /`npm run dev`, which serves http:\/\/localhost:3000 by default/);
  assert.doesNotMatch(previewCheck, /localhost:4321/);

  // Delivered media is written into public/, which a static export copies to
  // the site root, so the source upload paths keep serving.
  await stat(join(project, "public/wp-content/uploads/2026/05/repair.jpg"));
});

test("the Next and Astro handoffs render one page model, not two", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-next-parity-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const project = await demoProject();
  const astro = join(output, "astro");
  const next = join(output, "next");
  await generateAstroProject(project, astro);
  await generateNextProject(project, next);

  for (const [collection, stem] of [
    ["pages", "contact"],
    ["pages", "home"],
    ["posts", "stop-a-leaking-tap"]
  ] as const) {
    const markdown = await readFile(join(astro, "src", "content", collection, `${stem}.md`), "utf8");
    const body = markdown.slice(markdown.indexOf("\n---", 3) + 4).trim();
    const page = JSON.parse(await readFile(join(next, "content", collection, `${stem}.json`), "utf8"));
    assert.equal(page.html.trim(), body, `${collection}/${stem} renders the same HTML in both destinations`);
  }

  const listingMarkdown = await readFile(join(astro, "src", "content", "listings", "category-guides.md"), "utf8");
  const listingBody = listingMarkdown.slice(listingMarkdown.indexOf("\n---", 3) + 4).trim();
  const listing = JSON.parse(await readFile(join(next, "content", "listings", "category-guides.json"), "utf8"));
  assert.equal(listing.html.trim(), listingBody);
});

test("the Next destination refuses duplicate routes before writing anything", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-next-duplicate-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const project = await demoProject();
  const duplicated = {
    ...project,
    records: project.records.map((record) =>
      record.slug === "services" ? { ...record, route: "/contact/" } : record
    )
  };

  await assert.rejects(
    () => generateNextProject(duplicated, join(output, "site")),
    /Cannot generate duplicate route: \/contact\//
  );
  await assert.rejects(() => stat(join(output, "site", "content", "routes.json")), { code: "ENOENT" });
});
