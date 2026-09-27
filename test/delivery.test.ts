import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUDIT_SCHEMA_VERSION, loadConfig } from "ssrwire";
import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import {
  absoluteOnOrigin,
  deliveryCheckFiles,
  deliveryLaunchFindings,
  indexingFromSignals,
  launchFindings,
  readDeliveryEvidence
} from "../src/delivery.js";
import { demoFixturePath } from "./fixture-path.js";

async function demoProject() {
  return parseWxr(await readFile(demoFixturePath, "utf8"));
}

interface FixtureItem {
  readonly id: number;
  readonly slug: string;
  readonly link: string;
}

function fixtureXml(items: readonly FixtureItem[]): string {
  const entries = items
    .map(
      (item) => `    <item>
      <title>${item.slug}</title>
      <link>${item.link}</link>
      <content:encoded><![CDATA[<p>Some migrated words that are long enough to compare.</p>]]></content:encoded>
      <wp:post_id>${item.id}</wp:post_id>
      <wp:post_date>2026-01-01 00:00:00</wp:post_date>
      <wp:status>publish</wp:status>
      <wp:post_name>${item.slug}</wp:post_name>
      <wp:post_type>page</wp:post_type>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Delivery fixture</title>
    <link>https://example.invalid</link>
    <wp:wxr_version>1.2</wp:wxr_version>
${entries}
  </channel>
</rss>
`;
}

interface RobotsFixture {
  readonly audience: "robots" | "googlebot" | "bingbot";
  readonly value: string;
  readonly location: "head" | "body";
}

interface ProbeFixture {
  readonly agent?: string;
  readonly status?: number;
  readonly completion?: "complete" | "timeout" | "network-error" | "max-bytes-exceeded" | "invalid-response";
  readonly robots?: readonly RobotsFixture[];
  readonly xRobotsTag?: string;
  readonly title?: string;
  readonly description?: string;
  readonly social?: readonly { readonly property: string; readonly value: string }[];
  readonly timings?: {
    readonly headersMs: number;
    readonly firstByteMs?: number;
    readonly completeMs?: number;
  };
}

/** The smallest SSRWire probe its own report parser accepts. */
function probe(url: string, fixture: ProbeFixture = {}) {
  const agent = fixture.agent ?? "browser";
  const completion = fixture.completion ?? "complete";
  return {
    requestedUrl: url,
    finalUrl: url,
    agent: {
      key: agent,
      label: agent,
      userAgent: `delivery-fixture/${agent}`,
      requiresHeadMetadata: false
    },
    // A probe that did not complete has no response status to report.
    ...(completion === "complete" ? { status: fixture.status ?? 200 } : {}),
    redirects: [],
    headers: {
      values: fixture.xRobotsTag === undefined ? {} : { "x-robots-tag": fixture.xRobotsTag },
      setCookiePresent: false
    },
    timings: fixture.timings ?? { headersMs: 1 },
    bytesRead: 10,
    signals: {
      ...(fixture.title === undefined
        ? {}
        : { titles: [{ value: fixture.title, atMs: 1, observedByByte: 1, location: "head" as const }] }),
      descriptions:
        fixture.description === undefined
          ? []
          : [{ value: fixture.description, atMs: 1, observedByByte: 1, location: "head" as const }],
      canonicals: [],
      robots: (fixture.robots ?? []).map((signal) => ({ ...signal, atMs: 1, observedByByte: 1 })),
      socialMetadata: (fixture.social ?? []).map((signal) => ({
        ...signal,
        atMs: 1,
        observedByByte: 1,
        location: "head" as const
      })),
      h1s: [],
      jsonLd: []
    },
    completion
  };
}

interface FindingFixture {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly agent?: string;
}

interface TargetFixture {
  readonly id?: string;
  readonly url: string;
  readonly probes?: readonly unknown[];
  readonly findings?: readonly FindingFixture[];
}

/** The smallest SSRWire audit report its own parser accepts. */
function auditReport(targets: readonly TargetFixture[], generatedAt = "2026-09-27T00:00:00.000Z") {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    version: "0.5.0",
    generatedAt,
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
      probes: target.probes ?? [probe(target.url)],
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

function targetIds(contents: string): readonly string[] {
  return [...contents.matchAll(/^  - id: "(.+)"$/gm)].map((match) => match[1] ?? "");
}

test("generated check files pair the source and preview origins on the same ids", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-checks-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const files = deliveryCheckFiles(await demoProject());
  assert.deepEqual(
    files.map((file) => file.path),
    ["migration/checks/ssrwire-source.yml", "migration/checks/ssrwire-preview.yml"]
  );

  const [source, preview] = files.map((file) => file.contents);
  assert.ok(source !== undefined && preview !== undefined);

  // The source check audits the WordPress permalink. The preview check audits
  // the route the plan generates, and the shared ids pair the two reports.
  assert.match(
    source,
    /  - id: "guides-stop-a-leaking-tap"\n    url: "https:\/\/brightpath\.example\/guides\/stop-a-leaking-tap"\n/
  );
  assert.match(
    preview,
    /  - id: "guides-stop-a-leaking-tap"\n    url: "http:\/\/localhost:4321\/guides\/stop-a-leaking-tap\/"\n/
  );
  assert.match(source, /  - id: "home"\n    url: "https:\/\/brightpath\.example\/"\n/);
  assert.match(preview, /  - id: "home"\n    url: "http:\/\/localhost:4321\/"\n/);
  assert.deepEqual(targetIds(preview), targetIds(source));
  assert.equal(targetIds(source).length, 4);

  // Both files have to satisfy SSRWire's own strict configuration loader.
  for (const file of files) {
    const path = join(workspace, file.path.replace("migration/checks/", ""));
    await writeFile(path, file.contents, "utf8");
    const config = await loadConfig({ configPath: path });
    assert.equal(config.targets.length, 4);
    assert.equal(config.targets.every((target) => target.id !== undefined), true);
    // Both files ask for the same metadata, including the social tags a
    // WordPress SEO plugin emits and a hand-written layout usually does not.
    for (const target of config.targets) {
      assert.equal(target.expectations.requireTitle, true);
      assert.equal(target.expectations.requireDescription, true);
      assert.equal(target.expectations.requireCanonical, true);
      assert.equal(target.expectations.requireOpenGraph, true);
      assert.equal(target.expectations.requireTwitterCard, true);
    }
  }

  assert.match(source, /require: \{title: true, description: true, canonical: true, h1: true, mainText: true, openGraph: true, twitterCard: true\}/);

  // Generation is deterministic, so two runs pair the same ids.
  const again = deliveryCheckFiles(await demoProject());
  assert.deepEqual(again.map((file) => file.contents), files.map((file) => file.contents));
});

test("generated check ids stay valid and unique for awkward routes", () => {
  const project = parseWxr(
    fixtureXml([
      { id: 1, slug: "a-b", link: "https://example.invalid/a-b/" },
      { id: 2, slug: "nested", link: "https://example.invalid/a/b/" },
      { id: 3, slug: "encoded", link: "https://example.invalid/%20%20/" },
      { id: 4, slug: "cases", link: "https://example.invalid/Case-Mixed/" }
    ])
  );

  const [source] = deliveryCheckFiles(project);
  assert.ok(source !== undefined);
  const ids = targetIds(source.contents);
  assert.deepEqual(ids, ["a-b", "a-b-2", "20-20", "case-mixed"]);

  for (const id of ids) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]{0,63}$/, `${id} must satisfy SSRWire's target id rule`);
  }
});

