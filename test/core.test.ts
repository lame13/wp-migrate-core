import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertTargetEnabled } from "../src/adapters.js";
import { parseWxr } from "../src/core.js";
import type { MigrationNode } from "../src/types.js";
import { demoFixturePath } from "./fixture-path.js";

function flatten(nodes: readonly MigrationNode[]): MigrationNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function publishedPage(postId: string, title = "Example page"): string {
  return [
    "<item>",
    `<title>${title}</title>`,
    "<link>https://example.test/example-page/</link>",
    `<wp:post_id>${postId}</wp:post_id>`,
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>example-page</wp:post_name>",
    "</item>"
  ].join("");
}

function wxrDocument(...items: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

test("inspects Gutenberg and Elementor without silently accepting unsupported behavior", async () => {
  const xml = await readFile(demoFixturePath, "utf8");
  const project = parseWxr(xml);

  assert.equal(project.source.title, "Bright Path Plumbing");
  assert.equal(project.records.length, 4);
  assert.equal(project.summary.pages, 3);
  assert.equal(project.summary.posts, 1);

  const editors = new Set(project.records.map((record) => record.editor));
  assert.ok(editors.has("gutenberg"));
  assert.ok(editors.has("elementor"));

  const codes = new Set(project.issues.map((issue) => issue.code));
  assert.ok(codes.has("GUTENBERG_DYNAMIC_BLOCK"));
  assert.ok(codes.has("GUTENBERG_MEDIA_UNSUPPORTED"));
  assert.ok(codes.has("SHORTCODE_UNSUPPORTED"));
  assert.ok(codes.has("ELEMENTOR_IMAGE_REMOTE_MEDIA"));
  assert.ok(codes.has("ELEMENTOR_QUERY_UNSUPPORTED"));
  assert.ok(codes.has("ELEMENTOR_WIDGET_UNKNOWN"));

  const allNodes = project.records.flatMap((record) => flatten(record.nodes));
  assert.ok(allNodes.some((node) => node.sourceType === "core/heading" && node.conversion === "native"));
  assert.ok(allNodes.some((node) => node.sourceType === "posts" && node.conversion === "blocked"));
  assert.ok(
    allNodes.some(
      (node) => node.sourceType === "essential-addons-testimonial-slider" && node.conversion === "manual"
    )
  );

  const unsupportedNodes = allNodes.filter((node) => node.conversion === "blocked" || node.conversion === "manual");
  for (const node of unsupportedNodes) {
    assert.ok(
      project.issues.some((issue) => issue.nodeId === node.id),
      `unsupported node ${node.id} must have a repair issue`
    );
  }
});

test("keeps future renderers visible but disabled", () => {
  assert.doesNotThrow(() => assertTargetEnabled("astro"));
  assert.throws(() => assertTargetEnabled("next"), /planned but not available/);
  assert.throws(() => assertTargetEnabled("nuxt"), /planned but not available/);
});

test("skips non-positive and non-integer WordPress post IDs", () => {
  const project = parseWxr(
    wxrDocument(
      publishedPage("0"),
      publishedPage("-4"),
      publishedPage("42.5"),
      publishedPage("12items"),
      publishedPage("9007199254740992")
    )
  );

  assert.equal(project.records.length, 0);
  assert.deepEqual(
    project.issues.filter((issue) => issue.code === "WXR_ITEM_INVALID_ID").map((issue) => issue.message),
    [
      "Skipped a page because wp:post_id must be a positive integer.",
      "Skipped a page because wp:post_id must be a positive integer.",
      "Skipped a page because wp:post_id must be a positive integer.",
      "Skipped a page because wp:post_id must be a positive integer.",
      "Skipped a page because wp:post_id must be a positive integer."
    ]
  );
});

test("keeps the first eligible record and reports later duplicate WordPress IDs", () => {
  const project = parseWxr(
    wxrDocument(publishedPage("41", "First page"), publishedPage("41", "Repeated page"))
  );

  assert.equal(project.records.length, 1);
  assert.equal(project.records[0]?.title, "First page");
  assert.deepEqual(
    project.issues.filter((issue) => issue.code === "WXR_ITEM_DUPLICATE_ID"), [
      {
        id: "project:WXR_ITEM_DUPLICATE_ID:1",
        severity: "warning",
        code: "WXR_ITEM_DUPLICATE_ID",
        sourceId: "wp:page:41",
        title: "WordPress item repeats an existing ID",
        message: "Skipped a duplicate page with wp:post_id 41.",
        requiredAction: "Inspect the WXR export and resolve the duplicate post identifier before migration."
      }
    ]
  );
});

test("preserves malformed numeric XML entities without throwing", () => {
  const title = "Known &#169; then broken &#x110000; &#999999999999999999999999; &#xD800;";
  const xml = wxrDocument(publishedPage("7", title));

  assert.doesNotThrow(() => parseWxr(xml));
  const project = parseWxr(xml);

  assert.equal(project.records[0]?.title, "Known © then broken &#x110000; &#999999999999999999999999; &#xD800;");
});

test("inventories attachments and matches the media the included content references", async () => {
  const xml = await readFile(demoFixturePath, "utf8");
  const project = parseWxr(xml);

  assert.equal(project.records.length, 4, "attachments must not become content records");
  assert.deepEqual(project.media.summary, {
    assets: 5,
    referenced: 4,
    references: 5,
    matched: 3,
    missingAltText: 1,
    notInExport: 1,
    unusedAssets: 1
  });

  const byAsset = new Map(project.media.assets.map((asset) => [asset.id, asset]));
  assert.equal(byAsset.get("media:301")?.altText, "Technician repairing a kitchen sink");
  assert.equal(byAsset.get("media:301")?.width, 1600);
  assert.equal(byAsset.get("media:301")?.height, 1067);
  assert.equal(byAsset.get("media:303")?.referenceCount, 0, "the workshop photo is not referenced");
  assert.deepEqual(byAsset.get("media:302")?.referencedBy, ["wp:post:20"]);

  const references = project.media.references;
  const tap = references.find((reference) => reference.assetId === "media:302");
  assert.equal(tap?.status, "matched", "a resized src still resolves to the original upload");
  assert.equal(tap?.path, "/wp-content/uploads/2026/05/tap-768x512.jpg");
  assert.equal(tap?.kind, "gutenberg-image");

  const featured = references.find((reference) => reference.kind === "featured-image");
  assert.equal(featured?.assetId, "media:305");
  assert.equal(featured?.status, "matched");

  const pipes = references.find((reference) => reference.assetId === "media:304");
  assert.equal(pipes?.status, "missing-alt-text");
  assert.equal(pipes?.kind, "elementor-image");

  const external = references.find((reference) => reference.status === "not-in-export");
  assert.equal(external?.path, "/photos/emergency-callout.jpg");
  assert.equal(external?.assetId, undefined);

  const codes = project.issues.map((issue) => issue.code);
  assert.equal(codes.filter((code) => code === "MEDIA_MISSING_ALT_TEXT").length, 1);
  assert.equal(codes.filter((code) => code === "MEDIA_MISSING_FROM_EXPORT").length, 1);
});

test("maps every exported URL to a generated route or explains why there is none", () => {
  const xml = wxrDocument(
    "<item><title>Resized permalink</title><link>https://example.test/guides/older-post</link>",
    "<wp:post_id>81</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status>",
    "<wp:post_name>older-post</wp:post_name></item>",
    "<item><title>Query permalink</title><link>https://example.test/?p=82</link>",
    "<wp:post_id>82</wp:post_id><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>",
    "<wp:post_name>query-page</wp:post_name></item>",
    "<item><title>Broken item</title><link>https://example.test/broken/</link>",
    "<wp:post_id>not-a-number</wp:post_id><wp:post_type>page</wp:post_type><wp:status>publish</wp:status></item>",
    "<item><title>Unpublished item</title><link>https://example.test/unpublished/</link>",
    "<wp:post_id>84</wp:post_id><wp:post_type>page</wp:post_type><wp:status>draft</wp:status>",
    "<wp:post_name>unpublished</wp:post_name></item>"
  );
  const project = parseWxr(xml);

  assert.equal(project.records.length, 2);
  assert.deepEqual(
    project.routes.redirects.map((redirect) => [redirect.sourcePath, redirect.targetRoute]),
    [["/guides/older-post", "/guides/older-post/"]],
    "a missing trailing slash is the only redirect this export needs"
  );

  const bySourceId = new Map(project.routes.entries.map((entry) => [entry.sourceId, entry]));
  assert.equal(bySourceId.get("wp:page:82")?.status, "ambiguous-url");
  assert.match(bySourceId.get("wp:page:82")?.reason ?? "", /query string/);
  assert.equal(bySourceId.get("wp:page:82")?.sourcePath, "/");

  const skipped = project.routes.entries.filter((entry) => entry.status === "skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.sourcePath, "/broken/");

  const excluded = project.routes.entries.filter((entry) => entry.status === "excluded");
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0]?.sourcePath, "/unpublished/");

  assert.deepEqual(project.routes.summary, {
    sourceUrls: 4,
    generated: 1,
    redirects: 1,
    withoutTarget: 3,
    duplicateRoutes: 0
  });
});

