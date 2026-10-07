import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseWxr } from "../src/core.js";
import { extractContentEvidence } from "routelint";
import { generateAstroProject } from "../src/generate.js";
import { deliveryCheckTargets } from "../src/delivery.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import type { MigrationProject } from "../src/types.js";
import { verifySite } from "../src/verify.js";

const pageText =
  "This migrated page carries enough of the original words to verify that its content arrived in the built site successfully.";

function wxrDocument(...items: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

function page(body = `<p>${pageText}</p>`, link = "https://example.test/example-page/"): string {
  return [
    "<item>",
    "<title>Example page</title>",
    `<link>${link}</link>`,
    "<wp:post_id>1</wp:post_id>",
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>example-page</wp:post_name>",
    `<content:encoded><![CDATA[${body}]]></content:encoded>`,
    "</item>"
  ].join("");
}

function attachment(): string {
  return [
    "<item><title>Photo</title><wp:post_id>101</wp:post_id>",
    "<wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>",
    "<wp:attachment_url>https://example.test/wp-content/uploads/2026/05/photo.jpg</wp:attachment_url>",
    "<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/05/photo.jpg</wp:meta_value></wp:postmeta>",
    "</item>"
  ].join("");
}

async function writeBuiltPage(
  directory: string,
  route: string,
  body: string,
  head = ""
): Promise<void> {
  const file = join(directory, route.replace(/^\/|\/$/g, ""), "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `<!doctype html><html lang="en"><head>${head}<title>Built</title></head><body>${body}</body></html>`,
    "utf8"
  );
}

function findingsFor(verification: Awaited<ReturnType<typeof verifySite>>, code: string) {
  return verification.launch.filter((finding) => finding.code === code);
}

test("the gate blocks a launch when copied media never reached the build", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const uploads = join(root, "uploads", "2026", "05");
  await mkdir(uploads, { recursive: true });
  await writeFile(join(uploads, "photo.jpg"), "jpeg bytes", "utf8");

  const parsed = parseWxr(
    wxrDocument(page(`<p>${pageText}</p><img src="https://example.test/wp-content/uploads/2026/05/photo.jpg">`), attachment())
  );
  const project = applyMediaDelivery(
    parsed,
    await planMediaDelivery(parsed, { uploadsDirectory: join(root, "uploads") })
  );
  assert.equal(project.media.delivery?.summary.copied, 1);

  const site = join(root, "dist");
  await writeBuiltPage(site, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);

  const missing = await verifySite(project, { htmlDirectory: site });
  const blockers = findingsFor(missing, "MEDIA_MISSING_IN_BUILD");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]?.severity, "blocker");
  assert.deepEqual(blockers[0]?.routes, ["/wp-content/uploads/2026/05/photo.jpg"]);
  assert.equal(missing.summary.launchBlockers, 1);

  const mediaFile = join(site, "wp-content", "uploads", "2026", "05", "photo.jpg");
  await mkdir(dirname(mediaFile), { recursive: true });
  await writeFile(mediaFile, "", "utf8");

  const empty = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(empty, "MEDIA_MISSING_IN_BUILD").length, 0);
  assert.equal(findingsFor(empty, "MEDIA_EMPTY_IN_BUILD").length, 1);

  await writeFile(mediaFile, "jpeg bytes", "utf8");
  const complete = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(complete, "MEDIA_MISSING_IN_BUILD").length, 0);
  assert.equal(findingsFor(complete, "MEDIA_EMPTY_IN_BUILD").length, 0);
});

test("the gate blocks a launch while robots.txt still disallows crawling", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-robots-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, "dist");
  await writeBuiltPage(site, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);

  const project = parseWxr(wxrDocument(page()));
  await writeFile(join(site, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");
  const blocked = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(blocked, "ROBOTS_BLOCKED").length, 1);
  assert.equal(findingsFor(blocked, "ROBOTS_BLOCKED")[0]?.severity, "blocker");

  // A rule for one crawler is not a closed site.
  await writeFile(join(site, "robots.txt"), "User-agent: badbot\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "utf8");
  const scoped = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(scoped, "ROBOTS_BLOCKED").length, 0);
});

