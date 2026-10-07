import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { contentCollectionName, contentTypeLabel, parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";

function wxrDocument(...blocks: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...blocks,
    "</channel></rss>"
  ].join("");
}

function item(options: {
  readonly id: number;
  readonly title: string;
  readonly slug: string;
  readonly type: string;
  readonly status?: string;
}): string {
  return [
    "<item>",
    `<title>${options.title}</title>`,
    `<link>https://example.test/${options.slug}/</link>`,
    `<wp:post_id>${options.id}</wp:post_id>`,
    `<wp:post_type>${options.type}</wp:post_type>`,
    `<wp:status>${options.status ?? "publish"}</wp:status>`,
    `<wp:post_name>${options.slug}</wp:post_name>`,
    "</item>"
  ].join("");
}

function menuItem(options: {
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

/** A post carrying the category a taxonomy menu item points at. */
function categorisedPost(): string {
  return [
    "<item>",
    "<title>How to stop a leaking tap</title>",
    "<link>https://example.test/how-to-stop-a-leaking-tap/</link>",
    "<wp:post_id>10</wp:post_id>",
    "<wp:post_type>post</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>how-to-stop-a-leaking-tap</wp:post_name>",
    '<category domain="category" nicename="guides"><![CDATA[Guides]]></category>',
    "</item>"
  ].join("");
}

test("names content collections for known and custom types", () => {
  assert.equal(contentCollectionName("page"), "pages");
  assert.equal(contentCollectionName("post"), "posts");
  assert.equal(contentCollectionName("portfolio"), "portfolios");
  assert.equal(contentCollectionName("news"), "news");
  assert.equal(contentCollectionName("case_study"), "case-studys");
  assert.equal(contentTypeLabel("portfolio-item"), "Portfolio item");
});

test("brings a custom post type across instead of dropping it silently", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-types-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const project = parseWxr(
    wxrDocument(
      item({ id: 1, title: "Home", slug: "home", type: "page" }),
      item({ id: 20, title: "Gallery", slug: "gallery", type: "portfolio" }),
      item({ id: 21, title: "Repair", slug: "repair", type: "portfolio" })
    )
  );

  assert.deepEqual(project.summary.types, { page: 1, portfolio: 2 });
  const portfolio = project.types.find((entry) => entry.name === "portfolio");
  assert.deepEqual(portfolio, {
    name: "portfolio",
    label: "Portfolio",
    collection: "portfolios",
    sourceItems: 2,
    records: 2,
    included: true
  });
  assert.deepEqual(
    project.routes.entries.map((entry) => entry.targetRoute).sort(),
    ["/gallery/", "/home/", "/repair/"]
  );

  await generateAstroProject(project, root);
  const config = await readFile(join(root, "src/content.config.ts"), "utf8");
  assert.match(config, /"portfolios": defineCollection/);
  const catchAll = await readFile(join(root, "src/pages/[...slug].astro"), "utf8");
  assert.match(catchAll, /getCollection\("portfolios"\)/);
  const manifest = JSON.parse(await readFile(join(root, "migration/manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.types.map((entry: { name: string; collection: string }) => [entry.name, entry.collection]),
    [
      ["page", "pages"],
      ["portfolio", "portfolios"]
    ]
  );
  assert.equal(
    manifest.records.find((record: { postType: string }) => record.postType === "portfolio").outputFile,
    "src/content/portfolios/gallery.md"
  );
});

test("reports WordPress internals instead of leaving them unexplained", () => {
  const project = parseWxr(
    wxrDocument(
      item({ id: 1, title: "Home", slug: "home", type: "page" }),
      item({ id: 30, title: "Revision", slug: "home-revision", type: "revision" }),
      item({ id: 31, title: "Custom CSS", slug: "custom-css", type: "custom_css" })
    )
  );

  const skipped = project.issues.filter((issue) => issue.code === "WXR_POST_TYPE_SKIPPED");
  assert.equal(skipped.length, 2, "one finding per skipped type, not per item");
  assert.deepEqual(
    skipped.map((issue) => issue.title).sort(),
    ['Content type "Custom css" is not part of this handoff', 'Content type "Revision" is not part of this handoff']
  );
  assert.match(skipped[0]?.requiredAction ?? "", /postTypes\.include/);
  assert.equal(project.summary.types.revision, undefined, "a skipped type generates no records");

  const types = project.types.filter((entry) => !entry.included).map((entry) => entry.name).sort();
  assert.deepEqual(types, ["custom_css", "revision"]);
});

test("does not report attachments and menu items as content it dropped", () => {
  const project = parseWxr(
    wxrDocument(
      item({ id: 1, title: "Home", slug: "home", type: "page" }),
      item({ id: 40, title: "Photo", slug: "photo", type: "attachment" }),
      menuItem({ id: 50, title: "Home", order: 1, type: "post_type", object: "page", objectId: 1 })
    )
  );

  assert.equal(project.issues.filter((issue) => issue.code === "WXR_POST_TYPE_SKIPPED").length, 0);
  assert.deepEqual(project.menus.summary, { menus: 1, items: 1, unresolved: 0 });
});

test("honours a post-type include and exclude list", () => {
  const document = wxrDocument(
    item({ id: 1, title: "Home", slug: "home", type: "page" }),
    item({ id: 20, title: "Gallery", slug: "gallery", type: "portfolio" }),
    item({ id: 21, title: "Job", slug: "job", type: "job" })
  );

  const narrowed = parseWxr(document, { config: { postTypes: { include: ["page", "portfolio"] } } });
  assert.deepEqual(narrowed.summary.types, { page: 1, portfolio: 1 });
  const job = narrowed.types.find((entry) => entry.name === "job");
  assert.equal(job?.included, false);
  assert.match(job?.reason ?? "", /lists the types to bring across/);
  assert.equal(narrowed.routes.entries.find((entry) => entry.sourceId === "wp:job:21")?.status, "excluded");

  const excluded = parseWxr(document, { config: { postTypes: { exclude: ["job"] } } });
  assert.deepEqual(excluded.summary.types, { page: 1, portfolio: 1 });
  assert.equal(excluded.types.find((entry) => entry.name === "job")?.reason, "The migration config leaves this type out.");
  assert.deepEqual(excluded.config?.decisions, {
    routes: 0,
    exclusions: 0,
    ignoredIssues: 0,
    ignoredIssueCodes: []
  });

  const unmatched = parseWxr(document, { config: { postTypes: { include: ["page", "not-a-type"] } } });
  const findings = unmatched.issues.filter((issue) => issue.code === "CONFIG_ENTRY_UNMATCHED");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /not-a-type/);
});

test("rebuilds the navigation the export carries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-menus-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const document = wxrDocument(
    "<wp:category><wp:term_id>7</wp:term_id><wp:category_nicename>guides</wp:category_nicename><wp:cat_name><![CDATA[Guides]]></wp:cat_name></wp:category>",
    item({ id: 1, title: "Services", slug: "services", type: "page" }),
    item({ id: 2, title: "Contact", slug: "contact", type: "page" }),
    categorisedPost(),
    menuItem({ id: 500, title: "Services", order: 1, type: "post_type", object: "page", objectId: 1 }),
    menuItem({ id: 501, title: "Contact us", order: 2, type: "post_type", object: "page", objectId: 2, parent: 500 }),
    menuItem({ id: 502, title: "Standards", order: 3, type: "custom", url: "https://example.org/standards" }),
    menuItem({ id: 503, title: "Guides", order: 4, type: "taxonomy", object: "category", objectId: 7 })
  );

  const project = parseWxr(document, {
    liveUrlSource: { urls: ["https://example.test/category/guides/"], sitemapRefs: [] }
  });

  assert.deepEqual(project.menus.summary, { menus: 1, items: 4, unresolved: 0 });
  const [menu] = project.menus.trees;
  assert.equal(menu?.name, "Primary");
  assert.equal(menu?.slug, "primary");
  assert.deepEqual(
    menu?.items.map((menuItemRecord) => [menuItemRecord.label, menuItemRecord.targetRoute]),
    [
      ["Services", "/services/"],
      ["Standards", undefined],
      ["Guides", "/category/guides/"]
    ]
  );
  const services = menu?.items[0];
  assert.deepEqual(
    services?.children.map((child) => [child.label, child.parentId]),
    [["Contact us", "menu:500"]]
  );
  assert.equal(services?.children[0]?.targetRoute, "/contact/");
  assert.equal(
    menu?.items.find((entry) => entry.label === "Standards")?.url,
    "https://example.org/standards"
  );

  await generateAstroProject(project, root);
  const nav = await readFile(join(root, "src/components/Nav.astro"), "utf8");
  // The tree is serialized as a JSON string and rendered with set:html, so
  // decode it and check the markup a visitor receives.
  const serialized = /const navigation = (".*");/.exec(nav)?.[1];
  assert.ok(serialized !== undefined, "the component carries the serialized navigation");
  const navigation = JSON.parse(serialized) as string;
  assert.match(navigation, /aria-label="Primary navigation"/);
  assert.match(navigation, /<a href="\/services\/">Services<\/a>/);
  assert.match(navigation, /<a href="\/contact\/">Contact us<\/a>/);
  assert.match(navigation, /<a href="\/category\/guides\/">Guides<\/a>/);
  assert.match(navigation, /<a href="https:\/\/example\.org\/standards">Standards<\/a>/);
  assert.match(nav, /set:html=\{navigation\}/);
  assert.match(await readFile(join(root, "src/layouts/Layout.astro"), "utf8"), /import Nav from "\.\.\/components\/Nav\.astro"/);

  const menus = JSON.parse(await readFile(join(root, "migration/menus.json"), "utf8"));
  assert.equal(menus.schemaVersion, "0.8");
  assert.deepEqual(menus.summary, project.menus.summary);
  assert.equal(menus.trees[0].items[0].children[0].label, "Contact us");
});

