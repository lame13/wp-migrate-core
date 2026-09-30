import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadMigrationConfig, parseMigrationConfig } from "../src/config.js";
import { parseWxr } from "../src/core.js";
import { deliveryCheckTargets, deliveryRouteIndex } from "../src/delivery.js";
import { generateAstroProject } from "../src/generate.js";
import { renderReport } from "../src/report.js";

function wxrDocument(...items: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

function publishedPage(id: string, title: string, link = "https://example.test/example-page/"): string {
  return [
    "<item>",
    `<title>${title}</title>`,
    `<link>${link}</link>`,
    `<wp:post_id>${id}</wp:post_id>`,
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>example-page</wp:post_name>",
    "</item>"
  ].join("");
}

function draftPage(id: string, title: string): string {
  return publishedPage(id, title).replace("<wp:status>publish", "<wp:status>draft");
}

/**
 * A page that references one attachment whose record carries no alt text,
 * which is the finding the waiver test needs.
 */
function pageWithUndescribedImage(): readonly [string, string] {
  const page = publishedPage("1", "Page with an image").replace(
    "</item>",
    '<content:encoded><![CDATA[<img src="https://example.test/wp-content/uploads/2026/05/photo.jpg">]]></content:encoded></item>'
  );
  const attachment = [
    "<item><title>Photo</title><wp:post_id>101</wp:post_id>",
    "<wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>",
    "<wp:attachment_url>https://example.test/wp-content/uploads/2026/05/photo.jpg</wp:attachment_url>",
    "<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/05/photo.jpg</wp:meta_value></wp:postmeta>",
    "</item>"
  ].join("");

  return [page, attachment];
}

test("decides a query permalink instead of leaving it to a human", () => {
  const xml = wxrDocument(publishedPage("82", "Query permalink", "https://example.test/?p=82"));
  const project = parseWxr(xml, { config: { routes: { "?p=82": "/about/" } } });

  assert.equal(project.routes.entries[0]?.status, "generated");
  assert.equal(project.routes.entries[0]?.targetRoute, "/about/");
  assert.equal(project.records[0]?.route, "/about/");
  assert.deepEqual(
    project.routes.redirects,
    [],
    "a path rule cannot match a query string, so no rule may be invented for it"
  );
  assert.deepEqual(project.config?.decisions, {
    routes: 1,
    exclusions: 0,
    ignoredIssues: 0,
    ignoredIssueCodes: []
  });
});

test("routes an item by content id and keeps the exported path as a rule", () => {
  const xml = wxrDocument(publishedPage("12", "Moved page", "https://example.test/old-page/"));
  const project = parseWxr(xml, { config: { routes: { "wp:page:12": "/teams/plumbing/" } } });

  assert.equal(project.records[0]?.route, "/teams/plumbing/");
  assert.deepEqual(
    project.routes.redirects.map((redirect) => [redirect.sourcePath, redirect.targetRoute]),
    [["/old-page/", "/teams/plumbing/"]]
  );
});

test("accepts an exported path as a config key", () => {
  const xml = wxrDocument(publishedPage("12", "Moved page", "https://example.test/old-page/"));
  const project = parseWxr(xml, { config: { routes: { "/old-page/": "/new-page" } } });

  assert.equal(project.routes.entries[0]?.targetRoute, "/new-page/");
  assert.equal(project.config?.decisions.routes, 1);
});

test("does not match a query permalink with a config key for the home URL", () => {
  const project = parseWxr(wxrDocument(
    publishedPage("1", "Home", "https://example.test/"),
    publishedPage("2", "Query page", "https://example.test/?p=2")
  ), { config: { routes: { "https://example.test/": "/home/" } } });
  assert.equal(project.records[0]?.route, "/home/");
  assert.notEqual(project.records[1]?.route, "/home/");
  assert.equal(project.routes.entries[1]?.status, "ambiguous-url");
  assert.equal(project.routes.summary.duplicateRoutes, 0);
});

test("leaves out the items a config excludes and reports an entry that matched nothing", () => {
  const xml = wxrDocument(
    publishedPage("1", "Keep", "https://example.test/keep/"),
    publishedPage("2", "Drop", "https://example.test/drop/")
  );
  const project = parseWxr(xml, { config: { exclude: ["/drop/", "wp:page:99"] } });

  assert.deepEqual(
    project.records.map((record) => record.title),
    ["Keep"]
  );
  const dropped = project.routes.entries.find((entry) => entry.sourceId === "wp:page:2");
  assert.equal(dropped?.status, "excluded");
  assert.match(dropped?.reason ?? "", /migration config excludes/);

  const unmatched = project.issues.filter((issue) => issue.code === "CONFIG_ENTRY_UNMATCHED");
  assert.equal(unmatched.length, 1, "a stale exclusion has to be reported, not silently ignored");
  assert.match(unmatched[0]?.message ?? "", /wp:page:99/);
  assert.equal(project.config?.decisions.exclusions, 1);
});

test("keeps a waived finding visible without letting it gate the run", () => {
  const [page, attachment] = pageWithUndescribedImage();
  const waived = parseWxr(wxrDocument(page, attachment), {
    config: { ignoreIssues: ["MEDIA_MISSING_ALT_TEXT"] }
  });

  const issue = waived.issues.find((candidate) => candidate.code === "MEDIA_MISSING_ALT_TEXT");
  assert.equal(issue?.ignored, true, "the finding stays in the plan so a reviewer can see it");
  assert.equal(waived.summary.warnings, 0, "a waived finding must not trip --fail-on warning");
  assert.equal(waived.config?.decisions.ignoredIssues, 1);
  assert.ok(
    waived.records[0]?.issues.some((candidate) => candidate.code === "MEDIA_MISSING_ALT_TEXT" && candidate.ignored),
    "the record keeps the same waived finding"
  );

  const unwaived = parseWxr(wxrDocument(page, attachment));
  assert.equal(unwaived.summary.warnings > 0, true);
});

test("reads drafts and site details from the config", () => {
  const xml = wxrDocument(draftPage("3", "Unpublished"), publishedPage("4", "Published"));
  const project = parseWxr(xml, {
    config: { includeDrafts: true, site: { title: "Configured site", url: "https://staging.example/" } }
  });

  assert.deepEqual(
    project.records.map((record) => record.title),
    ["Unpublished", "Published"]
  );
  assert.equal(project.site.title, "Configured site");
  assert.equal(project.site.url, "https://staging.example/");
});

test("refuses a config it cannot apply", () => {
  assert.throws(() => parseMigrationConfig("{"), /is not valid JSON/);
  assert.throws(() => parseMigrationConfig("[]"), /must contain a JSON object/);
  assert.throws(() => parseMigrationConfig('{"routs":{}}'), /no setting named "routs"/);
  assert.throws(() => parseMigrationConfig('{"routes":{"wp:page:1":"new-page"}}'), /site-relative route/);
  assert.throws(() => parseMigrationConfig('{"routes":{"wp:page:1":""}}'), /non-empty string/);
  assert.throws(() => parseMigrationConfig('{"failOn":"maybe"}'), /must be one of none, warning, blocker/);
  assert.throws(() => parseMigrationConfig('{"schemaVersion":"9.9"}'), /reads schema 0.7/);
  assert.throws(() => parseMigrationConfig('{"ignoreIssues":["NOT_A_FINDING"]}'), /never reports/);
  assert.throws(() => parseMigrationConfig('{"media":{"uploadsDir":""}}'), /non-empty string/);
  assert.throws(() => parseMigrationConfig('{"media":{"baseUrl":"/uploads"}}'), /absolute http or https URL/);
  assert.throws(() => parseMigrationConfig('{"site":{"url":"ftp://example.test"}}'), /absolute http or https URL/);
  assert.throws(() => parseMigrationConfig('{"exclude":"wp:page:1"}'), /must be an array of strings/);
});

test("reads a config file and resolves its uploads directory next to it", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-config-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const configPath = join(workspace, "wp-migrate-core.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "0.7",
      site: { title: "Configured site" },
      media: { uploadsDir: "uploads" }
    })
  );

  const loaded = await loadMigrationConfig(configPath);
  assert.equal(loaded.source, resolve(configPath));
  assert.equal(loaded.config.media?.uploadsDir, resolve(workspace, "uploads"));

  const project = parseWxr(wxrDocument(publishedPage("1", "Page")), { config: loaded.config });
  assert.equal(project.site.title, "Configured site");
});

