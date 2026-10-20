import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyDecisionsToProject,
  decisionsFromSuggestions,
  mergeDecisionRoutes,
  parseDecisions
} from "../src/ai/apply.js";
import { parseAiConfig } from "../src/ai/config.js";
import { AiBudget } from "../src/ai/ask.js";
import { AiCache } from "../src/ai/cache.js";
import type { AiChatRequest, AiProvider } from "../src/ai/provider.js";
import { runAssist } from "../src/ai/run.js";
import { runRepair } from "../src/ai/repair.js";
import { parseWxr } from "../src/core.js";
import type { AiConfig, AiSuggestionsDocument } from "../src/ai/types.js";
import type { MigrationIssue } from "../src/types.js";
import { demoFixturePath } from "./fixture-path.js";

function config(): AiConfig {
  return parseAiConfig(
    JSON.stringify({
      schemaVersion: "0.1",
      provider: { baseUrl: "https://api.example.test/v1", model: "mock-model" },
      cache: { enabled: false }
    })
  );
}

function issue(code: MigrationIssue["code"], title: string, sourceId: string, route?: string): MigrationIssue {
  return {
    id: `${sourceId}:${code}:1`,
    severity: code === "SHORTCODE_UNSUPPORTED" ? "blocker" : "warning",
    code,
    sourceId,
    ...(route === undefined ? {} : { route }),
    title,
    message: title,
    requiredAction: "Review this finding."
  };
}

function triageProvider(): AiProvider {
  return {
    info: { endpoint: "api.example.test/v1", model: "mock-model", embeddingsModel: "mock-embed" },
    async chat(request: AiChatRequest) {
      if (request.schemaName === "migration_triage") {
        return {
          text: JSON.stringify({
            summary: "Resolve the blocked form first, then the metadata.",
            workOrder: [
              {
                rank: 1,
                title: "Replace the contact form",
                codes: ["SHORTCODE_UNSUPPORTED"],
                impact: "The contact page cannot launch with a dead form.",
                action: "Choose a form backend and rebuild the form.",
                effort: "medium",
                owner: "developer",
                findingCount: 1,
                whyFirst: "It is the only blocker."
              }
            ],
            risks: ["The form provider may need DNS changes."],
            questions: ["Which form backend is approved?"]
          }),
          model: "mock-model"
        };
      }
      if (request.schemaName === "shortcode_and_widget_mappings") {
        const keys = [...request.user.matchAll(/"key":"([^"]+)"/g)].map((match) => match[1] as string);
        return {
          text: JSON.stringify({
            mappings: keys.map((key) => ({
              key,
              strategy: "static-fallback",
              fallbackText: "This form needs to be rebuilt with an approved provider.",
              reason: "The shortcode executed inside WordPress.",
              confidence: "medium"
            }))
          }),
          model: "mock-model"
        };
      }
      return { text: "{}", model: "mock-model" };
    },
    async embed(inputs) {
      return inputs.map((input) => (/\btap\b/i.test(input) ? [1, 0] : [0, 1]));
    }
  };
}

test("triage reads the issue queue, writes a brief and never needs the export", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-triage-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const plan = join(workspace, "plan");
  const output = join(workspace, "ai");
  await mkdir(plan, { recursive: true });
  await writeFile(
    join(plan, "issues.json"),
    JSON.stringify([
      issue("SHORTCODE_UNSUPPORTED", "Shortcode [gravityform] cannot be executed by the generated site.", "wp:page:1")
    ])
  );
  await writeFile(
    join(plan, "migration-plan.json"),
    JSON.stringify({
      site: { title: "Bright Path Plumbing" },
      summary: { records: 1, warnings: 0, blockers: 1 },
      records: [{ sourceId: "wp:page:1", title: "Contact", route: "/contact/", type: "page" }],
      issues: []
    })
  );

  const result = await runAssist({
    planDirectory: plan,
    outputDirectory: output,
    job: "triage",
    config: config(),
    provider: triageProvider(),
    now: () => new Date("2026-10-20T00:00:00.000Z")
  });

  assert.equal(result.items, 0);
  assert.ok(result.brief);
  const brief = await readFile(result.brief, "utf8");
  assert.match(brief, /Migration brief — Bright Path Plumbing/);
  assert.match(brief, /Replace the contact form/);
  assert.match(brief, /Which form backend is approved/);
  const suggestions = JSON.parse(await readFile(result.suggestions, "utf8")) as AiSuggestionsDocument;
  assert.equal(suggestions.triage?.workOrder[0]?.codes[0], "SHORTCODE_UNSUPPORTED");
  const run = JSON.parse(await readFile(result.run, "utf8"));
  assert.equal(run.provider.endpoint, "api.example.test/v1");
  assert.equal(run.job, "triage");
  assert.doesNotMatch(await readFile(result.run, "utf8"), /sk-/);
});