test("reports colliding routes instead of quietly choosing one", () => {
  const project = parseWxr(wxrDocument(publishedPage("91", "First"), publishedPage("92", "Second")));

  assert.equal(project.records.length, 2);
  const conflicts = project.routes.entries.filter((entry) => entry.status === "duplicate-route");
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((entry) => entry.targetRoute), ["/example-page/", "/example-page/"]);
  assert.match(conflicts[0]?.reason ?? "", /Another content item also maps to/);
  assert.equal(project.routes.summary.generated, 0);
  assert.equal(project.routes.summary.duplicateRoutes, 2);
  assert.equal(project.routes.redirects.length, 0, "a colliding route must not become a redirect rule");
});

test("falls back to the slug when an item has no exported link", () => {
  const project = parseWxr(
    wxrDocument(
      "<item><title>No permalink</title>",
      "<wp:post_id>95</wp:post_id><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>",
      "<wp:post_name>no-permalink</wp:post_name></item>"
    )
  );

  assert.deepEqual(project.routes.entries, [
    {
      id: "route:1",
      sourceId: "wp:page:95",
      targetRoute: "/no-permalink/",
      status: "generated",
      reason: "Generated from the item slug because no permalink was exported."
    }
  ]);
  assert.deepEqual(project.routes.summary, {
    sourceUrls: 0,
    generated: 1,
    redirects: 0,
    withoutTarget: 0,
    duplicateRoutes: 0
  });
});