test("reports a config file it cannot read", async () => {
  await assert.rejects(loadMigrationConfig("does-not-exist.config.json"), /Cannot read the migration config/);
});

test("keeps the WordPress source URL when the config changes the route and site URL", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-config-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(publishedPage("12", "Moved page", "https://example.test/old-page/")), {
    config: { routes: { "wp:page:12": "/new-page/" }, site: { url: "https://new.example.test/" } }
  });
  assert.equal(deliveryCheckTargets(project)[0]?.sourceUrl, "https://example.test/old-page/");
  assert.equal(deliveryRouteIndex(project).byPath.get("/old-page/"), "/new-page/");
  const output = join(root, "site");
  await generateAstroProject(project, output);
  const manifest = JSON.parse(await readFile(join(output, "migration/manifest.json"), "utf8"));
  assert.equal(manifest.records[0].sourceUrl, "https://example.test/old-page/");
});

test("omits private URL fields from config findings and route explanations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-config-privacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const permalink = "https://private-user:private-password@example.test/old-page/?token=private-query";
  const project = parseWxr(wxrDocument(publishedPage("12", "Page", permalink)), {
    config: { routes: { [permalink]: "/new-page/" }, exclude: ["https://private-user:private-password@example.test/gone/?token=private-query"] }
  });
  const output = join(root, "site");
  await generateAstroProject(project, output);
  for (const file of ["redirects.json", "issues.json"]) {
    const contents = await readFile(join(output, "migration", file), "utf8");
    assert.doesNotMatch(contents, /private-user|private-password|private-query|token=/);
  }
  assert.doesNotMatch(renderReport(project), /private-user|private-password|private-query|token=/);
});