test("the gate reports canonical URLs and sitemap coverage", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-meta-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, "dist");
  const project = parseWxr(wxrDocument(page()));

  await writeBuiltPage(site, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);
  const bare = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(bare, "CANONICAL_MISSING").length, 1);
  assert.equal(findingsFor(bare, "SITEMAP_INCOMPLETE").length, 1);

  await writeBuiltPage(
    site,
    "/example-page/",
    `<h1>Built</h1><p>${pageText}</p>`,
    '<link rel="canonical" href="https://example.test/example-page/" />'
  );
  await writeFile(
    join(site, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://example.test/example-page/</loc></url></urlset>\n`,
    "utf8"
  );

  const ready = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(ready, "CANONICAL_MISSING").length, 0);
  assert.equal(findingsFor(ready, "SITEMAP_INCOMPLETE").length, 0);
  assert.deepEqual(
    ready.launch.map((finding) => finding.code),
    []
  );
  assert.ok(ready.checks.every((check) => check.id === "delivery" || check.id === "import" || check.checked));

  // A canonical that points at another page is a different problem, named.
  await writeBuiltPage(
    site,
    "/example-page/",
    `<h1>Built</h1><p>${pageText}</p>`,
    '<link rel="canonical" href="https://example.test/elsewhere/" />'
  );
  const mismatched = await verifySite(project, { htmlDirectory: site });
  const canonical = findingsFor(mismatched, "CANONICAL_MISSING");
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]?.route, "/example-page/");
  assert.equal(canonical[0]?.field, "canonical");
});

test("the gate reports internal links that resolve to nothing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-links-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, "dist");
  const project = parseWxr(wxrDocument(page()));

  await writeBuiltPage(
    site,
    "/example-page/",
    `<h1>Built</h1><p>${pageText}</p><a href="/gone/">Gone</a><a href="/example-page">No slash</a><a href="https://elsewhere.example/x">Elsewhere</a>`
  );
  const verification = await verifySite(project, { htmlDirectory: site });
  const links = findingsFor(verification, "LINK_TARGET_MISSING_IN_BUILD");
  assert.equal(links.length, 2, "the external link is not this site's problem");

  const gone = links.find((finding) => finding.field === "/gone/");
  assert.equal(gone?.severity, "warning");
  assert.deepEqual(gone?.routes, ["/example-page/"]);
  assert.match(gone?.message ?? "", /no generated route, no redirect rule and no built file/i);

  const slash = links.find((finding) => finding.field === "/example-page");
  assert.match(slash?.title ?? "", /without the trailing slash/);

  await writeBuiltPage(
    site,
    "/example-page/",
    `<h1>Built</h1><p>${pageText}</p><a href="/example-page/">Fine</a>`
  );
  const clean = await verifySite(project, { htmlDirectory: site });
  assert.equal(findingsFor(clean, "LINK_TARGET_MISSING_IN_BUILD").length, 0);
});

test("the gate says which checks it could not take instead of passing them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-report-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(page()));
  const reportPath = join(root, "routelint.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      schemaVersion: "4",
      toolVersion: "0.4.0",
      generatedAt: "2026-09-27T00:00:00.000Z",
      durationMs: 1,
      baseUrl: "https://example.test/",
      config: { maxPages: 25, maxDepth: 3, agents: ["browser"], respectRobots: true, queryPolicy: "drop" },
      sitemap: { requested: [], fetched: [], entries: [], warnings: [] },
      routes: [
        {
          url: "https://example.test/example-page/",
          depth: 0,
          sources: [{ kind: "seed" }],
          snapshots: [
            {
              requestedUrl: "https://example.test/example-page/",
              finalUrl: "https://example.test/example-page/",
              agent: { key: "browser", label: "Browser", userAgent: "verification-fixture/1" },
              status: 200,
              headers: {},
              redirects: [],
              signals: {
                titles: [{ value: "Built", location: "head" }],
                descriptions: [],
                canonicals: [],
                robots: [],
                h1s: [{ value: "Built", location: "body" }],
                links: [],
                hreflangs: []
              },
              bytesRead: pageText.length,
              content: extractContentEvidence(`<h1>Built</h1><p>${pageText}</p>`),
              durationMs: 1,
              completion: "complete"
            }
          ],
          inbound: [],
          outbound: []
        }
      ],
      findings: [],
      summary: {
        routes: 1,
        fetched: 1,
        indexable: 1,
        errors: 0,
        warnings: 0,
        info: 0,
        brokenLinks: 0,
        redirects: 0,
        noindex: 0,
        maxDepth: 0
      },
      truncated: false
    }),
    "utf8"
  );

  const verification = await verifySite(project, { routelintReportPath: reportPath });
  const unchecked = verification.checks.filter((check) => !check.checked);
  assert.deepEqual(
    unchecked.map((check) => check.id).sort(),
    ["canonical", "delivery", "import", "links", "media", "robots", "sitemap"]
  );
  assert.ok(unchecked.every((check) => (check.reason ?? "").length > 0));
  assert.equal(verification.summary.uncheckedChecks, unchecked.length);
  assert.equal(
    verification.launch.some((finding) => finding.source === "html-directory"),
    false,
    "a crawl report cannot produce findings that need the build output"
  );
});

