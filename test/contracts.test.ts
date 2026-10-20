import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MIGRATION_CONFIG_ARCHIVE_KEYS,
  MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES,
  MIGRATION_CONFIG_FAILURE_THRESHOLDS,
  MIGRATION_CONFIG_KEYS,
  MIGRATION_CONFIG_MEDIA_KEYS,
  MIGRATION_CONFIG_POST_TYPE_KEYS,
  MIGRATION_CONFIG_SITE_KEYS,
  migrationConfigSchemaVersion,
  parseMigrationConfig
} from "../src/config.js";
import {
  apiContractVersion,
  apiStability,
  artifactContracts,
  artifactSchemaVersions,
  migrationConfigJsonSchema
} from "../src/contracts.js";
import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import { importReportSchemaVersion } from "../src/import-report.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generateNextProject } from "../src/next.js";
import { generatePayloadBundle } from "../src/payload.js";
import { generatePruviousBundle } from "../src/pruvious.js";
import { MIGRATION_ISSUE_CODES } from "../src/types.js";
import type { OutputTarget } from "../src/types.js";
import { demoFixturePath } from "./fixture-path.js";

const fixturesRoot = join(demoFixturePath, "..");
const repository = process.cwd();

async function demoProject() {
  const parsed = parseWxr(await readFile(demoFixturePath, "utf8"));
  return applyMediaDelivery(
    parsed,
    await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") })
  );
}

async function generateFor(target: OutputTarget, directory: string): Promise<void> {
  const project = await demoProject();
  if (target === "astro") return generateAstroProject(project, directory);
  if (target === "next") return generateNextProject(project, directory);
  if (target === "payload") return generatePayloadBundle(project, directory);
  if (target === "pruvious") return generatePruviousBundle(project, directory);
  throw new Error(`No generator in this test writes ${target}.`);
}

test("every artifact a handoff writes carries the version the registry declares", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-contracts-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  const destinations = [...new Set(artifactContracts.flatMap((artifact) => artifact.destinations))];
  assert.deepEqual(destinations.slice().sort(), ["astro", "next", "payload", "pruvious"]);

  const directories = new Map<OutputTarget, string>();
  for (const target of destinations) {
    const directory = join(output, target);
    await generateFor(target, directory);
    directories.set(target, directory);
  }

  for (const artifact of artifactContracts) {
    for (const target of artifact.destinations) {
      const directory = directories.get(target) as string;
      const contents = await readFile(join(directory, artifact.file), "utf8");
      if (artifact.schemaVersion === null) {
        assert.ok(
          Array.isArray(JSON.parse(contents)),
          `${artifact.file} is an unversioned list for ${target}`
        );
        continue;
      }
      assert.equal(
        (JSON.parse(contents) as { schemaVersion?: string }).schemaVersion,
        artifact.schemaVersion,
        `${artifact.file} written for ${target}`
      );
    }
  }

  // The artifacts no destination writes, checked where they are produced.
  assert.equal(artifactSchemaVersions.migrationConfig, migrationConfigSchemaVersion);
  assert.equal(artifactSchemaVersions.importReport, importReportSchemaVersion);
  const payloadImporter = await readFile(join(directories.get("payload") as string, "import/import.mjs"), "utf8");
  const pruviousImporter = await readFile(
    join(directories.get("pruvious") as string, "server/api/migrate.post.ts"),
    "utf8"
  );
  for (const importer of [payloadImporter, pruviousImporter]) {
    assert.match(
      importer,
      new RegExp(`schemaVersion: ["']${artifactSchemaVersions.importReport}["']`),
      "the generated importer writes the version the registry declares"
    );
  }

  // `verify` writes the verification artefact through the CLI, so run it.
  const site = join(output, "built");
  await mkdir(site);
  const text = "Contract check page text.";
  await writeFile(
    join(site, "index.html"),
    `<html><head><link rel="canonical" href="https://brightpath.example/" /><title>Home</title></head><body><h1>Home</h1><p>${text}</p></body></html>`
  );
  const verificationPath = join(output, "migration-verification.json");
  execFileSync(
    process.execPath,
    [
      join(repository, "dist/src/cli.js"),
      "verify",
      demoFixturePath,
      "--html-dir",
      site,
      "--out",
      verificationPath,
      "--fail-on",
      "none"
    ],
    { cwd: output, encoding: "utf8", stdio: "pipe" }
  );
  assert.equal(
    (JSON.parse(await readFile(verificationPath, "utf8")) as { schemaVersion?: string }).schemaVersion,
    artifactSchemaVersions.verification
  );
});

