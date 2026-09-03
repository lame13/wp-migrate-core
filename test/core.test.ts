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