test("reports menu entries nothing in the plan serves", () => {
  const project = parseWxr(
    wxrDocument(
      item({ id: 1, title: "Home", slug: "home", type: "page" }),
      menuItem({ id: 500, title: "Pricing", order: 1, type: "post_type", object: "page", objectId: 99 }),
      menuItem({ id: 501, title: "Products", order: 2, type: "post_type_archive", object: "product" })
    )
  );

  assert.deepEqual(project.menus.summary, { menus: 1, items: 2, unresolved: 2 });
  const findings = project.issues.filter((issue) => issue.code === "MENU_TARGET_UNRESOLVED");
  assert.deepEqual(
    findings.map((issue) => issue.title),
    ['Menu entry "Pricing" has no target in this handoff', 'Menu entry "Products" has no target in this handoff']
  );
  assert.equal(project.menus.trees[0]?.items[0]?.targetRoute, undefined);
});

test("custom content cannot overwrite generated listing files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-listing-type-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(
    item({ id: 1, title: "Property", slug: "category-guides", type: "listing" }), categorisedPost()
  ));
  await generateAstroProject(project, root);
  const collection = project.types.find((entry) => entry.name === "listing")?.collection;
  assert.notEqual(collection, "listings");
  assert.match(await readFile(join(root, `src/content/${collection}/category-guides.md`), "utf8"), /Property/);
  assert.match(await readFile(join(root, "src/content/listings/category-guides.md"), "utf8"), /Guides/);
});

