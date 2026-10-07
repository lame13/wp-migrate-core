import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import type { MigrationConfig } from "../src/types.js";

function wxrDocument(...items: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

function page(id: number, slug: string, author = "niko"): string {
  return [
    "<item>",
    `<title>${slug}</title>`,
    `<link>https://example.test/${slug}/</link>`,
    `<dc:creator><![CDATA[${author}]]></dc:creator>`,
    `<wp:post_id>${id}</wp:post_id>`,
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    `<wp:post_name>${slug}</wp:post_name>`,
    "</item>"
  ].join("");
}

function post(
  options: {
    readonly id: number;
    readonly slug: string;
    readonly date: string;
    readonly author?: string;
    readonly category?: string;
  }
): string {
  return [
    "<item>",
    `<title>${options.slug}</title>`,
    `<link>https://example.test/${options.slug}/</link>`,
    `<dc:creator><![CDATA[${options.author ?? "niko"}]]></dc:creator>`,
    `<wp:post_id>${options.id}</wp:post_id>`,
    `<wp:post_date>${options.date} 09:00:00</wp:post_date>`,
    `<wp:post_date_gmt>${options.date} 09:00:00</wp:post_date_gmt>`,
    "<wp:post_type>post</wp:post_type>",
    "<wp:status>publish</wp:status>",
    `<wp:post_name>${options.slug}</wp:post_name>`,
    ...(options.category === undefined
      ? []
      : [`<category domain="category" nicename="${options.category}"><![CDATA[${options.category}]]></category>`]),
    "</item>"
  ].join("");
}

function attachment(): string {
  return [
    "<item><title>tap</title><wp:post_id>300</wp:post_id>",
    "<link>https://example.test/2026/05/tap/</link>",
    "<wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>",
    "<wp:attachment_url>https://example.test/wp-content/uploads/2026/05/tap.jpg</wp:attachment_url>",
    "<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/05/tap.jpg</wp:meta_value></wp:postmeta>",
    "</item>"
  ].join("");
}

function coverageEntry(project: ReturnType<typeof parseWxr>, path: string) {
  return project.coverage.entries.find((entry) => entry.path === path);
}

test("generates a term archive at the URL the live site already serves", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-archive-live-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const project = parseWxr(
    wxrDocument(
      page(1, "home"),
      post({ id: 10, slug: "guides", date: "2026-06-01", category: "guides" })
    ),
    { liveUrlSource: { urls: ["https://example.test/category/guides/"], sitemapRefs: [] } }
  );

  const archive = project.archives.pages.find((entry) => entry.subject === "category:guides");
  assert.equal(archive?.route, "/category/guides/");
  assert.equal(archive?.routeSource, "live-url");
  assert.equal(archive?.sourceUrl, "https://example.test/category/guides/");
  assert.deepEqual(archive?.sourceIds, ["wp:post:10"]);
  assert.equal(project.archives.summary.assumed, 1, "the author route still rests on a WordPress default");
  assert.equal(coverageEntry(project, "/category/guides/")?.status, "routed");

  await generateAstroProject(project, root);
  const listing = await readFile(join(root, "src/content/listings/category-guides.md"), "utf8");
  assert.match(listing, /route: "\/category\/guides\/"/);
  assert.match(listing, /<a href="\/guides\/">guides<\/a>/);
  const sitemap = await readFile(join(root, "public/sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/example\.test\/category\/guides\/<\/loc>/);
});

test("says so when an archive route rests on a WordPress default", () => {
  const project = parseWxr(
    wxrDocument(post({ id: 10, slug: "guides", date: "2026-06-01", category: "guides" }))
  );

  const taxonomy = project.archives.pages.find((entry) => entry.subject === "category:guides");
  assert.equal(taxonomy?.route, "/category/guides/");
  assert.equal(taxonomy?.routeSource, "wordpress-default");

  const assumed = project.issues.filter((issue) => issue.code === "ARCHIVE_ROUTE_ASSUMED");
  assert.deepEqual(
    assumed.map((issue) => issue.message),
    [
      '1 archive route uses the base "/author/", because no live URL you supplied identifies the real one.',
      '1 archive route uses the base "/category/", because no live URL you supplied identifies the real one.'
    ]
  );
  assert.match(assumed[0]?.requiredAction ?? "", /--live-urls/);
});

test("an author archive lists posts and leaves pages out", () => {
  const project = parseWxr(
    wxrDocument(
      page(1, "contact"),
      post({ id: 10, slug: "first", date: "2026-06-01" }),
      post({ id: 11, slug: "second", date: "2026-06-02", author: "dana" })
    )
  );

  const niko = project.archives.pages.find((entry) => entry.subject === "author:niko");
  const dana = project.archives.pages.find((entry) => entry.subject === "author:dana");
  assert.deepEqual(niko?.sourceIds, ["wp:post:10"]);
  assert.deepEqual(dana?.sourceIds, ["wp:post:11"]);
  assert.equal(project.archives.summary.authors, 2);
});

test("generates dates, a posts index and pagination only when asked", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-archive-optin-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const document = wxrDocument(
    page(1, "home"),
    post({ id: 10, slug: "alpha", date: "2026-06-01", category: "guides" }),
    post({ id: 11, slug: "beta", date: "2026-06-15", category: "guides" }),
    post({ id: 12, slug: "gamma", date: "2026-07-01", category: "guides" })
  );

  const plain = parseWxr(document);
  assert.equal(plain.archives.summary.dates, 0);
  assert.equal(plain.archives.summary.postsIndex, 0);
  assert.equal(plain.archives.pages.filter((entry) => entry.kind === "taxonomy").length, 1);

  const config: MigrationConfig = {
    archives: { dates: true, postsIndex: "/blog/", perPage: 2, attachmentPages: "ignore" }
  };
  const project = parseWxr(document, { config });

  assert.deepEqual(project.archives.summary, {
    taxonomies: 1,
    authors: 1,
    dates: 2,
    postsIndex: 1,
    fromLiveUrls: 0,
    // Three bases rest on a default or a derivation: /category/, /author/ and
    // the date base. The posts index base came from the config, so it is not
    // counted as an assumption.
    assumed: 3,
    feeds: 0
  });
  assert.deepEqual(
    project.archives.pages.filter((entry) => entry.kind === "posts-index").map((entry) => entry.route),
    ["/blog/", "/blog/page/2/"]
  );
  assert.deepEqual(
    project.archives.pages.filter((entry) => entry.kind === "date").map((entry) => entry.route),
    ["/2026/06/", "/2026/07/"]
  );

  await generateAstroProject(project, root);
  const first = await readFile(join(root, "src/content/listings/blog.md"), "utf8");
  const second = await readFile(join(root, "src/content/listings/blog-page-2.md"), "utf8");
  assert.match(first, /<a href="\/alpha\/">alpha<\/a>/);
  assert.match(first, /<a href="\/beta\/">beta<\/a>/);
  assert.match(first, /Page 1<\/span>/);
  assert.match(second, /<a href="\/gamma\/">gamma<\/a>/);
  assert.match(second, /<a href="\/blog\/">Page 1<\/a>/);
  assert.match(await readFile(join(root, "src/content/listings/2026-06.md"), "utf8"), /Posts from June 2026/);
});

test("writes a feed where the config asks for one, and a rule to reach it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-archive-feed-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const document = wxrDocument(
    page(1, "home"),
    post({ id: 10, slug: "first", date: "2026-06-01" })
  );
  const project = parseWxr(document, {
    config: { archives: { feeds: ["/feed/"], attachmentPages: "ignore" } },
    liveUrlSource: { urls: ["https://example.test/feed/"], sitemapRefs: [] }
  });

  assert.deepEqual(project.archives.feeds, [
    {
      id: "feed:/feed.xml",
      path: "/feed.xml",
      sourcePath: "/feed/",
      title: "Example site",
      sourceIds: ["wp:post:10"]
    }
  ]);
  assert.deepEqual(
    project.routes.redirects.map((redirect) => [redirect.sourcePath, redirect.targetRoute]),
    [["/feed/", "/feed.xml"]]
  );
  assert.equal(coverageEntry(project, "/feed/")?.status, "redirected");

  await generateAstroProject(project, root);
  const feed = await readFile(join(root, "public/feed.xml"), "utf8");
  assert.match(feed, /<title>Example site<\/title>/);
  assert.match(feed, /<link>https:\/\/example\.test\/first\/<\/link>/);
  assert.match(feed, /<pubDate>Mon, 01 Jun 2026 09:00:00 GMT<\/pubDate>/);
});