test("alt text deduplicates one asset and applies only after a decision", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-alt-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const asset = project.media.assets.find((entry) =>
    project.media.references.some(
      (reference) => reference.assetId === entry.id && reference.status === "missing-alt-text"
    )
  );
  assert.ok(asset);
  const references = project.media.references.filter((reference) => reference.assetId === asset.id);
  const plan = join(workspace, "plan");
  await mkdir(plan, { recursive: true });
  await writeFile(
    join(plan, "media.json"),
    JSON.stringify({
      schemaVersion: "0.7",
      assets: [asset],
      references
    })
  );
  await writeFile(
    join(plan, "migration-plan.json"),
    JSON.stringify({
      site: { title: "Bright Path Plumbing" },
      records: references.map((reference) => ({
        sourceId: reference.sourceId,
        title: "Service page",
        route: reference.route
      }))
    })
  );

  const provider: AiProvider = {
    info: { endpoint: "api.example.test/v1", model: "mock-model" },
    async chat() {
      return {
        text: JSON.stringify({
          items: [
            {
              id: asset.id,
              altText: "A plumber repairing a leaking tap under a sink.",
              decorative: false,
              confidence: "high",
              reason: "The page describes a tap repair service."
            }
          ]
        }),
        model: "mock-model"
      };
    },
    async embed() {
      return [];
    }
  };
  const result = await runAssist({
    planDirectory: plan,
    outputDirectory: join(workspace, "ai"),
    job: "alt-text",
    config: config(),
    provider
  });
  const suggestions = JSON.parse(await readFile(result.suggestions, "utf8")) as AiSuggestionsDocument;
  assert.equal(suggestions.items.length, 1);
  assert.equal(suggestions.items[0]?.kind, "alt-text");

  const decisions = decisionsFromSuggestions(suggestions, new Set(["alt-text"]));
  const decided = applyDecisionsToProject(project, decisions);
  assert.equal(decided.media.assets.find((entry) => entry.id === asset.id)?.altText, "A plumber repairing a leaking tap under a sink.");
  assert.ok(
    decided.media.references
      .filter((reference) => reference.assetId === asset.id)
      .every((reference) => reference.status === "matched")
  );
});

test("shortcode mappings replace the shortcode and remove the resolved finding", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-map-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const record = project.records.find((entry) => entry.rawContent.includes("[gravityform"));
  assert.ok(record);
  const plan = join(workspace, "plan");
  await mkdir(plan, { recursive: true });
  await writeFile(
    join(plan, "issues.json"),
    JSON.stringify(record.issues.filter((entry) => entry.code === "SHORTCODE_UNSUPPORTED"))
  );

  const result = await runAssist({
    planDirectory: plan,
    outputDirectory: join(workspace, "ai"),
    job: "shortcodes",
    config: config(),
    provider: triageProvider()
  });
  const suggestions = JSON.parse(await readFile(result.suggestions, "utf8")) as AiSuggestionsDocument;
  assert.equal(suggestions.items[0]?.kind, "mapping");
  assert.equal(suggestions.items[0]?.key, "shortcode:gravityform");

  const decisions = decisionsFromSuggestions(suggestions, new Set(["shortcodes"]));
  const decided = applyDecisionsToProject(project, decisions);
  const changed = decided.records.find((entry) => entry.sourceId === record.sourceId);
  assert.ok(changed);
  assert.doesNotMatch(changed.rawContent, /\[gravityform/);
  assert.match(changed.rawContent, /needs to be rebuilt with an approved provider/);
  assert.ok(!changed.issues.some((entry) => entry.code === "SHORTCODE_UNSUPPORTED"));
});

