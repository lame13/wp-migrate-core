import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseWxr } from "../src/core.js";
import { importLaunchFindings, readImportEvidence } from "../src/import-report.js";
import type { ImportRecord } from "../src/types.js";
import { verifySite } from "../src/verify.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");

function wxrDocument(...items: readonly string[]): string {
  return ["<rss><channel>", "<title>Example site</title>", "<link>https://example.test/</link>", ...items, "</channel></rss>"].join("");
}

function item(options: { id: number; slug: string; type: string; author?: string; category?: string }): string {
  return [
    "<item>",
    `<title>${options.slug}</title>`,
    `<link>https://example.test/${options.slug}/</link>`,
    `<wp:post_id>${options.id}</wp:post_id>`,
    `<wp:post_type>${options.type}</wp:post_type>`,
    "<wp:status>publish</wp:status>",
    `<wp:post_name>${options.slug}</wp:post_name>`,
    ...(options.author === undefined ? [] : [`<dc:creator><![CDATA[${options.author}]]></dc:creator>`]),
    ...(options.category === undefined
      ? []
      : [`<category domain="category" nicename="${options.category}"><![CDATA[${options.category}]]></category>`]),
    "</item>"
  ].join("");
}

function project() {
  return parseWxr(
    wxrDocument(
      item({ id: 1, slug: "home", type: "page" }),
      item({ id: 20, slug: "tap", type: "post", author: "niko", category: "guides" })
    )
  );
}

function report(records: readonly ImportRecord[]): string {
  return JSON.stringify({
    schemaVersion: "0.9",
    generator: { name: "wp-migrate-core", version: "0.9.0", target: "payload" },
    generatedAt: "2026-10-07T00:00:00.000Z",
    destination: { target: "payload", kind: "cms", structure: "payload-next" },
    summary: { planned: records.length },
    records
  });
}

test("reads an import report and rebuilds its summary from the records", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-import-read-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "migration-import.json");
  await writeFile(
    path,
    report([
      { id: "wp:page:1", sourceId: "wp:page:1", collection: "pages", action: "created", unresolved: [] },
      { id: "wp:post:20", sourceId: "wp:post:20", collection: "posts", action: "unchanged", unresolved: [] },
      { id: "media:9", sourceId: "media:9", collection: "media", action: "created", unresolved: ["media:9"] }
    ])
  );

  const evidence = await readImportEvidence(path);
  assert.equal(evidence.observed, "import-report");
  assert.equal(evidence.target, "payload");
  assert.equal(evidence.summary.created, 2);
  assert.equal(evidence.summary.unchanged, 1);
  assert.equal(evidence.summary.unresolved, 1);

  await writeFile(join(workspace, "wrong.json"), JSON.stringify({ schemaVersion: "1.0", records: [] }));
  await assert.rejects(() => readImportEvidence(join(workspace, "wrong.json")), /reads schema 0.9/);
});