test("scheme-like route segments stay on the configured audit origin", () => {
  assert.equal(absoluteOnOrigin("http://localhost:4321", "/https:/elsewhere.invalid/"),
    "http://localhost:4321/https:/elsewhere.invalid/");
  assert.equal(absoluteOnOrigin("https://example.invalid", "/custom:page/"),
    "https://example.invalid/custom:page/");
});

test("delivery evidence reports status, indexing and findings per route", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "preview.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport([
        { url: "https://preview.invalid/" },
        {
          url: "https://preview.invalid/services/",
          findings: [
            {
              code: "missing-canonical",
              severity: "warning",
              message: "no canonical was observed",
              agent: "browser"
            }
          ]
        },
        { url: "https://preview.invalid/contact/" },
        {
          url: "https://preview.invalid/guides/stop-a-leaking-tap/",
          probes: [
            probe("https://preview.invalid/guides/stop-a-leaking-tap/", {
              title: "Stop a leaking tap",
              robots: [{ audience: "robots", value: "noindex, nofollow", location: "head" }],
              status: 404
            }),
            probe("https://preview.invalid/guides/stop-a-leaking-tap/", {
              agent: "googlebot",
              xRobotsTag: "googlebot: noindex",
              status: 404
            })
          ],
          findings: [
            {
              code: "status-mismatch",
              severity: "error",
              message: "browser received HTTP 404",
              agent: "browser"
            }
          ]
        },
        { url: "https://elsewhere.invalid/not-in-this-plan/" }
      ])
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath });
  const byRoute = new Map(evidence.routes.map((route) => [route.route, route]));

  assert.equal(evidence.observed, "ssrwire-report");
  assert.equal(evidence.version, "0.5.0");
  assert.equal(evidence.summary.covered, 4);
  assert.equal(evidence.summary.delivered, 3);
  assert.equal(evidence.summary.failed, 1);
  assert.equal(evidence.summary.unobserved, 0);
  assert.equal(evidence.summary.blockedIndexing, 1);
  assert.equal(evidence.summary.unmatchedTargets, 1);
  assert.equal(evidence.summary.errors, 1);

  const blocked = byRoute.get("/guides/stop-a-leaking-tap/");
  assert.equal(blocked?.status, "failed");
  assert.equal(blocked?.httpStatus, 404);
  assert.equal(blocked?.indexing, "blocked");
  assert.deepEqual(blocked?.indexingSources, ["meta", "header"]);
  assert.equal(blocked?.agents, 2);
  assert.deepEqual(blocked?.findings, [{ code: "status-mismatch", severity: "error", agent: "browser" }]);
  assert.match(blocked?.reason ?? "", /HTTP 404/);

  const healthy = byRoute.get("/services/");
  assert.equal(healthy?.status, "delivered");
  assert.equal(healthy?.indexing, "indexable");
  assert.equal(healthy?.indexingSources.length, 0);
  assert.equal(healthy?.requiredAction, undefined);

  const launch = deliveryLaunchFindings(evidence);
  assert.deepEqual(
    launch
      .map((finding) => [finding.code, finding.severity, finding.route ?? finding.routes])
      .sort(),
    [
      ["DELIVERY_CONTRACT", "warning", "/services/"],
      ["DELIVERY_FAILED", "blocker", "/guides/stop-a-leaking-tap/"],
      ["INDEXING_BLOCKED", "blocker", "/guides/stop-a-leaking-tap/"]
    ].sort()
  );
  const blocking = launch.find((finding) => finding.code === "INDEXING_BLOCKED");
  assert.equal(blocking?.id, "launch:indexing-blocked:ssrwire-report:/guides/stop-a-leaking-tap/");
  assert.match(blocking?.message ?? "", /^\/guides\/stop-a-leaking-tap\/ was served with robots/);

  // The route that answered 404 is one problem: its missing canonical is a
  // symptom, not a second finding.
  assert.equal(
    launch.some(
      (finding) => finding.code === "DELIVERY_CONTRACT" && finding.route === "/guides/stop-a-leaking-tap/"
    ),
    false
  );
  assert.equal(new Set(launch.map((finding) => finding.id)).size, launch.length);
});