test("publish-ready writes the files a launch needs, and the default does not", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-publish-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project: MigrationProject = parseWxr(wxrDocument(page()));

  const privateSite = join(root, "private");
  await generateAstroProject(project, privateSite);
  const privateLayout = await readFile(join(privateSite, "src/layouts/Layout.astro"), "utf8");
  assert.match(privateLayout, /content="noindex, nofollow"/);
  assert.doesNotMatch(privateLayout, /canonical/);
  assert.equal(await readFile(join(privateSite, "public/robots.txt"), "utf8"), "User-agent: *\nDisallow: /\n");

  const readySite = join(root, "ready");
  await generateAstroProject(project, readySite, { publishReady: true });
  const readyLayout = await readFile(join(readySite, "src/layouts/Layout.astro"), "utf8");
  assert.doesNotMatch(readyLayout, /noindex/);
  assert.match(readyLayout, /rel="canonical"/);
  assert.match(readyLayout, /route\?: string;/);
  const readyPage = await readFile(join(readySite, "src/pages/[...slug].astro"), "utf8");
  assert.match(readyPage, /route=\{entry\.data\.route\}/);
  assert.match(
    await readFile(join(readySite, "public/robots.txt"), "utf8"),
    /User-agent: \*\nAllow: \/\n\nSitemap: https:\/\/example\.test\/sitemap\.xml\n/
  );
});

test("verification and delivery checks include generated archives", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-archive-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(page().replace("</item>",
    '<category domain="category" nicename="guides">Guides</category></item>')));
  await writeBuiltPage(root, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);
  const missing = await verifySite(project, { htmlDirectory: root });
  assert.equal(missing.routes.find((route) => route.route === "/category/guides/")?.status, "route-missing");
  assert.ok(deliveryCheckTargets(project).some((target) => target.route === "/category/guides/"));
  await writeBuiltPage(root, "/category/guides/", '<h1>Guides</h1><a href="/example-page/">Example</a>',
    '<meta name="robots" content="noindex">');
  const blocked = await verifySite(project, { htmlDirectory: root });
  assert.ok(blocked.launch.some((finding) => finding.code === "INDEXING_BLOCKED" &&
    (finding.route === "/category/guides/" || finding.routes?.includes("/category/guides/"))));
});

test("CLI verification plans media from the config and reports missing build files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-cli-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "uploads/2026/05"), { recursive: true });
  await writeFile(join(root, "uploads/2026/05/photo.jpg"), "photo bytes");
  await writeFile(join(root, "export.xml"), wxrDocument(page(
    `<p>${pageText}</p><img src="https://example.test/wp-content/uploads/2026/05/photo.jpg">`), attachment()));
  await writeFile(join(root, "wp-migrate-core.config.json"), JSON.stringify({ media: { uploadsDir: "uploads" } }));
  await writeBuiltPage(join(root, "dist"), "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"),
    "verify", "export.xml", "--html-dir", "dist", "--json", "--fail-on", "blocker"],
    { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(JSON.parse(result.stdout).launch.findings.some((finding: { code: string }) => finding.code === "MEDIA_MISSING_IN_BUILD"));
});

test("media without a delivery plan is reported as unchecked", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-unplanned-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeBuiltPage(root, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);
  const project = parseWxr(wxrDocument(page(), attachment()));
  const verification = await verifySite(project, { htmlDirectory: root });
  assert.equal(verification.checks.find((check) => check.id === "media")?.checked, false);
});

test("robots checks handle multiple agents in one group and equally specific allow rules", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-robots-groups-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeBuiltPage(root, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`);
  const project = parseWxr(wxrDocument(page()));
  await writeFile(join(root, "robots.txt"), "User-agent: *\nUser-agent: crawler\nDisallow: /\n");
  assert.equal(findingsFor(await verifySite(project, { htmlDirectory: root }), "ROBOTS_BLOCKED").length, 1);
  await writeFile(join(root, "robots.txt"), "User-agent: *\nDisallow: /\nAllow: /\n");
  assert.equal(findingsFor(await verifySite(project, { htmlDirectory: root }), "ROBOTS_BLOCKED").length, 0);
});

test("a canonical on another origin or with an invalid scheme does not pass", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-canonical-origin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const canonical of ["https://wrong.test/example-page/", "javascript:alert(1)"]) {
    await writeBuiltPage(root, "/example-page/", `<h1>Built</h1><p>${pageText}</p>`,
      `<link rel="canonical" href="${canonical}">`);
    const verification = await verifySite(parseWxr(wxrDocument(page())), { htmlDirectory: root });
    assert.equal(findingsFor(verification, "CANONICAL_MISSING").length, 1, canonical);
  }
});

test("encoded download links resolve to the actual build filename", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-gate-encoded-file-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeBuiltPage(root, "/example-page/", `<h1>Built</h1><p>${pageText}</p><a href="/guide%20notes.pdf">Download</a>`);
  await writeFile(join(root, "guide notes.pdf"), "pdf bytes");
  const verification = await verifySite(parseWxr(wxrDocument(page())), { htmlDirectory: root });
  assert.equal(findingsFor(verification, "LINK_TARGET_MISSING_IN_BUILD").length, 0);
});