test("a feed needs an origin, and says so when the export has none", () => {
  const withoutOrigin = [
    "<rss><channel>",
    "<title>No URL</title>",
    post({ id: 10, slug: "first", date: "2026-06-01" }),
    "</channel></rss>"
  ].join("");

  const project = parseWxr(withoutOrigin, {
    config: { archives: { feeds: ["/feed/"], attachmentPages: "ignore" } }
  });
  const finding = project.issues.find((issue) => issue.code === "SITE_URL_MISSING");
  assert.equal(finding?.severity, "warning");
  assert.match(finding?.requiredAction ?? "", /site\.url/);
});

test("redirects attachment pages to the upload they describe", () => {
  const project = parseWxr(wxrDocument(page(1, "home"), attachment()));
  assert.deepEqual(
    project.routes.redirects.map((redirect) => [redirect.sourcePath, redirect.targetRoute]),
    [["/2026/05/tap/", "/wp-content/uploads/2026/05/tap.jpg"]]
  );
  assert.equal(
    project.routes.entries.some((entry) => entry.targetRoute === "/wp-content/uploads/2026/05/tap.jpg"),
    false,
    "a file that already exists needs a rule, not a generated route"
  );

  const ignored = parseWxr(wxrDocument(page(1, "home"), attachment()), {
    config: { archives: { attachmentPages: "ignore" } }
  });
  assert.deepEqual(ignored.routes.redirects, []);
});