test("delivery evidence matches a source audit by target id and leaves routes unobserved", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-ids-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "source.json");

  // The source audit answers on the WordPress paths, so only the shared ids
  // tie these targets to the routes the plan generates.
  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport([
        { id: "home", url: "https://brightpath.example/" },
        { id: "guides-stop-a-leaking-tap", url: "https://brightpath.example/guides/stop-a-leaking-tap" }
      ])
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath });
  const byRoute = new Map(evidence.routes.map((route) => [route.route, route]));

  assert.equal(evidence.summary.covered, 2);
  assert.equal(evidence.summary.unobserved, 2);
  assert.equal(evidence.summary.unmatchedTargets, 0);
  assert.equal(byRoute.get("/")?.targetId, "home");
  assert.equal(byRoute.get("/guides/stop-a-leaking-tap/")?.status, "delivered");
  assert.equal(byRoute.get("/services/")?.status, "unobserved");
  assert.match(byRoute.get("/services/")?.reason ?? "", /no target/);
});

test("the baseline comparison keeps codes, severities and numbers, never text", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-compare-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");

  const fast = { headersMs: 100, firstByteMs: 100, completeMs: 150 };
  const slow = { headersMs: 1000, firstByteMs: 1000, completeMs: 1100 };

  await writeFile(
    baselinePath,
    JSON.stringify(
      auditReport([
        {
          id: "services",
          url: "https://brightpath.example/services/",
          probes: [
            probe("https://brightpath.example/services/", {
              title: "Private title",
              description: "Private description",
              timings: fast
            }),
            // Both audits watch the same profiles, so every comparison below
            // covers both of them.
            probe("https://brightpath.example/services/", {
              agent: "googlebot",
              title: "Private title",
              description: "Private description",
              timings: fast
            })
          ]
        }
      ])
    ),
    "utf8"
  );

  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport([
        {
          id: "services",
          url: "https://preview.invalid/services/",
          probes: [
            probe("https://preview.invalid/services/", {
              title: "Other title",
              timings: slow
            }),
            probe("https://preview.invalid/services/", {
              agent: "googlebot",
              title: "Other title",
              timings: slow
            })
          ],
          findings: [
            {
              code: "missing-canonical",
              severity: "error",
              message: "no canonical was observed",
              agent: "browser"
            },
            {
              code: "missing-canonical",
              severity: "error",
              message: "no canonical was observed",
              agent: "googlebot"
            }
          ]
        }
      ])
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
  const comparison = evidence.comparison;
  assert.ok(comparison !== undefined);
  assert.equal(comparison.baselineSource, baselinePath);
  assert.equal(comparison.source, reportPath);
  assert.equal(comparison.summary.matchedTargets, 1);
  assert.equal(comparison.summary.addedTargets, 0);

  const services = comparison.routes.find((route) => route.route === "/services/");
  assert.ok(services !== undefined);
  assert.equal(services.status, "matched");

  const codes = services.changes.map((change) => change.code);
  assert.ok(codes.includes("metadata-value-changed"), JSON.stringify(codes));
  assert.ok(codes.includes("missing-canonical"), JSON.stringify(codes));
  assert.ok(codes.includes("timing-regression"), JSON.stringify(codes));
  // Both audits answered 200, so no status row is invented.
  assert.equal(codes.includes("http-status-changed"), false);

  // Text values are dropped; the change is described from its code instead.
  const title = services.changes.find(
    (change) => change.code === "metadata-value-changed" && change.field === "title"
  );
  assert.equal(title?.field, "title");
  assert.equal(title?.baselineValue, undefined);
  assert.equal(title?.candidateValue, undefined);
  assert.equal(title?.message, "The title value differs between the two audits.");

  const description = services.changes.find(
    (change) => change.code === "metadata-value-changed" && change.field === "description"
  );
  assert.equal(description?.baselineValue, undefined);
  assert.equal(description?.message, "The description value differs between the two audits.");

  // SSRWire reports per profile; the artefact keeps the profiles in one row.
  assert.deepEqual(title?.agents, ["browser", "googlebot"]);

  // A timing comparison is numeric, so both medians survive.
  const timing = services.changes.find(
    (change) => change.code === "timing-regression" && change.field === "headers"
  );
  assert.equal(timing?.field, "headers");
  assert.equal(timing?.baselineValue, 100);
  assert.equal(timing?.candidateValue, 1000);

  const canonical = services.changes.find((change) => change.code === "missing-canonical");
  assert.equal(canonical?.kind, "regression");
  assert.equal(canonical?.candidateSeverity, "error");
  assert.deepEqual(canonical?.agents, ["browser", "googlebot"]);

  const serialized = JSON.stringify(evidence);
  for (const text of ["Private title", "Private description", "Other title", "no canonical was observed"]) {
    assert.equal(serialized.includes(text), false, `${text} must not reach the artefact`);
  }

  const regressions = deliveryLaunchFindings(evidence).filter(
    (finding) => finding.code === "DELIVERY_REGRESSION"
  );
  assert.ok(regressions.length > 0, JSON.stringify(regressions));
  assert.equal(regressions.every((finding) => finding.sourceCode !== undefined), true);

  // Two profiles saw the same regression: that is one thing to fix, with the
  // profiles named, rather than two entries in the queue.
  const canonicalRegressions = regressions.filter(
    (finding) => finding.sourceCode === "missing-canonical"
  );
  assert.equal(canonicalRegressions.length, 1);
  assert.equal(canonicalRegressions[0]?.severity, "blocker");
  assert.equal(canonicalRegressions[0]?.agent, undefined);
  assert.match(
    canonicalRegressions[0]?.message ?? "",
    /SSRWire reports missing-canonical on the rebuilt site and not on the source site\. Seen for browser and googlebot\./
  );
  assert.equal(
    regressions.find((finding) => finding.sourceCode === "timing-regression")?.severity,
    "warning"
  );
});