function attachment(id: number, file: string): string {
  return `<item><title>Photo ${id}</title><wp:post_id>${id}</wp:post_id>
    <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
    <wp:attachment_url>https://example.test/wp-content/uploads/${file}</wp:attachment_url>
    <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>${file}</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value>A photo</wp:meta_value></wp:postmeta>
  </item>`;
}

test("matches exact media paths before variants and does not guess from a filename", () => {
  const paths = [
    "https://example.test/wp-content/uploads/2026/photo-300x200.jpg",
    "https://example.test/wp-content/uploads/2026/Photo.jpg",
    "https://example.test/wp-content/uploads/2026/photo-150x100.jpg",
    "https://example.test/wp-content/uploads/2025/photo.jpg",
    "https://external.test/wp-content/uploads/2026/photo.jpg"
  ];
  const page = publishedPage("1").replace("</item>",
    `<content:encoded><![CDATA[${paths.map((src) => `<img src="${src}">`).join("")}]]></content:encoded></item>`);
  const project = parseWxr(wxrDocument(page,
    attachment(101, "2026/photo.jpg"), attachment(102, "2026/photo-300x200.jpg"), attachment(103, "2026/Photo.jpg")));

  assert.deepEqual(project.media.references.map((reference) => reference.assetId),
    ["media:102", "media:103", undefined, undefined, undefined]);
  assert.equal(project.media.summary.notInExport, 3);
});

