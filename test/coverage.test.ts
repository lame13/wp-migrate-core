import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parseWxr } from "../src/core.js";
import { coverageEntryRecords, mergeLiveUrlSources, parseLiveUrlSource } from "../src/live-urls.js";
import { renderReport } from "../src/report.js";
import type { LiveUrlEntry, LiveUrlSource, MigrationProject } from "../src/types.js";
import { demoFixturePath, demoSitemapPath } from "./fixture-path.js";

function publishedPage(postId: string, link: string, slug: string, status = "publish"): string {
  return [
    "<item>",
    `<title>Page ${postId}</title>`,
    `<link>${link}</link>`,
    `<wp:post_id>${postId}</wp:post_id>`,
    "<wp:post_type>page</wp:post_type>",
    `<wp:status>${status}</wp:status>`,
    `<wp:post_name>${slug}</wp:post_name>`,
    "</item>"
  ].join("");
}

function wxrDocument(...items: readonly string[]): string {
  return [
    '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">',
    "<channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

async function demoProject(liveUrls: readonly string[]): Promise<MigrationProject> {
  return parseWxr(await readFile(demoFixturePath, "utf8"), {
    liveUrlSource: { urls: liveUrls, sitemapRefs: [] }
  });
}

function entryFor(project: MigrationProject, path: string): LiveUrlEntry | undefined {
  return project.coverage.entries.find((entry) => entry.path === path);
}

test("reads a sitemap, a sitemap index and a plain list of live URLs", () => {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://example.test/</loc><image:loc>https://example.test/wp-content/uploads/photo.jpg</image:loc></url>
  <url><loc><![CDATA[https://example.test/caf%C3%A9/]]></loc></url>
  <url><loc>https://example.test/search?a=1&amp;b=2</loc></url>
</urlset>`;

  assert.deepEqual(parseLiveUrlSource(sitemap), {
    urls: ["https://example.test/", "https://example.test/caf%C3%A9/", "https://example.test/search?a=1&b=2"],
    sitemapRefs: []
  });

  const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://example.test/post-sitemap.xml</loc></sitemap>
    <sitemap><loc>https://example.test/page-sitemap.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseLiveUrlSource(index), {
    urls: [],
    sitemapRefs: ["https://example.test/post-sitemap.xml", "https://example.test/page-sitemap.xml"]
  });

  const list = "\uFEFF# Pages\nhttps://example.test/\n\n  /services/  \nhttps://example.test/\n";
  assert.deepEqual(parseLiveUrlSource(list), { urls: ["https://example.test/", "/services/"], sitemapRefs: [] });

  assert.deepEqual(
    mergeLiveUrlSources([
      { urls: ["https://example.test/"], sitemapRefs: [] },
      { urls: ["https://example.test/", "/about/"], sitemapRefs: ["https://example.test/sitemap.xml"] }
    ]),
    { urls: ["https://example.test/", "/about/"], sitemapRefs: ["https://example.test/sitemap.xml"] }
  );
});

test("refuses contents it cannot read as a list of live URLs", () => {
  assert.throws(() => parseLiveUrlSource(gzipSync("<urlset/>")), /compressed/);
  assert.throws(
    () => parseLiveUrlSource("<rss><channel><wp:wxr_version>1.2</wp:wxr_version></channel></rss>"),
    /WordPress export/
  );
  assert.throws(() => parseLiveUrlSource("<!doctype html><html><body>Saved page</body></html>"), /not a sitemap/);
});

test("classifies the demo sitemap against routes, rules and WordPress shapes", async () => {
  const project = parseWxr(await readFile(demoFixturePath, "utf8"), {
    liveUrlSource: parseLiveUrlSource(await readFile(demoSitemapPath))
  });

  assert.deepEqual(project.coverage.summary, {
    checked: true,
    liveUrls: 17,
    routed: 4,
    redirected: 1,
    unresolved: 0,
    excluded: 9,
    externalHosts: 1,
    invalid: 0,
    uncovered: 2,
    sitemapRefs: 0
  });

  assert.equal(entryFor(project, "/")?.status, "routed");
  assert.equal(entryFor(project, "/services/")?.targetRoute, "/services/");
  assert.equal(entryFor(project, "/guides/stop-a-leaking-tap")?.status, "redirected");
  assert.equal(entryFor(project, "/guides/stop-a-leaking-tap")?.targetRoute, "/guides/stop-a-leaking-tap/");
  assert.equal(entryFor(project, "/category/guides/")?.shape, "taxonomy-archive");
  assert.match(entryFor(project, "/category/guides/")?.reason ?? "", /"Guides" category term/);
  assert.equal(entryFor(project, "/feed/")?.shape, "feed");
  assert.equal(entryFor(project, "/services/page/2/")?.shape, "paged");
  assert.equal(entryFor(project, "/2026/06/")?.shape, "date-archive");
  assert.equal(entryFor(project, "/author/dana/")?.shape, "author-archive");
  assert.equal(entryFor(project, "/wp-login.php")?.shape, "wordpress-endpoint");
  assert.equal(entryFor(project, "/wp-content/uploads/2026/05/tap.jpg")?.shape, "media-file");
  assert.match(entryFor(project, "/wp-content/uploads/2026/05/boiler-room.jpg")?.reason ?? "", /no attachment record/);
  assert.equal(entryFor(project, "/")?.hasQuery, false);
  assert.equal(entryFor(project, "/guides/water-heater-repair/")?.status, "uncovered");

  const external = project.coverage.entries.find((entry) => entry.status === "external-host");
  assert.equal(external?.host, "cdn.brightpath.example");

  const uncovered = project.issues.filter((issue) => issue.code === "LIVE_URL_UNCOVERED");
  assert.equal(uncovered.length, 2);
  assert.equal(uncovered[0]?.severity, "warning");
  assert.match(uncovered[0]?.message ?? "", /water-heater-repair/);
  assert.match(uncovered[0]?.requiredAction ?? "", /redirect rule/);
  assert.equal(uncovered[0]?.route, "/guides/water-heater-repair/");
});

test("keeps a trailing slash part of the URL and asks for a rule when only a variant exists", async () => {
  const project = await demoProject([
    "https://brightpath.example/services",
    "https://brightpath.example/services/",
    "https://brightpath.example/guides/stop-a-leaking-tap",
    "https://brightpath.example/guides/stop-a-leaking-tap/"
  ]);

  assert.equal(project.coverage.entries.length, 4, "a trailing slash is a different URL, not a duplicate");
  assert.equal(entryFor(project, "/services/")?.status, "routed");
  assert.equal(entryFor(project, "/services")?.status, "uncovered");
  assert.equal(entryFor(project, "/services")?.targetRoute, "/services/");
  assert.match(entryFor(project, "/services")?.reason ?? "", /serves this path as \/services\//);
  assert.equal(entryFor(project, "/guides/stop-a-leaking-tap/")?.status, "routed");
  assert.equal(entryFor(project, "/guides/stop-a-leaking-tap")?.status, "redirected");
  assert.equal(project.coverage.summary.uncovered, 1);
});

test("checks each live URL once and ignores the scheme", async () => {
  const project = await demoProject([
    "http://brightpath.example/services/",
    "https://brightpath.example/services/",
    "https://brightpath.example/services/"
  ]);

  assert.equal(project.coverage.entries.length, 1);
  assert.equal(project.coverage.entries[0]?.status, "routed");
  assert.equal(project.coverage.summary.liveUrls, 1);
});

test("separates URLs the export declares from URLs nothing in the plan accounts for", () => {
  const xml = wxrDocument(
    publishedPage("1", "https://example.test/example-page/", "example-page"),
    publishedPage("2", "https://example.test/draft-page/", "draft-page", "draft"),
    publishedPage("not-a-number", "https://example.test/broken/", "broken")
  );
  const project = parseWxr(xml, {
    liveUrlSource: {
      urls: [
        "https://example.test/example-page/",
        "https://example.test/draft-page/",
        "https://example.test/broken/",
        "https://example.test/gone/"
      ],
      sitemapRefs: []
    }
  });

  assert.equal(entryFor(project, "/example-page/")?.status, "routed");
  assert.equal(entryFor(project, "/draft-page/")?.status, "unresolved");
  assert.equal(entryFor(project, "/draft-page/")?.sourceStatus, "excluded");
  assert.match(entryFor(project, "/draft-page/")?.reason ?? "", /published content only/);
  assert.equal(entryFor(project, "/broken/")?.sourceStatus, "skipped");
  assert.equal(entryFor(project, "/gone/")?.status, "uncovered");
  assert.deepEqual(project.coverage.summary, {
    checked: true,
    liveUrls: 4,
    routed: 1,
    redirected: 0,
    unresolved: 2,
    excluded: 0,
    externalHosts: 0,
    invalid: 0,
    uncovered: 1,
    sitemapRefs: 0
  });
  assert.equal(project.issues.filter((issue) => issue.code === "LIVE_URL_UNCOVERED").length, 1);
});

test("never echoes credentials, query strings or entries it cannot read", () => {
  const project = parseWxr(wxrDocument(publishedPage("1", "https://example.test/example-page/", "example-page")), {
    liveUrlSource: {
      urls: [
        "https://private-user:private-password@example.test/example-page/",
        "https://example.test/example-page/?private-query=secret",
        "ftp://private-user:private-password@example.test/file"
      ],
      sitemapRefs: ["https://example.test/sitemap.xml?private-query=secret"]
    }
  });

  const credentials = project.coverage.entries.find((entry) => entry.hasQuery === false && entry.status === "routed");
  assert.equal(credentials?.url, "https://example.test/example-page/");

  const query = project.coverage.entries.find((entry) => entry.hasQuery);
  assert.equal(query?.status, "excluded-shape");
  assert.equal(query?.shape, "query-url");
  assert.equal(query?.url, "https://example.test/example-page/");

  const unreadable = project.coverage.entries.find((entry) => entry.status === "invalid-url");
  assert.equal(unreadable?.url, undefined);
  assert.match(unreadable?.reason ?? "", /scheme other than HTTP or HTTPS/);

  const serialized = [
    JSON.stringify(project.coverage),
    JSON.stringify(coverageEntryRecords(project.coverage)),
    renderReport(project)
  ].join("\n");
  assert.doesNotMatch(serialized, /private-user|private-password|private-query|secret/);
});

test("warns when the supplied source lists no page URLs", () => {
  const project = parseWxr(wxrDocument(publishedPage("1", "https://example.test/example-page/", "example-page")), {
    liveUrlSource: { urls: [], sitemapRefs: ["https://example.test/post-sitemap.xml", "https://example.test/page-sitemap.xml"] }
  });

  assert.equal(project.coverage.summary.checked, true);
  assert.equal(project.coverage.summary.liveUrls, 0);
  assert.equal(project.coverage.summary.sitemapRefs, 2);

  const issues = project.issues.filter((issue) => issue.code === "LIVE_URL_SOURCE_EMPTY");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, "warning");
  assert.match(issues[0]?.message ?? "", /2 child sitemaps/);
  assert.match(issues[0]?.requiredAction ?? "", /--live-urls/);
});

test("reports coverage as unchecked when no live URLs are supplied", () => {
  const project = parseWxr(wxrDocument(publishedPage("1", "https://example.test/example-page/", "example-page")));

  assert.deepEqual(project.coverage, {
    entries: [],
    summary: {
      checked: false,
      liveUrls: 0,
      routed: 0,
      redirected: 0,
      unresolved: 0,
      excluded: 0,
      externalHosts: 0,
      invalid: 0,
      uncovered: 0,
      sitemapRefs: 0
    }
  });
  assert.equal(project.issues.filter((issue) => issue.code.startsWith("LIVE_URL")).length, 0);
  assert.match(renderReport(project), /No live URL source was checked/);
});

test("accepts a live URL source the caller already parsed", () => {
  const source: LiveUrlSource = { urls: ["/example-page/"], sitemapRefs: [] };
  const project = parseWxr(wxrDocument(publishedPage("1", "https://example.test/example-page/", "example-page")), {
    liveUrlSource: source
  });

  assert.equal(project.coverage.entries.length, 1);
  assert.equal(project.coverage.entries[0]?.status, "routed");
  assert.equal(project.coverage.entries[0]?.url, "/example-page/");
});

test("keeps query URLs distinct and normalizes relative paths like absolute URLs", async () => {
  const project = await demoProject([
    "/services/", "/services/?page=1", "/services/?page=2", "/services/#part?text",
    "/café/", "https://brightpath.example/café/"
  ]);
  assert.equal(project.coverage.summary.routed, 1);
  assert.equal(project.coverage.summary.excluded, 2);
  assert.equal(project.coverage.entries.filter((entry) => entry.path === "/caf%C3%A9/").length, 2);
  assert.doesNotMatch(JSON.stringify(project.coverage), /page=|part\?text/);
});

test("does not claim full coverage for excluded or unreadable entries", async () => {
  for (const urls of [["/feed/"], ["https://elsewhere.example/"], ["/services/", "invalid"]]) {
    const report = renderReport(await demoProject(urls));
    assert.doesNotMatch(report, /Every live URL you supplied is accounted for/);
    assert.match(report, /Some entries still need review/);
  }
  assert.match(renderReport(await demoProject(["/services/"])), /Every live URL you supplied is accounted for/);
});

test("warns when no entry is readable and never echoes an unsupported scheme", async () => {
  const project = await demoProject(["private-secret:some-value", "not a URL"]);
  assert.equal(project.coverage.summary.liveUrls, 0);
  assert.equal(project.issues.filter((issue) => issue.code === "LIVE_URL_SOURCE_EMPTY").length, 1);
  assert.doesNotMatch(JSON.stringify(project.coverage), /private-secret|some-value/);
});

test("counts generated paths even when their source permalink needs a query decision", () => {
  const project = parseWxr(wxrDocument(publishedPage("1", "https://example.test/?p=1", "page")), {
    liveUrlSource: { urls: ["/", "/?p=1"], sitemapRefs: [] }
  });
  assert.equal(project.routes.entries[0]?.status, "ambiguous-url");
  assert.equal(project.coverage.summary.routed, 1);
  assert.equal(project.coverage.summary.excluded, 1);
});

test("reads prefixed sitemaps without treating comments or extension locs as pages", () => {
  const source = parseLiveUrlSource(`<?xml version="1.0"?>
    <s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="urn:image">
      <!-- <s:url><s:loc>https://example.test/commented/</s:loc></s:url> -->
      <s:url><s:loc><![CDATA[https://example.test/literal&amp;name/]]></s:loc>
        <image:loc>https://example.test/photo.jpg</image:loc>
        <image:image><s:loc>https://example.test/nested.jpg</s:loc></image:image>
      </s:url>
      <s:url><s:loc>https://example.test/&#38;amp;name/</s:loc></s:url>
    </s:urlset>`);
  assert.deepEqual(source.urls, ["https://example.test/literal&amp;name/", "https://example.test/&amp;name/"]);
  assert.deepEqual(parseLiveUrlSource('<s:sitemapindex xmlns:s="urn:sitemap"><s:sitemap><s:loc>/child.xml</s:loc></s:sitemap></s:sitemapindex>'), {
    urls: [], sitemapRefs: ["/child.xml"]
  });
});

test("rejects truncated XML and invalid UTF-8 instead of checking a partial or corrupted sitemap", () => {
  assert.throws(() => parseLiveUrlSource("<urlset><url><loc>/page/</loc></url>"), /complete/);
  assert.throws(() => parseLiveUrlSource("<urlset><url></urlset>"), /complete/);
  assert.throws(() => parseLiveUrlSource(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), /UTF-8/);
});