test("delivery findings separate blockers from review items and never repeat a robots block", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-gate-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "preview.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport([
        {
          url: "https://preview.invalid/",
          probes: [probe("https://preview.invalid/", { xRobotsTag: "noindex, nofollow" })],
          findings: [
            {
              code: "robots-header-noindex",
              severity: "error",
              message: "X-Robots-Tag blocks indexing",
              agent: "browser"
            }
          ]
        },
        {
          url: "https://preview.invalid/services/",
          findings: [
            {
              code: "missing-description",
              severity: "warning",
              message: "no description was observed",
              agent: "bingbot"
            },
            { code: "missing-canonical", severity: "error", message: "no canonical", agent: "browser" },
            { code: "slow-first-byte", severity: "info", message: "slow", agent: "browser" }
          ]
        },
        {
          url: "https://preview.invalid/contact/",
          probes: [probe("https://preview.invalid/contact/", { completion: "timeout" })]
        }
      ])
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath });
  const findings = deliveryLaunchFindings(evidence);

  // The blocking header is reported once, as an indexing block, instead of
  // appearing again as a delivery contract problem.
  const blocks = findings.filter((finding) => finding.code === "INDEXING_BLOCKED");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.severity, "blocker");
  assert.equal(blocks[0]?.route, "/");
  assert.equal(findings.some((finding) => finding.sourceCode === "robots-header-noindex"), false);

  assert.equal(findings.find((finding) => finding.sourceCode === "missing-description")?.severity, "warning");
  assert.equal(findings.find((finding) => finding.sourceCode === "missing-description")?.agent, "bingbot");
  assert.equal(findings.find((finding) => finding.sourceCode === "missing-canonical")?.severity, "blocker");
  assert.equal(findings.some((finding) => finding.sourceCode === "slow-first-byte"), false);

  const incomplete = findings.find((finding) => finding.code === "DELIVERY_INCOMPLETE");
  assert.equal(incomplete?.severity, "blocker");
  assert.equal(incomplete?.route, "/contact/");
});

