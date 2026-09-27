import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentEvidenceFromText, extractContentEvidence } from "routelint";
import type { PageSnapshot } from "routelint";
import { AUDIT_SCHEMA_VERSION } from "ssrwire";
import { parseWxr } from "../src/core.js";
import { sourceContentEvidence, verifySite } from "../src/verify.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");

/** Long enough to clear the "too little text to judge" floor. */
const carried =
  "Ten green bottles hanging on the wall and if one green bottle should accidentally fall there would be nine green bottles hanging on the wall";
/** Unrelated text of a similar size, used for the page that shrank. */
const unrelated = "Completely unrelated wording about a different subject entirely";

interface FixtureItem {
  readonly id: number;
  readonly slug: string;
  readonly content: string;
}

function fixtureXml(): string {
  const items: readonly FixtureItem[] = [
    { id: 1, slug: "carried", content: `<p>${carried}</p>` },
    { id: 2, slug: "shrunk", content: `<p>${carried}</p>` },
    { id: 3, slug: "blank", content: `<p>${carried}</p>` },
    { id: 4, slug: "absent", content: `<p>${carried}</p>` },
    { id: 5, slug: "tiny", content: "<p>Three little words</p>" }
  ];

  const entries = items
    .map(
      (item) => `    <item>
      <title>${item.slug}</title>
      <link>https://example.invalid/${item.slug}/</link>
      <content:encoded><![CDATA[${item.content}]]></content:encoded>
      <wp:post_id>${item.id}</wp:post_id>
      <wp:post_date>2026-01-01 00:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
      <wp:status>publish</wp:status>
      <wp:post_name>${item.slug}</wp:post_name>
      <wp:post_type>page</wp:post_type>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Verification fixture</title>
    <link>https://example.invalid</link>
    <wp:wxr_version>1.2</wp:wxr_version>
${entries}
  </channel>
</rss>
`;
}

function fixtureProject() {
  return parseWxr(fixtureXml());
}

async function writePage(
  root: string,
  segment: string,
  body: string,
  options: { readonly title?: string } = {}
): Promise<void> {
  const directory = join(root, segment);
  await mkdir(directory, { recursive: true });
  const head = options.title === undefined ? "" : `<title>${options.title}</title>`;
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
    "utf8"
  );
}

/** A built site that exercises every outcome the comparison can report. */
async function writeBuiltSite(site: string): Promise<void> {
  await writePage(site, "carried", `<h1>Carried</h1><p>${carried}</p>`, { title: "Carried" });
  await writePage(site, "shrunk", `<h1>Shrunk</h1><p>${unrelated}</p>`, { title: "Shrunk" });
  // Deliberately has no <title>.
  await writePage(site, "blank", "<h1>Blank</h1>");
  await writePage(site, "tiny", "<h1>Tiny</h1><p>Three little words</p>", { title: "Tiny" });
  // No page is written for the `absent` record.
}

interface ReportPage {
  readonly url: string;
  readonly html: string;
  readonly title: string;
  readonly snapshot?: Partial<PageSnapshot>;
}

/** The smallest report RouteLint's own parser accepts. */
function routeLintReport(pages: readonly ReportPage[], baseUrl = "https://example.invalid/") {
  return {
    schemaVersion: "4",
    toolVersion: "0.4.0",
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    baseUrl,
    config: {
      maxPages: 25,
      maxDepth: 3,
      agents: ["browser"],
      respectRobots: true,
      queryPolicy: "drop"
    },
    sitemap: { requested: [], fetched: [], entries: [], warnings: [] },
    routes: pages.map((page) => ({
      url: page.url,
      depth: 0,
      sources: [{ kind: "seed" }],
      snapshots: [
        {
          requestedUrl: page.url,
          finalUrl: page.url,
          agent: { key: "browser", label: "Browser", userAgent: "verification-fixture/1" },
          status: 200,
          headers: {},
          redirects: [],
          signals: {
            titles: [{ value: page.title, location: "head" }],
            descriptions: [],
            canonicals: [],
            robots: [],
            h1s: [{ value: page.title, location: "body" }],
            links: [],
            hreflangs: []
          },
          bytesRead: page.html.length,
          content: extractContentEvidence(page.html),
          durationMs: 1,
          completion: "complete",
          ...page.snapshot
        }
      ],
      inbound: [],
      outbound: []
    })),
    findings: [],
    summary: {
      routes: pages.length,
      fetched: pages.length,
      indexable: pages.length,
      errors: 0,
      warnings: 0,
      info: 0,
      brokenLinks: 0,
      redirects: 0,
      noindex: 0,
      maxDepth: 0
    },
    truncated: false
  };
}