test("pagination keeps distinct source URLs and never redirects the first archive page", () => {
  const project = parseWxr(wxrDocument(
    post({ id: 10, slug: "first", date: "2026-06-01", category: "guides" }),
    post({ id: 11, slug: "second", date: "2026-06-02", category: "guides" })
  ), {
    config: { archives: { perPage: 1 } },
    liveUrlSource: { urls: ["https://example.test/category/guides/"], sitemapRefs: [] }
  });
  assert.deepEqual(project.routes.redirects, []);
  assert.equal(project.archives.pages.find((entry) => entry.paginated)?.sourceUrl,
    "https://example.test/category/guides/page/2/");
});

test("query attachment permalinks never become path-only redirects", () => {
  const project = parseWxr(wxrDocument(page(1, "home"), attachment().replace(
    "https://example.test/2026/05/tap/", "https://example.test/?attachment_id=300"
  )));
  assert.deepEqual(project.routes.redirects, []);
});

test("an explicit XML feed is a file and participates in route coverage", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-xml-feed-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(post({ id: 10, slug: "first", date: "2026-06-01" })), {
    config: { archives: { feeds: ["/rss.xml"] } },
    liveUrlSource: { urls: ["https://example.test/rss.xml"], sitemapRefs: [] }
  });
  assert.equal(project.archives.feeds[0]?.path, "/rss.xml");
  assert.equal(coverageEntry(project, "/rss.xml")?.status, "routed");
  await generateAstroProject(project, root);
  assert.match(await readFile(join(root, "public/rss.xml"), "utf8"), /<rss version="2.0">/);
});

test("conversion refuses content and archive route collisions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-archive-collision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = parseWxr(wxrDocument(
    page(1, "category/guides"),
    post({ id: 10, slug: "first", date: "2026-06-01", category: "guides" })
  ));
  await assert.rejects(generateAstroProject(project, root), /Cannot generate duplicate route/);
});

test("archive matching ignores external URLs, content permalinks and other taxonomy bases", () => {
  const document = wxrDocument(
    post({ id: 10, slug: "blog/guides", date: "2026-06-01", category: "guides" })
  );
  for (const url of ["https://external.test/topics/guides/", "https://example.test/blog/guides/",
    "https://example.test/tag/guides/", "https://example.test/author/guides/"]) {
    const project = parseWxr(document, { liveUrlSource: { urls: [url], sitemapRefs: [] } });
    const archive = project.archives.pages.find((entry) => entry.subject === "category:guides");
    assert.equal(archive?.route, "/category/guides/", url);
    assert.equal(archive?.routeSource, "wordpress-default", url);
  }
});
