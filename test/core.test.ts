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
  assert.throws(() => assertTargetEnabled("next"), /planned but disabled/);
  assert.throws(() => assertTargetEnabled("nuxt"), /planned but disabled/);
});