function statuses(verification: Awaited<ReturnType<typeof verifySite>>) {
  return new Map(verification.routes.map((route) => [route.route, route.status]));
}

function runCli(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
}

interface AuditTargetFixture {
  readonly id?: string;
  readonly url: string;
  readonly title?: string;
  readonly robots?: readonly {
    readonly audience: "robots" | "googlebot" | "bingbot";
    readonly value: string;
    readonly location: "head" | "body";
  }[];
  readonly xRobotsTag?: string;
  readonly status?: number;
  readonly findings?: readonly {
    readonly code: string;
    readonly severity: "info" | "warning" | "error";
    readonly message: string;
    readonly agent?: string;
  }[];
}

/** The smallest SSRWire audit report its own parser accepts. */
function ssrwireReport(targets: readonly AuditTargetFixture[]) {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    version: "0.5.0",
    generatedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 1,
    results: targets.map((target) => ({
      target: {
        ...(target.id === undefined ? {} : { id: target.id }),
        url: target.url,
        expectations: {
          statuses: [200],
          requireTitle: true,
          requireDescription: true,
          requireCanonical: true,
          requireH1: true,
          requireMainText: true
        }
      },
      probes: [
        {
          requestedUrl: target.url,
          finalUrl: target.url,
          agent: {
            key: "browser",
            label: "Browser",
            userAgent: "verification-fixture/1",
            requiresHeadMetadata: false
          },
          status: target.status ?? 200,
          redirects: [],
          headers: {
            values: target.xRobotsTag === undefined ? {} : { "x-robots-tag": target.xRobotsTag },
            setCookiePresent: false
          },
          timings: { headersMs: 1 },
          bytesRead: 1,
          signals: {
            titles: [{ value: target.title ?? "Fixture title", atMs: 1, observedByByte: 1, location: "head" as const }],
            descriptions: [],
            canonicals: [],
            robots: (target.robots ?? []).map((signal) => ({ ...signal, atMs: 1, observedByByte: 1 })),
            h1s: [],
            jsonLd: []
          },
          completion: "complete" as const
        }
      ],
      findings: (target.findings ?? []).map((finding) => ({ ...finding, url: target.url }))
    })),
    summary: {
      targets: targets.length,
      probes: targets.length,
      errors: 0,
      warnings: 0,
      info: 0,
      incomplete: 0
    }
  };
}

test("verify compares built pages with the records the export carries", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const site = join(workspace, "dist");
  await writeBuiltSite(site);

  const verification = await verifySite(fixtureProject(), { htmlDirectory: site });
  const found = statuses(verification);

  assert.equal(verification.observed, "html-directory");
  assert.equal(found.get("/carried/"), "verified");
  assert.equal(found.get("/shrunk/"), "diverged");
  assert.equal(found.get("/blank/"), "missing-content");
  assert.equal(found.get("/absent/"), "route-missing");
  assert.equal(found.get("/tiny/"), "skipped");
  assert.equal(verification.summary.routes, 5);
  assert.equal(verification.summary.verified, 1);
  assert.equal(verification.summary.diverged, 1);
  assert.equal(verification.summary.missingContent, 1);
  assert.equal(verification.summary.routeMissing, 1);
  assert.equal(verification.summary.skipped, 1);
  assert.equal(verification.summary.withoutTitle, 1);
  assert.equal(verification.summary.withoutHeading, 0);
  // The comparison reports measurements, never the text of either side.
  assert.ok(verification.routes.every((route) => !route.reason.includes(carried)));
});

