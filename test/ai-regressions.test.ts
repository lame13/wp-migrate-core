import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyDecisionsToProject } from "../src/ai/apply.js";
import { askJson, AiBudget, embedWithCache } from "../src/ai/ask.js";
import { AiCache } from "../src/ai/cache.js";
import { parseAiConfig } from "../src/ai/config.js";
import { createOpenAICompatibleProvider, type AiProvider } from "../src/ai/provider.js";
import { runRepair } from "../src/ai/repair.js";
import { runAssist } from "../src/ai/run.js";
import { parseWxr } from "../src/core.js";
import { demoFixturePath } from "./fixture-path.js";

const config = parseAiConfig(JSON.stringify({
  schemaVersion: "0.1",
  provider: { baseUrl: "https://example.test/v1", model: "test", embeddingsModel: "embed" },
  cache: { enabled: false }
}));

test("all metadata jobs redact provider inputs, including relative URL queries", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "wpmc-private-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const plan = join(directory, "plan");
  await mkdir(plan);
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const privateText = "Contact jane@example.test +1 (212) 555-1234 /contact/?token=secret-query";
  await writeFile(join(plan, "migration-plan.json"), JSON.stringify({
    ...project,
    site: { ...project.site, title: privateText },
    records: project.records.map((record) => ({ ...record, title: privateText }))
  }));
  await writeFile(join(plan, "issues.json"), JSON.stringify(project.issues.map((issue) => ({
    ...issue, requiredAction: privateText
  }))));
  await writeFile(join(plan, "media.json"), JSON.stringify({
    ...project.media,
    assets: project.media.assets.map((asset) => ({ ...asset, id: `${asset.id}1234567`, title: privateText })),
    references: project.media.references.map((reference) => ({ ...reference, assetId: `${reference.assetId}1234567` }))
  }));
  await writeFile(join(plan, "coverage.json"), JSON.stringify({
    entries: [{ status: "uncovered", path: "/old/?token=secret-query" }]
  }));
  const called = new Set<string>();
  const check = (value: string): void => {
    assert.doesNotMatch(value, /jane@example|555-1234|secret-query/);
  };
  const provider: AiProvider = {
    info: { endpoint: "example.test/v1", model: "test", embeddingsModel: "embed" },
    async chat(request) {
      check(request.user);
      called.add(request.schemaName);
      const ids = [...request.user.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
      if (request.schemaName === "alternative_text_batch") assert.ok(ids.every((id) => id?.endsWith("1234567")), "redaction preserves stable asset identifiers");
      const result = request.schemaName === "migration_triage"
        ? { summary: "Review the queue.", workOrder: [], risks: [], questions: [] }
        : request.schemaName === "alternative_text_batch"
          ? { items: ids.map((id) => ({ id, altText: "Tap repair", decorative: false, confidence: "low", reason: "Page context." })) }
          : { mappings: [] };
      return { text: JSON.stringify(result), model: "test" };
    },
    async embed(inputs) {
      inputs.forEach(check);
      called.add("embeddings");
      return inputs.map(() => [1, 0]);
    }
  };
  for (const job of ["triage", "alt-text", "shortcodes", "routes"] as const) {
    await runAssist({ planDirectory: plan, outputDirectory: join(directory, job), job, config, provider });
  }
  assert.deepEqual([...called].sort(), ["alternative_text_batch", "embeddings", "migration_triage", "shortcode_and_widget_mappings"]);
  const review = await readFile(join(directory, "triage/review.html"), "utf8");
  assert.doesNotMatch(review, /No suggestions were produced|assist apply suggestions/);
});

test("chat and embeddings caches are isolated by provider endpoint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "wpmc-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new AiCache(directory, true);
  let calls = 0;
  for (const endpoint of ["first.test/v1", "second.test/v1", "second.test/v1"]) {
    const provider: AiProvider = {
      info: { endpoint, model: "same-model", embeddingsModel: "same-embed" },
      async chat() { calls += 1; return { text: JSON.stringify(endpoint), model: "same-model" }; },
      async embed() { calls += 1; return [endpoint.startsWith("first") ? [1, 0] : [0, 1]]; }
    };
    const answer = await askJson({
      provider, cache, budget: new AiBudget(config.limits), promptVersion: "test/1", schemaName: "test",
      schema: { type: "string" }, system: "Return JSON", user: "Hello",
      validate: (value) => { assert.equal(typeof value, "string"); return value; }
    });
    assert.equal(answer.value, endpoint);
    assert.deepEqual(await embedWithCache(provider, cache, ["same text"]), [endpoint.startsWith("first") ? [1, 0] : [0, 1]]);
  }
  assert.equal(calls, 4, "each provider is called once per operation, then reused");
});