test("the artifact registry and its documentation describe the same files", async () => {
  const page = await readFile(join(repository, "docs", "artifacts.md"), "utf8");
  const missing: string[] = [];

  for (const artifact of artifactContracts) {
    // Several artifacts share a file name — the manifest is written by four
    // destinations — so the row has to name the id as well as the path.
    const row = page
      .split("\n")
      .find((line) => line.includes(`\`${artifact.file}\``) && line.includes(`\`${artifact.id}\``));
    if (row === undefined) {
      missing.push(`${artifact.id} (${artifact.file})`);
      continue;
    }
    const version = artifact.schemaVersion === null ? "unversioned" : `\`${artifact.schemaVersion}\``;
    if (!row.includes(version)) missing.push(`${artifact.id} at ${String(artifact.schemaVersion)}`);
  }

  assert.deepEqual(
    missing,
    [],
    "Every artifact in src/contracts.ts needs a row in docs/artifacts.md naming its file, its id and its version."
  );

  const compatibility = await readFile(join(repository, "docs", "compatibility.md"), "utf8");
  assert.match(compatibility, /api\.md/);
  assert.match(compatibility, /artifacts\.md/);
  assert.equal(apiContractVersion, "1.0");
  assert.equal(apiStability, "stable", "1.0.0 is the release that flips this to stable");
});

test("the published config schema accepts exactly what the parser accepts", () => {
  const schema = migrationConfigJsonSchema as {
    properties: Record<string, Record<string, unknown>>;
    propertyNames: { enum: readonly string[] };
    additionalProperties: boolean;
  };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.propertyNames.enum, MIGRATION_CONFIG_KEYS);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...MIGRATION_CONFIG_KEYS].sort());

  const nested = (name: string): { properties: Record<string, unknown>; propertyNames: { enum: readonly string[] } } =>
    schema.properties[name] as never;
  assert.deepEqual(nested("site").propertyNames.enum, MIGRATION_CONFIG_SITE_KEYS);
  assert.deepEqual(Object.keys(nested("site").properties).sort(), [...MIGRATION_CONFIG_SITE_KEYS].sort());
  assert.deepEqual(nested("postTypes").propertyNames.enum, MIGRATION_CONFIG_POST_TYPE_KEYS);
  assert.deepEqual(nested("archives").propertyNames.enum, MIGRATION_CONFIG_ARCHIVE_KEYS);
  assert.deepEqual(nested("media").propertyNames.enum, MIGRATION_CONFIG_MEDIA_KEYS);

  assert.deepEqual(schema.properties.failOn?.enum, MIGRATION_CONFIG_FAILURE_THRESHOLDS);
  const archives = nested("archives").properties as Record<string, { enum?: readonly string[] }>;
  assert.deepEqual(archives.attachmentPages?.enum, MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES);
  const ignoreIssues = schema.properties.ignoreIssues as { items: { enum: readonly string[] } };
  assert.deepEqual(ignoreIssues.items.enum, MIGRATION_ISSUE_CODES);

  // Every documented setting is accepted, and every object refuses a setting
  // the schema does not describe. That is the pair of promises the schema and
  // the parser have to keep together.
  const accepted = {
    schemaVersion: migrationConfigSchemaVersion,
    site: { title: "Bright Path Plumbing", url: "https://brightpath.example" },
    includeDrafts: true,
    keepSourceLinks: true,
    failOn: "blocker",
    routes: { "?p=123": "/about/" },
    exclude: ["wp:page:404"],
    ignoreIssues: [MIGRATION_ISSUE_CODES[0]],
    postTypes: { include: ["page"], exclude: ["revision"] },
    archives: {
      taxonomies: true,
      authors: false,
      dates: true,
      postsIndex: "/blog/",
      perPage: 10,
      feeds: ["/feed/"],
      attachmentPages: "redirect"
    },
    media: { uploadsDir: "./uploads", baseUrl: "https://cdn.example.com/uploads", copyUnused: true }
  };
  assert.doesNotThrow(() => parseMigrationConfig(JSON.stringify(accepted)));

  const refused: readonly [string, object][] = [
    ["top level", { ...accepted, unknownSetting: true }],
    ["site", { ...accepted, site: { title: "x", unknownSetting: true } }],
    ["postTypes", { ...accepted, postTypes: { include: ["page"], unknownSetting: true } }],
    ["archives", { ...accepted, archives: { taxonomies: true, unknownSetting: true } }],
    ["media", { ...accepted, media: { copyUnused: true, unknownSetting: true } }]
  ];
  for (const [label, config] of refused) {
    assert.throws(
      () => parseMigrationConfig(JSON.stringify(config)),
      /no setting named "unknownSetting"/,
      `the parser refuses an unknown key under ${label}`
    );
  }
});