test("verify recognizes file-style HTML output", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-files-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  await writeFile(join(site, "carried.html"), `<p>${carried}</p>`);
  const verification = await verifySite(fixtureProject(), { htmlDirectory: site });
  assert.equal(statuses(verification).get("/carried/"), "verified");
});

test("verify flags unrelated pages even when they have enough words", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-unrelated-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  await writePage(site, "carried", unrelated.repeat(5));
  const verification = await verifySite(fixtureProject(), { htmlDirectory: site });
  assert.equal(statuses(verification).get("/carried/"), "diverged");
});

test("verify flags substantial loss even when the word distribution stays the same", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-repetition-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  await writePage(site, "carried", carried);
  const project = parseWxr(fixtureXml().replace(`<p>${carried}</p>`, `<p>${carried} ${carried} ${carried}</p>`));
  const verification = await verifySite(project, { htmlDirectory: site });
  assert.equal(statuses(verification).get("/carried/"), "diverged");
});

test("verify refuses ambiguous files for the same planned route", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-ambiguous-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  await writePage(site, "carried", carried);
  await writeFile(join(site, "carried.html"), unrelated);
  await assert.rejects(verifySite(fixtureProject(), { htmlDirectory: site }), /same route/);
});

test("missing pages remain blockers even when the export has little text", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-short-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  const verification = await verifySite(fixtureProject(), { htmlDirectory: site });
  assert.equal(statuses(verification).get("/tiny/"), "route-missing");
  assert.equal(verification.summary.routeMissing, 5);
});

test("Elementor evidence counts each widget once and parses HTML settings", () => {
  const widgets = [
    { widgetType: "heading", settings: { title: "A useful heading" } },
    { widgetType: "text-editor", settings: { editor: `<p>${carried} &amp; more</p>` } }
  ].map((widget) => ({ elType: "widget", elements: [], ...widget }));
  const xml = fixtureXml().replace(
    `<content:encoded><![CDATA[<p>${carried}</p>]]></content:encoded>`,
    `<content:encoded></content:encoded><wp:postmeta><wp:meta_key>_elementor_data</wp:meta_key>` +
      `<wp:meta_value><![CDATA[${JSON.stringify(widgets)}]]></wp:meta_value></wp:postmeta>`
  );
  const record = parseWxr(xml).records[0];
  assert.ok(record);
  assert.deepEqual(sourceContentEvidence(record), contentEvidenceFromText(`A useful heading ${carried} & more`));
  assert.deepEqual(sourceContentEvidence({ ...record, rawContent: "<p></p>" }), sourceContentEvidence(record));
});

test("verify uses the crawled origin and ignores off-site pages", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-origin-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "report.json");
  await writeFile(reportPath, JSON.stringify(routeLintReport([
    { url: "https://staging.invalid/carried/", html: carried, title: "Carried" },
    { url: "https://other.invalid/shrunk/", html: carried, title: "Other" }
  ], "https://staging.invalid/")));
  const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
  assert.equal(statuses(verification).get("/carried/"), "verified");
  assert.equal(statuses(verification).get("/shrunk/"), "route-missing");
});

test("verify cannot pass failed, incomplete, or redirected crawl responses", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-responses-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "report.json");
  for (const snapshot of [
    { status: 404 },
    { status: 500 },
    { completion: "max-bytes-exceeded" as const },
    { completion: "timeout" as const },
    { finalUrl: "https://example.invalid/login/?token=private" }
  ]) {
    await writeFile(reportPath, JSON.stringify(routeLintReport([
      { url: "https://example.invalid/carried/", html: carried, title: "Carried", snapshot }
    ])));
    const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
    assert.equal(statuses(verification).get("/carried/"), "route-missing", JSON.stringify(snapshot));
    assert.doesNotMatch(JSON.stringify(verification), /token=private/);
  }
});