test("an explicit include can bring across an otherwise skipped content type", () => {
  const project = parseWxr(wxrDocument(item({ id: 1, title: "Block", slug: "block", type: "wp_block" })), {
    config: { postTypes: { include: ["wp_block"] } }
  });
  assert.equal(project.records.length, 1);
});

test("custom menu links preserve destinations without leaking queries into inventories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-menu-links-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(
    item({ id: 1, title: "Contact", slug: "contact", type: "page" }),
    menuItem({ id: 50, title: "Contact", order: 1, type: "custom", url: "/contact/?via=menu-secret#form" }),
    menuItem({ id: 51, title: "Outside", order: 2, type: "custom", url: "//outside.test/docs?via=menu-secret#start" }),
    menuItem({ id: 52, title: "Unsafe", order: 3, type: "custom", url: "javascript:alert(1)" }),
    menuItem({ id: 53, title: "Missing", order: 4, type: "custom", url: "/missing/" }),
    menuItem({ id: 54, title: "", order: 5, type: "post_type", object: "page", objectId: 1 })
  ));
  await generateAstroProject(project, root);
  const nav = await readFile(join(root, "src/components/Nav.astro"), "utf8");
  const html = JSON.parse(nav.match(/const navigation = (.*);/)?.[1] ?? '""');
  assert.match(html, /href="\/contact\/\?via=menu-secret#form"/);
  assert.match(html, /href="https:\/\/outside.test\/docs\?via=menu-secret#start"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="\/contact\/">Contact<\/a>/);
  assert.equal(project.menus.summary.unresolved, 2);
  assert.doesNotMatch(await readFile(join(root, "migration/menus.json"), "utf8"), /menu-secret|javascript:/);
});