test("a social tag the rebuilt site dropped is reported as that tag", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-social-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");

  const source = [
    { property: "og:title", value: "Bright Path Plumbing" },
    { property: "og:image", value: "https://brightpath.example/og.png" }
  ];
  const contractFinding = {
    code: "missing-open-graph-metadata",
    severity: "warning" as const,
    message: "no og:image was observed",
    agent: "browser"
  };

  const pages = [
    { id: "home", source: "https://brightpath.example/", preview: "https://preview.invalid/" },
    {
      id: "services",
      source: "https://brightpath.example/services/",
      preview: "https://preview.invalid/services/"
    }
  ];

  await writeFile(
    baselinePath,
    JSON.stringify(
      auditReport(
        pages.map((page) => ({
          id: page.id,
          url: page.source,
          probes: [
            probe(page.source, { social: source }),
            probe(page.source, { agent: "googlebot", social: source })
          ]
        }))
      )
    ),
    "utf8"
  );

  // The rebuilt pages kept nothing: no og:image, so a shared link loses the
  // preview image the WordPress site was rendering. They did keep og:title,
  // which must not be reported as lost.
  const kept = [{ property: "og:title", value: "Bright Path Plumbing" }];
  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport(
        pages.map((page) => ({
          id: page.id,
          url: page.preview,
          probes: [
            probe(page.preview, { social: kept }),
            probe(page.preview, { agent: "googlebot", social: kept })
          ],
          findings: [contractFinding, { ...contractFinding, agent: "googlebot" }]
        }))
      )
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
  const findings = launchFindings({ delivery: evidence });

  // The tag that went missing, across every route it went missing on.
  const social = findings.find((finding) => finding.field === "og:image");
  assert.equal(social?.code, "DELIVERY_REGRESSION");
  assert.equal(social?.severity, "warning");
  assert.equal(social?.title, "Social preview metadata was lost");
  assert.deepEqual(social?.routes, ["/", "/services/"]);
  assert.equal(social?.agent, undefined);
  assert.match(
    social?.message ?? "",
    /^The rebuilt pages lost og:image, which the source site was serving\. Seen for browser and googlebot\. Affected: \/, \/services\/\.$/
  );
  assert.match(social?.requiredAction ?? "", /Open Graph/);

  // og:title did not change, and the contract finding behind the loss is not
  // repeated as a second finding about the same pages.
  assert.equal(findings.some((finding) => finding.field === "og:title"), false);
  assert.equal(findings.some((finding) => finding.sourceCode === "missing-open-graph-metadata"), false);

  // The route evidence still records what the audited page served.
  assert.deepEqual(evidence.routes.find((route) => route.route === "/")?.socialMetadata, ["og:title"]);
});