test("report verification preserves exact paths and leaves missing evidence unjudged", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-evidence-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "report.json");
  const report = routeLintReport([
    { url: "https://example.invalid/carried", html: carried, title: "Carried" },
    { url: "https://example.invalid/shrunk/", html: carried, title: "Shrunk" }
  ]);
  await writeFile(reportPath, JSON.stringify({
    ...report,
    routes: report.routes.map((route) => ({
      ...route,
      snapshots: route.snapshots.map(({ content, ...snapshot }) => snapshot)
    }))
  }));
  const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
  assert.equal(statuses(verification).get("/carried/"), "route-missing");
  assert.equal(statuses(verification).get("/shrunk/"), "skipped");
});

test("report verification does not hide a failed browser response behind a successful bot", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-agents-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "report.json");
  const report = routeLintReport([{ url: "https://example.invalid/carried/", html: carried, title: "Carried" }]);
  await writeFile(reportPath, JSON.stringify({
    ...report,
    routes: report.routes.map((route) => ({
      ...route,
      snapshots: route.snapshots.flatMap((snapshot) => [
        { ...snapshot, agent: { ...snapshot.agent, key: "googlebot" } },
        { ...snapshot, status: 500 }
      ])
    }))
  }));
  const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
  assert.equal(statuses(verification).get("/carried/"), "route-missing");
});

test("verify refuses duplicate planned routes and empty plans", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-plan-"));
  context.after(() => rm(site, { recursive: true, force: true }));
  const project = fixtureProject();
  const first = project.records[0];
  assert.ok(first);
  await assert.rejects(verifySite({ ...project, records: [first, first] }, { htmlDirectory: site }), /duplicate route/i);
  await assert.rejects(verifySite({ ...project, records: [] }, { htmlDirectory: site }), /no planned routes/i);
});

test("the warning gate explains differing pages even when there are no blockers", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-warning-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeBuiltSite(workspace);
  await writePage(workspace, "absent", carried);
  await writePage(workspace, "blank", carried);
  await writeFile(join(workspace, "export.xml"), fixtureXml());
  const result = runCli(["verify", "export.xml", "--html-dir", ".", "--fail-on", "warning", "--json"], workspace);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.diverged, 1);
  assert.match(result.stderr, /1 differing/);
});

test("verification-only CLI flags cannot be silently ignored by another command", () => {
  const result = runCli(["inspect", "missing.xml", "--html-dir", "dist"], process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only.*verify/);
  const missing = runCli(["verify", "missing.xml"], process.cwd());
  assert.match(missing.stderr, /one observed source/);
  const both = runCli(["verify", "missing.xml", "--html-dir", "dist", "--routelint-report", "report.json"], process.cwd());
  assert.match(both.stderr, /one observed source/);
});