test("turns what the importer left undone into publishing findings", () => {
  const evidence = {
    observed: "import-report" as const,
    source: "migration-import.json",
    version: "0.9.0",
    generatedAt: "2026-10-07T00:00:00.000Z",
    target: "payload",
    summary: { planned: 4, created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 1, unresolved: 0 },
    records: [
      { id: "wp:page:1", sourceId: "wp:page:1", collection: "pages", action: "created" as const, unresolved: [] },
      // wp:post:20 is a planned record this report never mentions.
      {
        id: "wp:post:99",
        sourceId: "wp:post:99",
        collection: "posts",
        action: "skipped" as const,
        reason: "record-modified",
        unresolved: []
      },
      {
        id: "wp:page:404",
        sourceId: "wp:page:404",
        collection: "pages",
        action: "failed" as const,
        reason: "unique constraint",
        unresolved: []
      },
      // A content id the plan does not carry: imported, but nothing asked for it.
      { id: "wp:page:999", sourceId: "wp:page:999", collection: "pages", action: "created" as const, unresolved: [] },
      { id: "media:9", sourceId: "media:9", collection: "media", action: "created" as const, unresolved: [] },
      { id: "wp:term:category:guides", sourceId: "wp:term:category:guides", collection: "categories", action: "created" as const, unresolved: [] }
    ]
  };

  const findings = importLaunchFindings(project(), evidence);
  const codes = findings.map((finding) => finding.code).sort();
  assert.deepEqual(codes, [
    "IMPORT_RECORD_FAILED",
    "IMPORT_RECORD_MISSING",
    "IMPORT_RECORD_SKIPPED",
    "IMPORT_RECORD_UNKNOWN"
  ]);
  assert.equal(findings.find((finding) => finding.code === "IMPORT_RECORD_FAILED")?.severity, "blocker");
  assert.equal(findings.find((finding) => finding.code === "IMPORT_RECORD_MISSING")?.severity, "warning");
  assert.ok(
    findings.every((finding) => finding.source === "import-report"),
    "every import finding names the report it came from"
  );
});

test("verify answers the CMS question on its own, with no build or crawl report", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-import-verify-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "migration-import.json");
  await writeFile(
    path,
    report([
      { id: "wp:page:1", sourceId: "wp:page:1", collection: "pages", action: "created", unresolved: [] },
      { id: "wp:post:20", sourceId: "wp:post:20", collection: "posts", action: "failed", reason: "boom", unresolved: [] }
    ])
  );

  const verification = await verifySite(project(), { importReportPath: path });
  assert.equal(verification.observed, "import-report");
  assert.equal(verification.routes.length, 0);
  assert.equal(verification.imports?.summary.failed, 1);
  assert.equal(verification.checks.find((check) => check.id === "import")?.checked, true);
  assert.equal(verification.checks.find((check) => check.id === "content")?.checked, false);
  assert.equal(verification.summary.launchBlockers, 1);
});

test("unresolved imported relationships fail the warning gate", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-import-unresolved-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "migration-import.json");
  await writeFile(path, report([
    { id: "wp:page:1", sourceId: "wp:page:1", collection: "pages", action: "created", unresolved: ["media:99"] },
    { id: "wp:post:20", sourceId: "wp:post:20", collection: "posts", action: "unchanged", unresolved: [] }
  ]));
  const verification = await verifySite(project(), { importReportPath: path });
  assert.deepEqual(verification.launch.map((finding) => finding.code), ["IMPORT_REFERENCE_UNRESOLVED"]);
  assert.equal(verification.summary.launchWarnings, 1);
});

test("the CLI accepts --import-report on its own and refuses it elsewhere", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-import-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "export.xml"),
    wxrDocument(item({ id: 1, slug: "home", type: "page" }), item({ id: 20, slug: "tap", type: "post" }))
  );
  await writeFile(
    join(workspace, "migration-import.json"),
    report([
      { id: "wp:page:1", sourceId: "wp:page:1", collection: "pages", action: "created", unresolved: [] },
      { id: "wp:post:20", sourceId: "wp:post:20", collection: "posts", action: "created", unresolved: [] }
    ])
  );

  const verified = spawnSync(
    process.execPath,
    [cliPath, "verify", "export.xml", "--import-report", "migration-import.json", "--json"],
    { cwd: workspace, encoding: "utf8" }
  );
  assert.equal(verified.status, 0, verified.stderr);
  const document = JSON.parse(verified.stdout);
  assert.equal(document.schemaVersion, "0.9");
  assert.equal(document.observed.kind, "import-report");
  assert.equal(document.failed, false);
  assert.deepEqual(document.launch.findings, []);

  const rejected = spawnSync(
    process.execPath,
    [cliPath, "inspect", "export.xml", "--import-report", "migration-import.json"],
    { cwd: workspace, encoding: "utf8" }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /only supported by verify/);
});