test("a source audit that never answered is not read as the rebuilt site losing ground", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-baseline-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");

  // A baseline captured from a domain that does not resolve, or while the site
  // was down: every probe fails, so it cannot prove anything either way.
  await writeFile(
    baselinePath,
    JSON.stringify(
      auditReport([
        {
          id: "home",
          url: "https://brightpath.example/",
          probes: [probe("https://brightpath.example/", { completion: "network-error" })]
        }
      ])
    ),
    "utf8"
  );

  await writeFile(
    reportPath,
    JSON.stringify(
      auditReport([
        {
          id: "home",
          url: "https://preview.invalid/",
          findings: [
            { code: "missing-canonical", severity: "error", message: "no canonical", agent: "browser" }
          ]
        }
      ])
    ),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
  const comparison = evidence.comparison?.routes.find((route) => route.route === "/");
  assert.equal(comparison?.baselineComplete, false);

  const findings = launchFindings({ delivery: evidence });
  assert.equal(
    findings.find((finding) => finding.sourceCode === "missing-canonical")?.severity,
    "blocker",
    "an unusable baseline must not hide the candidate's own contract errors"
  );
  assert.equal(
    findings.some((finding) => finding.code === "DELIVERY_REGRESSION"),
    false,
    "a failed baseline is not evidence that the rebuilt site regressed"
  );

  const unusable = findings.find((finding) => finding.title === "No usable source audit to compare against");
  assert.equal(unusable?.code, "DELIVERY_UNOBSERVED");
  assert.equal(unusable?.severity, "warning");
  assert.equal(unusable?.route, "/");
  assert.match(unusable?.requiredAction ?? "", /npm run check:source/);
});