test("verify reads content evidence from a saved RouteLint report", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-report-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const reportPath = join(workspace, "routelint.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      routeLintReport([
        { url: "https://example.invalid/carried/", html: `<h1>Carried</h1><p>${carried}</p>`, title: "Carried" },
        { url: "https://example.invalid/shrunk/", html: `<h1>Shrunk</h1><p>${unrelated}</p>`, title: "Shrunk" },
        { url: "https://example.invalid/blank/", html: "<h1>Blank</h1>", title: "Blank" }
      ]),
      null,
      2
    )}\n`,
    "utf8"
  );

  const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
  const found = statuses(verification);

  assert.equal(verification.observed, "routelint-report");
  assert.equal(found.get("/carried/"), "verified");
  assert.equal(found.get("/shrunk/"), "diverged");
  assert.equal(found.get("/blank/"), "missing-content");
  assert.equal(found.get("/absent/"), "route-missing");
  assert.equal(verification.summary.withoutTitle, 0);

  const brokenPath = join(workspace, "broken.json");
  await writeFile(brokenPath, "{}\n", "utf8");
  await assert.rejects(
    () => verifySite(fixtureProject(), { routelintReportPath: brokenPath }),
    /Invalid RouteLint report/
  );
  await assert.rejects(
    () => verifySite(fixtureProject(), { htmlDirectory: workspace, routelintReportPath: reportPath }),
    /one observed source at a time/
  );
});

test("the CLI writes a verification artefact and gates on missing content", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const site = join(workspace, "dist");
  await writeBuiltSite(site);
  const exportPath = join(workspace, "export.xml");
  await writeFile(exportPath, fixtureXml(), "utf8");

  const output = join(workspace, "migration-verification.json");
  const gated = runCli(
    ["verify", exportPath, "--html-dir", site, "--out", output, "--json", "--fail-on", "blocker"],
    workspace
  );
  assert.equal(gated.status, 1, gated.stderr);

  const document = JSON.parse(gated.stdout);
  assert.equal(document.command, "verify");
  assert.equal(document.schemaVersion, "0.6");
  assert.equal(document.failed, true);
  assert.equal(document.summary.missingContent, 1);
  assert.equal(document.outputs.verification, output);

  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.observed.kind, "html-directory");
  assert.equal(written.routes.length, 5);
  assert.equal(written.summary.routeMissing, 1);
  assert.deepEqual(written.launch, { blockers: 0, warnings: 0, findings: [] });

  const again = runCli(["verify", exportPath, "--html-dir", site, "--out", output], workspace);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Refusing to overwrite/);

  const relaxed = runCli(
    ["verify", exportPath, "--html-dir", site, "--out", join(workspace, "second.json")],
    workspace
  );
  assert.equal(relaxed.status, 0, relaxed.stderr);
  assert.match(relaxed.stdout, /5 routes checked/);

  const help = runCli(["--help"], workspace);
  assert.match(help.stdout, /wp-migrate-core verify <export\.xml> --html-dir/);
});

test("verify reports a build that still asks crawlers not to index it", async (context) => {
  const site = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-indexing-"));
  context.after(() => rm(site, { recursive: true, force: true }));

  const directory = join(site, "carried");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow"><title>Carried</title></head><body><h1>Carried</h1><p>${carried}</p></body></html>`,
    "utf8"
  );

  const verification = await verifySite(fixtureProject(), { htmlDirectory: site });
  assert.equal(statuses(verification).get("/carried/"), "verified");

  const blocked = verification.launch.filter((finding) => finding.code === "INDEXING_BLOCKED");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.route, "/carried/");
  assert.equal(blocked[0]?.severity, "blocker");
  assert.equal(blocked[0]?.source, "html-directory");
  assert.match(blocked[0]?.id ?? "", /^launch:indexing-blocked:html-directory:\/carried\/$/);
  assert.equal(verification.summary.launchBlockers, 1);
  assert.equal(verification.summary.launchWarnings, 0);
});

test("the indexing gate reads the crawl report too, including response headers", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-indexing-report-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "report.json");

  const report = routeLintReport([
    {
      url: "https://example.invalid/carried/",
      html: `<p>${carried}</p>`,
      title: "Carried",
      snapshot: {
        signals: {
          titles: [{ value: "Carried", location: "head" }],
          descriptions: [],
          canonicals: [],
          robots: [{ value: "noindex", location: "head", audience: "robots", source: "meta" }],
          h1s: [{ value: "Carried", location: "body" }],
          links: [],
          hreflangs: []
        }
      }
    },
    {
      url: "https://example.invalid/shrunk/",
      html: `<p>${carried}</p>`,
      title: "Shrunk",
      snapshot: {
        signals: {
          titles: [{ value: "Shrunk", location: "head" }],
          descriptions: [],
          canonicals: [],
          robots: [{ value: "googlebot: none", location: "head", audience: "robots", source: "header" }],
          h1s: [{ value: "Shrunk", location: "body" }],
          links: [],
          hreflangs: []
        }
      }
    }
  ]);

  await writeFile(reportPath, JSON.stringify(report), "utf8");

  const verification = await verifySite(fixtureProject(), { routelintReportPath: reportPath });
  const blocked = verification.launch.filter((finding) => finding.code === "INDEXING_BLOCKED");
  assert.deepEqual(
    blocked.map((finding) => [finding.route, finding.source]),
    [
      ["/carried/", "routelint-report"],
      ["/shrunk/", "routelint-report"]
    ]
  );
  assert.deepEqual(verification.delivery, undefined);
});