test("collects images stored in Elementor text and HTML widgets", () => {
  const widgets = [
    { elType: "widget", widgetType: "text-editor", settings: { editor: '<img src="https://example.test/wp-content/uploads/text.jpg" alt="Text image">' } },
    { elType: "widget", widgetType: "html", settings: { html: '<img src="https://example.test/wp-content/uploads/html.jpg" alt="HTML image">' } }
  ];
  const page = publishedPage("1").replace("</item>", `<wp:postmeta><wp:meta_key>_elementor_data</wp:meta_key>
    <wp:meta_value><![CDATA[${JSON.stringify(widgets)}]]></wp:meta_value></wp:postmeta></item>`);
  const project = parseWxr(wxrDocument(page, attachment(101, "text.jpg"), attachment(102, "html.jpg")));

  assert.deepEqual(project.media.references.map((reference) => [reference.assetId, reference.altText]),
    [["media:101", "Text image"], ["media:102", "HTML image"]]);
});

test("keeps encoded and repeated-slash source paths intact in redirect rules", () => {
  for (const path of ["/caf%C3%A9/", "/a%2Fb/", "/double//slash/"]) {
    const page = publishedPage("1").replace("/example-page/", path);
    const project = parseWxr(wxrDocument(page));
    assert.equal(project.routes.entries[0]?.sourcePath, path);
    assert.deepEqual(project.routes.redirects.map((redirect) => [redirect.sourcePath, redirect.targetRoute]),
      path === "/double//slash/" ? [[path, "/double/slash/"]] : []);
  }
});

test("sanitizes protocol-relative URLs before putting them in inventories", () => {
  const page = publishedPage("1").replace("https://example.test/example-page/", "//private-user:private-password@example.test/page?private-query#private-fragment")
    .replace("</item>", '<content:encoded><![CDATA[<img src="//private-user:private-password@example.test/wp-content/uploads/photo.jpg?private-query#private-fragment">]]></content:encoded></item>');
  const project = parseWxr(wxrDocument(page, attachment(101, "photo.jpg")));

  assert.doesNotMatch(JSON.stringify({ media: project.media, routes: project.routes }), /private-user|private-password|private-query|private-fragment/);
  assert.equal(project.routes.entries[0]?.sourcePath, "/page");
  assert.equal(project.routes.entries[0]?.targetRoute, "/page/");
  assert.equal(project.media.references[0]?.assetId, "media:101");
});

test("matches WordPress image variants and keeps nested block provenance", () => {
  const files = ["photo-768x512.jpg", "photo-scaled.jpg", "photo-rotated.jpg", "photo-cropped.jpg", "photo-e1234567890123-scaled-300x200.jpg"];
  for (const file of files) {
    const content = `<!-- wp:group --><div><!-- wp:image {"id":101} -->
      <img src="https://example.test/wp-content/uploads/${file}" alt="A nested photo">
      <!-- /wp:image --></div><!-- /wp:group -->`;
    const page = publishedPage("1").replace("</item>", `<content:encoded><![CDATA[${content}]]></content:encoded></item>`);
    const project = parseWxr(wxrDocument(page, attachment(101, "photo.jpg")));
    assert.equal(project.media.references.length, 1);
    assert.equal(project.media.references[0]?.kind, "gutenberg-image");
    assert.equal(project.media.references[0]?.nodeId, "wp:page:1:gutenberg:2");
    assert.equal(project.media.references[0]?.altText, "A nested photo");
    assert.equal(project.media.references[0]?.assetId, "media:101");
  }
});

test("uses the upload path when an attachment has no URL and skips trashed uploads", () => {
  const media = attachment(101, "2026/photo.jpg").replace(/<wp:attachment_url>.*?<\/wp:attachment_url>/, "");
  const trashed = attachment(102, "trash.jpg").replace("<wp:status>inherit", "<wp:status>trash");
  const page = publishedPage("1").replace("</item>", '<content:encoded><![CDATA[<img src="https://example.test/wp-content/uploads/2026/photo-300x200.jpg">]]></content:encoded></item>');
  const project = parseWxr(wxrDocument(page, media, trashed, attachment(103, "unused.jpg")));
  assert.equal(project.media.references[0]?.assetId, "media:101");
  assert.equal(project.media.summary.assets, 2);
  assert.equal(project.media.summary.unusedAssets, 1);
  assert.deepEqual(project.issues, [], "unreferenced uploads must not trip the warning gate");
});