test("a report that covers none of the plan is a blocker, partial coverage is not", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-delivery-coverage-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "preview.json");

  await writeFile(
    reportPath,
    JSON.stringify(auditReport([{ url: "https://elsewhere.invalid/not-in-this-plan/" }])),
    "utf8"
  );

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath });
  assert.equal(evidence.summary.covered, 0);
  assert.equal(evidence.summary.unobserved, 4);

  const findings = launchFindings({ delivery: evidence });
  const unobserved = findings.filter((finding) => finding.code === "DELIVERY_UNOBSERVED");
  assert.equal(unobserved.length, 1, "one uncovered-coverage finding, not one per route");
  assert.equal(unobserved[0]?.severity, "blocker");
  assert.equal(unobserved[0]?.routes?.length, 4);
  assert.match(unobserved[0]?.requiredAction ?? "", /covers none of the planned routes/);
});

test("indexing evidence reads meta and header directives the same way everywhere", () => {
  assert.equal(indexingFromSignals([]).status, "indexable");
  assert.deepEqual(indexingFromSignals([{ audience: "robots", value: "index, follow" }]).sources, []);

  const meta = indexingFromSignals([{ audience: "robots", value: "noindex, follow" }]);
  assert.equal(meta.status, "blocked");
  assert.deepEqual(meta.sources, ["meta"]);

  const none = indexingFromSignals([{ audience: "googlebot", value: "none", source: "header" }]);
  assert.equal(none.status, "blocked");
  assert.deepEqual(none.sources, ["header"]);

  // A directive for an unrelated audience is not a decision about indexing.
  assert.equal(indexingFromSignals([{ audience: "otherbot", value: "noindex" }]).status, "indexable");
  assert.equal(indexingFromSignals([
    { audience: "robots", source: "header", value: "otherbot: nofollow, noindex" }
  ]).status, "indexable");
  assert.equal(indexingFromSignals([
    { audience: "robots", source: "header", value: "otherbot: noindex, googlebot: none" }
  ]).status, "blocked");
  assert.equal(indexingFromSignals([
    { audience: "robots", source: "header", value: "max-snippet: 0, noindex" }
  ]).status, "blocked");
});

test("missing and unsuccessful baselines leave candidate findings in the gate", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-baseline-status-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");
  const url = "https://preview.invalid/services/";
  await writeFile(reportPath, JSON.stringify(auditReport([{
    id: "services", url,
    findings: [{ code: "missing-canonical", severity: "error", message: "missing", agent: "browser" }]
  }])));
  for (const targets of [[], [{ id: "services", url, probes: [probe(url, { status: 503 })] }]]) {
    await writeFile(baselinePath, JSON.stringify(auditReport(targets)));
    const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
    assert.equal(evidence.comparison?.summary.unusableBaselines, 1);
    const findings = launchFindings({ delivery: evidence });
    assert.equal(findings.some((finding) => finding.code === "DELIVERY_REGRESSION"), false);
    assert.equal(findings.find((finding) => finding.sourceCode === "missing-canonical")?.severity, "blocker");
  }
});