test("verify folds SSRWire delivery evidence into the publishing gate", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-ssrwire-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const site = join(workspace, "dist");
  await writeBuiltSite(site);

  const reportPath = join(workspace, "preview.json");
  const baselinePath = join(workspace, "source.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      ssrwireReport([
        { id: "carried", url: "https://example.invalid/carried/", status: 404, xRobotsTag: "noindex" },
        {
          id: "shrunk",
          url: "https://example.invalid/shrunk/",
          findings: [
            {
              code: "missing-canonical",
              severity: "warning",
              message: "no canonical was observed",
              agent: "googlebot"
            }
          ]
        }
      ])
    ),
    "utf8"
  );

  await writeFile(
    baselinePath,
    JSON.stringify(
      ssrwireReport([
        { id: "carried", url: "https://staging.invalid/carried/" },
        { id: "shrunk", url: "https://staging.invalid/shrunk/" }
      ])
    ),
    "utf8"
  );

  const verification = await verifySite(fixtureProject(), {
    htmlDirectory: site,
    ssrwireReportPath: reportPath,
    ssrwireBaselinePath: baselinePath
  });

  assert.equal(verification.delivery?.source, reportPath);
  assert.equal(verification.delivery?.summary.covered, 2);
  assert.equal(verification.delivery?.summary.failed, 1);
  assert.equal(verification.delivery?.summary.unobserved, 3);
  assert.equal(verification.delivery?.summary.blockedIndexing, 1);

  const comparison = verification.delivery?.comparison;
  assert.ok(comparison !== undefined);
  assert.equal(comparison.baselineSource, baselinePath);
  assert.equal(comparison.summary.matchedTargets, 2);

  const codes = verification.launch.map((finding) => finding.code).sort();
  assert.deepEqual(codes, [
    "DELIVERY_FAILED",
    "DELIVERY_REGRESSION",
    "DELIVERY_UNOBSERVED",
    "INDEXING_BLOCKED"
  ]);
  assert.equal(verification.summary.launchBlockers, 2);
  assert.equal(verification.summary.launchWarnings, 2);

  // The candidate-only contract warning is reported once, as the regression
  // the comparison found, rather than twice.
  const regression = verification.launch.find((finding) => finding.code === "DELIVERY_REGRESSION");
  assert.equal(regression?.sourceCode, "missing-canonical");
  assert.equal(regression?.severity, "warning");
  assert.equal(regression?.route, "/shrunk/");

  // Two of the five planned routes are in the report: the other three are
  // named as uncovered rather than passed over.
  const unobserved = verification.launch.find((finding) => finding.code === "DELIVERY_UNOBSERVED");
  assert.equal(unobserved?.severity, "warning");
  assert.deepEqual(unobserved?.routes, ["/absent/", "/blank/", "/tiny/"]);
  assert.match(unobserved?.message ?? "", /Affected: \/absent\/, \/blank\/, \/tiny\/\./);

  // The build itself cannot see any of this: the delivery findings come from
  // the saved audit, and the content comparison is unchanged by them.
  assert.equal(statuses(verification).get("/carried/"), "verified");
});

test("delivery flags are verify-only and a baseline needs a report", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-flags-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "export.xml"), fixtureXml(), "utf8");
  await writeFile(join(workspace, "audit.json"), JSON.stringify(ssrwireReport([])), "utf8");

  const inspect = runCli(["inspect", "export.xml", "--ssrwire-report", "audit.json"], workspace);
  assert.equal(inspect.status, 1);
  assert.match(inspect.stderr, /only supported by verify/);

  const baselineOnly = runCli(
    ["verify", "export.xml", "--html-dir", ".", "--ssrwire-baseline", "audit.json"],
    workspace
  );
  assert.equal(baselineOnly.status, 1);
  assert.match(baselineOnly.stderr, /--ssrwire-baseline compares two audits/);
  assert.match(baselineOnly.stderr, /Pass --ssrwire-report/);

  const bothSources = runCli(
    ["verify", "export.xml", "--html-dir", ".", "--routelint-report", "audit.json", "--ssrwire-report", "audit.json"],
    workspace
  );
  assert.equal(bothSources.status, 1);
  assert.match(bothSources.stderr, /one observed source/);

  const empty = runCli(["verify", "export.xml", "--ssrwire-report", "audit.json"], workspace);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /one observed source/);

  const missing = runCli(
    ["verify", "export.xml", "--html-dir", ".", "--ssrwire-report", "missing.json"],
    workspace
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read the --ssrwire-report file/);
});