test("embeddings honor response indexes and reject ambiguous vectors", async () => {
  const embed = async (data: unknown[]) => createOpenAICompatibleProvider(config.provider, {
    env: {}, fetchImpl: async () => new Response(JSON.stringify({ data }))
  }).embed(["first", "second"]);
  assert.deepEqual(await embed([
    { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }
  ]), [[1, 0], [0, 1]]);
  for (const data of [
    [{ index: 0, embedding: [1] }, { index: 0, embedding: [0] }],
    [{ index: 0, embedding: [1] }, { embedding: [0] }],
    [{ index: 0, embedding: [1] }, { index: 2, embedding: [0] }]
  ]) await assert.rejects(embed(data), /indexes/);
  await assert.rejects(embed([{ embedding: [1] }, { embedding: [1, 0] }]), /dimensions/);
});

test("alt-text decisions preserve authored and decorative descriptions", async () => {
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const missing = project.media.references.find((reference) => reference.status === "missing-alt-text");
  assert.ok(missing?.assetId);
  const references = [
    missing,
    { ...missing, id: "authored", status: "matched" as const, altText: "An existing description" },
    { ...missing, id: "decorative", status: "matched" as const, altText: "" }
  ];
  const result = applyDecisionsToProject({ ...project, media: { ...project.media, references } }, {
    schemaVersion: "0.1", altText: { [missing.assetId]: "An accepted draft" }
  });
  assert.deepEqual(result.media.references.map((reference) => reference.altText), ["An accepted draft", "An existing description", ""]);
  assert.equal(result.media.references[0]?.status, "matched");
});

test("repair requires content permission and refuses redacted or truncated pages", async () => {
  const provider: AiProvider = {
    info: { endpoint: "test.invalid", model: "test" },
    async chat() { assert.fail("These pages must never reach the provider"); },
    async embed() { return []; }
  };
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const base = project.records[0];
  assert.ok(base);
  const options = {
    records: [], config, provider, cache: new AiCache("unused", false), budget: new AiBudget(config.limits), maxItems: 2
  };
  await assert.rejects(runRepair(options), /privacy.send/);
  const records = ["<p>Contact jane@example.test</p>", `<p>${"word ".repeat(2500)}</p>`].map((rawContent) => ({
    ...base, rawContent, issues: [{
      id: "unclosed", sourceId: base.sourceId, code: "GUTENBERG_UNCLOSED_BLOCK" as const,
      severity: "warning" as const, title: "Unclosed block", message: "Unclosed block", requiredAction: "Close it."
    }]
  }));
  const result = await runRepair({ ...options, records, config: { ...config, privacy: { ...config.privacy, send: "content" } } });
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.status === "rejected"));
  assert.match(result[0]?.reason ?? "", /redact page content/);
  assert.match(result[1]?.reason ?? "", /12,000-character/);
});

test("hand-edited repair decisions cannot bypass text-loss validation", async () => {
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const record = project.records.find((entry) => entry.rawContent.length > 200);
  assert.ok(record);
  assert.throws(() => applyDecisionsToProject(project, {
    schemaVersion: "0.1", contentPatches: { [record.sourceId]: { html: "<p>Gone</p>", issueCodes: [] } }
  }), /removed too much/);
});

test("applying one widget mapping keeps other component mappings unresolved", async () => {
  const project = parseWxr(await readFile(demoFixturePath, "utf8"));
  const result = applyDecisionsToProject(project, {
    schemaVersion: "0.1",
    shortcodes: {
      "elementor-widget:posts": { action: "remove" },
      "elementor-widget:essential-addons-testimonial-slider": { action: "component", component: "Testimonials" }
    }
  });
  assert.ok(result.records.find((record) => record.sourceId === "wp:page:11")?.issues.some(
    (issue) => issue.code === "ELEMENTOR_WIDGET_UNKNOWN"
  ), "naming a component does not implement it or resolve its finding");
});