test("comparison preserves different metadata outcomes and timings across profiles", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-profile-changes-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");
  const url = "https://preview.invalid/services/";
  const social = [{ property: "og:image", value: "https://example.invalid/before.png" }];
  await writeFile(baselinePath, JSON.stringify(auditReport([{
    id: "services", url,
    probes: [
      probe(url, { social, timings: { headersMs: 100 } }),
      probe(url, { social, agent: "googlebot", timings: { headersMs: 200 } })
    ]
  }])));
  await writeFile(reportPath, JSON.stringify(auditReport([{
    id: "services", url,
    probes: [
      probe(url, {
        social: [{ property: "og:image", value: "https://example.invalid/after.png" }],
        timings: { headersMs: 1000 }
      }),
      probe(url, { agent: "googlebot", timings: { headersMs: 2000 } })
    ]
  }])));

  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
  const changes = evidence.comparison?.routes[0]?.changes ?? [];
  const loss = changes.find((change) => change.field === "og:image" && change.candidatePresent === false);
  assert.equal(loss?.baselinePresent, true);
  assert.deepEqual(loss?.agents, ["googlebot"]);
  const socialFinding = launchFindings({ delivery: evidence }).find((finding) => finding.field === "og:image");
  assert.equal(socialFinding?.agent, "googlebot");
  assert.match(socialFinding?.title ?? "", /was lost/);
  assert.deepEqual(
    changes.filter((change) => change.code === "timing-regression").map((change) =>
      [change.baselineValue, change.candidateValue, change.agents]),
    [[100, 1000, ["browser"]], [200, 2000, ["googlebot"]]]
  );
});

test("an incomplete baseline cannot prove a social loss or hide a social contract warning", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-social-baseline-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const baselinePath = join(workspace, "source.json");
  const reportPath = join(workspace, "preview.json");
  const url = "https://preview.invalid/services/";
  await writeFile(baselinePath, JSON.stringify(auditReport([{
    id: "services", url,
    probes: [
      probe(url, { social: [{ property: "og:image", value: "https://example.invalid/image.png" }] }),
      probe(url, { agent: "googlebot", completion: "network-error" })
    ]
  }])));
  await writeFile(reportPath, JSON.stringify(auditReport([{
    id: "services", url,
    findings: [{ code: "missing-open-graph-metadata", severity: "warning", message: "missing", agent: "browser" }]
  }])));
  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath, baselinePath });
  const findings = launchFindings({ delivery: evidence });
  assert.equal(findings.some((finding) => finding.code === "DELIVERY_REGRESSION"), false);
  assert.equal(findings.find((finding) => finding.sourceCode === "missing-open-graph-metadata")?.severity, "warning");
});

test("delivery status includes failed profiles and repeated probes", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-probe-outcomes-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const reportPath = join(workspace, "preview.json");
  await writeFile(reportPath, JSON.stringify(auditReport([
    { url: "https://preview.invalid/services/", probes: [
      probe("https://preview.invalid/services/"),
      probe("https://preview.invalid/services/", { agent: "googlebot", status: 503 })
    ] },
    { url: "https://preview.invalid/contact/", probes: [
      probe("https://preview.invalid/contact/"),
      probe("https://preview.invalid/contact/", { completion: "timeout" })
    ] }
  ])));
  const evidence = await readDeliveryEvidence(await demoProject(), { reportPath });
  assert.equal(evidence.routes.find((route) => route.route === "/services/")?.status, "failed");
  assert.equal(evidence.routes.find((route) => route.route === "/contact/")?.status, "incomplete");
  assert.equal(evidence.summary.delivered, 0);
});

test("generated check files accept multiline site titles", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-check-title-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const project = await demoProject();
  for (const [index, file] of deliveryCheckFiles({ ...project, site: { ...project.site, title: "First line\nSecond line" } }).entries()) {
    const path = join(workspace, `${index}.yml`);
    await writeFile(path, file.contents);
    assert.equal((await loadConfig({ configPath: path })).targets.length, project.records.length);
  }
});

test("the sitemap uses valid dates without treating WordPress local timestamps as UTC", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-sitemap-dates-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const project = await demoProject();
  const dates = ["2026-09-27 23:30:00", "0000-00-00 00:00:00", "2026-02-30 00:00:00", "2024-02-29 12:00:00"];
  await generateAstroProject({
    ...project,
    records: project.records.map((record, index) => ({ ...record, modifiedAt: dates[index]! }))
  }, workspace);
  const sitemap = await readFile(join(workspace, "public/sitemap.xml"), "utf8");
  assert.deepEqual([...sitemap.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map((match) => match[1]),
    ["2026-09-27", "2024-02-29"]);
});