test("the CLI gates on a build that blocks indexing and writes the evidence", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-verify-launch-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const site = join(workspace, "dist");
  const directory = join(site, "carried");
  await mkdir(directory, { recursive: true });
  for (const slug of ["carried", "shrunk", "blank", "tiny"]) {
    const target = join(site, slug);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "index.html"),
      `<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>${slug}</title></head><body><h1>${slug}</h1><p>${carried}</p></body></html>`,
      "utf8"
    );
  }

  const exportPath = join(workspace, "export.xml");
  await writeFile(exportPath, fixtureXml(), "utf8");
  const reportPath = join(workspace, "preview.json");
  await writeFile(reportPath, JSON.stringify(ssrwireReport([{ id: "carried", url: "https://example.invalid/carried/" }])), "utf8");

  const gated = runCli(
    ["verify", "export.xml", "--html-dir", site, "--ssrwire-report", reportPath, "--fail-on", "blocker", "--json"],
    workspace
  );
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stderr, /publishing blocker/);

  const document = JSON.parse(gated.stdout);
  assert.equal(document.failed, true);
  // Four pages block indexing, but that is one thing to fix, so it is one
  // finding naming the four routes.
  assert.equal(document.summary.launchBlockers, 1);
  assert.equal(document.summary.launchWarnings, 1);
  assert.equal(document.delivery.summary.covered, 1);
  assert.equal(document.delivery.summary.unobserved, 4);
  assert.equal(document.launch.findings.length, 2);

  const indexing = document.launch.findings.find(
    (finding: { code: string }) => finding.code === "INDEXING_BLOCKED"
  );
  assert.deepEqual(indexing.routes, ["/blank/", "/carried/", "/shrunk/", "/tiny/"]);
  assert.match(indexing.message, /^The built pages carry robots directives that block indexing \(meta\)\./);
  assert.match(indexing.message, /Affected: \/blank\/, \/carried\/, \/shrunk\/ and 1 more\./);

  const unobserved = document.launch.findings.find(
    (finding: { code: string }) => finding.code === "DELIVERY_UNOBSERVED"
  );
  assert.equal(unobserved.severity, "warning");
  assert.equal(unobserved.routes.length, 4);
  assert.doesNotMatch(gated.stdout, /Carried|Fixture title/);
});

test("CLI comparison artifacts retain metadata presence without its text", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-presence-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeBuiltSite(join(workspace, "dist"));
  await writeFile(join(workspace, "export.xml"), fixtureXml());
  await writeFile(join(workspace, "source.json"), JSON.stringify(ssrwireReport([
    { id: "carried", url: "https://example.invalid/carried/", title: "Private source title" }
  ])));
  await writeFile(join(workspace, "preview.json"), JSON.stringify(ssrwireReport([
    { id: "carried", url: "https://preview.invalid/carried/", title: "" }
  ])));
  const result = runCli([
    "verify", "export.xml", "--html-dir", "dist", "--ssrwire-report", "preview.json",
    "--ssrwire-baseline", "source.json", "--json"
  ], workspace);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(await readFile(join(workspace, "migration-verification.json"), "utf8"));
  const change = document.delivery.comparison.routes[0].changes.find(
    (entry: { code: string; field?: string }) => entry.code === "metadata-value-changed" && entry.field === "title"
  );
  assert.equal(change.baselinePresent, true);
  assert.equal(change.candidatePresent, false);
  assert.doesNotMatch(JSON.stringify(document), /Private source title/);
});