test("route matching only chooses an existing plan route and applies as a config decision", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-route-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const plan = join(workspace, "plan");
  await mkdir(plan, { recursive: true });
  await writeFile(
    join(plan, "migration-plan.json"),
    JSON.stringify({
      site: { title: "Bright Path Plumbing" },
      records: [
        { sourceId: "wp:page:1", title: "Stop a leaking tap", route: "/guides/stop-a-leaking-tap/", type: "page" },
        { sourceId: "wp:page:2", title: "Pricing", route: "/pricing/", type: "page" }
      ]
    })
  );
  await writeFile(
    join(plan, "coverage.json"),
    JSON.stringify({
      schemaVersion: "0.4",
      entries: [{ id: "url:1", path: "/old-tap/", status: "uncovered" }]
    })
  );

  const result = await runAssist({
    planDirectory: plan,
    outputDirectory: join(workspace, "ai"),
    job: "routes",
    config: config(),
    provider: triageProvider()
  });
  const suggestions = JSON.parse(await readFile(result.suggestions, "utf8")) as AiSuggestionsDocument;
  assert.equal(suggestions.items[0]?.kind, "route");
  assert.equal(suggestions.items[0]?.targetRoute, "/guides/stop-a-leaking-tap/");

  const decisions = decisionsFromSuggestions(suggestions, new Set(["routes"]));
  const merged = mergeDecisionRoutes(undefined, decisions);
  assert.equal(merged?.routes?.["/old-tap/"], "/guides/stop-a-leaking-tap/");
  const planned = applyDecisionsToProject(parseWxr(await readFile(demoFixturePath, "utf8"), {
    ...(merged === undefined ? {} : { config: merged })
  }), decisions);
  assert.ok(
    planned.routes.redirects.some(
      (redirect) =>
        redirect.sourcePath === "/old-tap/" &&
        redirect.targetRoute === "/guides/stop-a-leaking-tap/"
    ),
    "the accepted route decision becomes a deterministic redirect rule"
  );
  assert.doesNotThrow(() => parseDecisions(JSON.stringify(decisions)));
});

test("content repair must survive the parser before it can become a decision", async () => {
  const parsed = parseWxr(syntheticWxr("<!-- wp:paragraph -->\n<p>Hello world</p>"));
  const record = parsed.records[0];
  assert.ok(record);
  assert.ok(record.issues.some((entry) => entry.code === "GUTENBERG_UNCLOSED_BLOCK"));
  const provider: AiProvider = {
    info: { endpoint: "api.example.test/v1", model: "mock-model" },
    async chat() {
      return {
        text: JSON.stringify({
          repairedHtml: "<!-- wp:paragraph -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->",
          changes: ["Closed the paragraph block."],
          confidence: "high",
          reason: "The paragraph lacked its closing marker."
        }),
        model: "mock-model"
      };
    },
    async embed() {
      return [];
    }
  };
  const suggestions = await runRepair({
    records: [record],
    config: config(),
    provider,
    cache: new AiCache(join(tmpdir(), "unused"), false),
    budget: new AiBudget(config().limits),
    maxItems: 1
  });
  assert.equal(suggestions[0]?.status, "suggested");
  assert.match(suggestions[0]?.repairedHtml ?? "", /\/wp:paragraph/);
});

function syntheticWxr(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Test</title>
    <link>https://example.test</link>
    <wp:wxr_version>1.2</wp:wxr_version>
    <item>
      <title>Test page</title>
      <link>https://example.test/test/</link>
      <dc:creator>tester</dc:creator>
      <content:encoded><![CDATA[${content}]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date>2026-01-01 00:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
      <wp:comment_status>closed</wp:comment_status>
      <wp:ping_status>closed</wp:ping_status>
      <wp:post_name>test</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_parent>0</wp:post_parent>
      <wp:menu_order>0</wp:menu_order>
      <wp:post_type>page</wp:post_type>
      <wp:post_password></wp:post_password>
      <wp:is_sticky>0</wp:is_sticky>
    </item>
  </channel>
</rss>`;
}
