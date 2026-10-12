import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  renderArchivesArtifact,
  renderCoverageArtifact,
  renderIssuesArtifact,
  renderLinksArtifact,
  renderMediaArtifact,
  renderMenusArtifact,
  renderRedirectsArtifact
} from "./artifacts.js";
import {
  contentCollectionName,
  mediaPath,
  normalizeRoute,
  readHtmlAttribute,
  sanitizeSourceUrl
} from "./core.js";
import {
  absoluteOnOrigin,
  deliveryCheckFiles,
  deliveryCheckTargetLimit,
  deliveryCheckTargets,
  siteOrigin
} from "./delivery.js";
import { deliverMedia } from "./media.js";
import { redirectRuleFiles } from "./redirect-rules.js";
import {
  escapeHtml,
  escapeHtmlAttribute,
  prepareOutputDirectory,
  renderJson,
  safeFileStem,
  writeNewFile
} from "./render.js";
import { targetRecords } from "./targets.js";
import type {
  ArchivePage,
  ContentRecord,
  FeedFile,
  MediaAsset,
  MediaDeliveryEntry,
  MenuItem,
  MigrationIssue,
  MigrationNode,
  MigrationProject
} from "./types.js";
import { packageVersion, ssrwireDependency } from "./version.js";

const GENERATOR_NAME = "wp-migrate-core";
const SAFE_ELEMENTOR_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

interface GeneratedRecord {
  readonly kind: "content";
  readonly record: ContentRecord;
  readonly collection: string;
  readonly fileName: string;
  readonly route: string;
  readonly sourceUrl: string;
}

/** A listing page: an archive WordPress generated, written as a content entry. */
interface GeneratedListing {
  readonly kind: "listing";
  readonly archive: ArchivePage;
  readonly collection: "listings";
  readonly fileName: string;
  readonly route: string;
  readonly sourceUrl: string;
}

type GeneratedPage = GeneratedRecord | GeneratedListing;

export interface GenerateOptions {
  /**
   * Rewrite same-site links so the generated content points at its own routes
   * instead of the source permalinks. Defaults to true.
   */
  readonly rewriteLinks?: boolean;
  /**
   * Write a site that is ready to be indexed: a canonical URL per page, and a
   * robots.txt that allows crawling and names the sitemap. The default handoff
   * stays private on purpose, and `verify` reports whichever one it finds.
   */
  readonly publishReady?: boolean;
}

export async function generateAstroProject(
  project: MigrationProject,
  outDir: string,
  options: GenerateOptions = {}
): Promise<void> {
  const outputDirectory = await prepareOutputDirectory(outDir);
  const records = prepareRecords(project);
  const listings = prepareListings(project);
  const pages: readonly GeneratedPage[] = [...records, ...listings];
  const routes = new Set<string>();
  for (const page of pages) {
    if (routes.has(page.route)) throw new Error(`Cannot generate duplicate route: ${page.route}`);
    routes.add(page.route);
  }
  const linkRewritesByRecord = createLinkRewriteMap(project, options.rewriteLinks !== false);
  const media = createMediaRenderer(project);

  if (project.media.delivery !== undefined) {
    // The plan already measured every file; this only writes the copies into
    // the site's own `public/` tree, so the source upload paths keep serving.
    await deliverMedia(project.media.delivery, outputDirectory);
  }

  const files = new Map<string, string>([
    ["package.json", renderPackageJson(project)],
    ["astro.config.mjs", renderAstroConfig(project)],
    ["tsconfig.json", renderTsConfig()],
    ["src/content.config.ts", renderContentConfig(project)],
    ["src/pages/[...slug].astro", renderCatchAllPage(project, options.publishReady === true)],
    ["src/layouts/Layout.astro", renderLayout(project, options.publishReady === true)],
    ["src/styles/global.css", renderStyles()],
    ["public/robots.txt", renderRobotsTxt(project, options.publishReady === true)],
    ["migration/issues.json", renderIssuesArtifact(project.issues)],
    ["migration/media.json", renderMediaArtifact(project, "astro")],
    ["migration/redirects.json", renderRedirectsArtifact(project, "astro")],
    ["migration/links.json", renderLinksArtifact(project, "astro")],
    ["migration/coverage.json", renderCoverageArtifact(project, "astro")],
    ["migration/archives.json", renderArchivesArtifact(project, "astro")],
    ["migration/menus.json", renderMenusArtifact(project, "astro")],
    ["migration/manifest.json", renderManifest(project, pages)],
    ["README.md", renderReadme(project, options.rewriteLinks !== false)]
  ]);

  if (project.menus.trees.length > 0) {
    files.set("src/components/Nav.astro", renderNavComponent(project));
  }

  const origin = siteOrigin(project);
  if (origin !== undefined) {
    files.set("public/sitemap.xml", renderSitemap(pages, origin));
  }
  for (const feed of project.archives.feeds) {
    if (origin === undefined) {
      continue;
    }
    const path = `public${feed.path}`;
    if (files.has(path)) throw new Error(`Cannot overwrite generated file with a feed: ${feed.path}`);
    files.set(path, renderFeed(feed, project, origin));
  }

  for (const ruleFile of redirectRuleFiles(project)) {
    files.set(ruleFile.path, ruleFile.contents);
  }

  for (const checkFile of deliveryCheckFiles(project)) {
    files.set(checkFile.path, checkFile.contents);
  }

  for (const generated of pages) {
    files.set(
      `src/content/${generated.collection}/${generated.fileName}`,
      generated.kind === "listing"
        ? renderListingPage(generated, project)
        : renderContentRecord(generated, linkRewritesByRecord.get(generated.record.sourceId), media)
    );
  }

  for (const [relativePath, contents] of files) {
    await writeNewFile(outputDirectory, relativePath, contents);
  }
}

/** Raw href -> generated href, per content record. */
function createLinkRewriteMap(
  project: MigrationProject,
  enabled: boolean
): Map<string, Map<string, string>> {
  const byRecord = new Map<string, Map<string, string>>();
  if (!enabled) {
    return byRecord;
  }

  for (const reference of project.links.references) {
    const rewritten = reference.rewritten;
    if (reference.status !== "needs-rewrite" || rewritten === undefined || rewritten === reference.href) {
      continue;
    }

    const rewrites = byRecord.get(reference.sourceId) ?? new Map<string, string>();
    rewrites.set(reference.href, rewritten);
    byRecord.set(reference.sourceId, rewrites);
  }

  return byRecord;
}

function prepareRecords(project: MigrationProject): GeneratedRecord[] {
  const usedFileNames = new Set<string>();
  const usedRoutes = new Set<string>();
  const collections = collectionByType(project);

  return project.records.map((record) => {
    const collection = collections.get(record.type) ?? contentCollectionName(record.type);
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);

    if (usedRoutes.has(route)) {
      throw new Error(`Cannot generate duplicate route: ${route}`);
    }
    usedRoutes.add(route);

    const stem = safeFileStem(record.slug || record.sourceId);
    let fileName = `${stem}.md`;
    let suffix = 2;
    while (usedFileNames.has(`${collection}/${fileName}`)) {
      fileName = `${stem}-${suffix}.md`;
      suffix += 1;
    }
    usedFileNames.add(`${collection}/${fileName}`);

    return {
      kind: "content",
      record,
      collection,
      fileName,
      route,
      sourceUrl: sourceUrlFor(project, record, route)
    };
  });
}

/** The content collection each post type generates into, from the plan. */
function collectionByType(project: MigrationProject): ReadonlyMap<string, string> {
  return new Map(project.types.filter((entry) => entry.included).map((entry) => [entry.name, entry.collection]));
}

/** Every content collection the handoff writes, in a stable order. */
function generatedCollections(project: MigrationProject): readonly string[] {
  const names = project.types.filter((entry) => entry.included).map((entry) => entry.collection);
  const archives = project.archives.pages.length > 0 ? ["listings"] : [];
  return [...new Set([...names, ...archives])].sort();
}

/**
 * Archive pages become ordinary content entries, so the catch-all route, the
 * sitemap, the manifest and the delivery checks all treat them like any other
 * page instead of growing a second rendering path.
 */
function prepareListings(project: MigrationProject): GeneratedListing[] {
  const usedFileNames = new Set<string>();

  return project.archives.pages.map((archive) => {
    const route = normalizeRoute(archive.route);
    const stem = safeFileStem(route.replace(/^\/|\/$/g, "").replaceAll("/", "-") || "index");
    let fileName = `${stem}.md`;
    let suffix = 2;
    while (usedFileNames.has(fileName)) {
      fileName = `${stem}-${suffix}.md`;
      suffix += 1;
    }
    usedFileNames.add(fileName);

    return {
      kind: "listing",
      archive,
      collection: "listings",
      fileName,
      route,
      sourceUrl: archive.sourceUrl ?? route
    };
  });
}

/**
 * The delivery plan, indexed for rendering. Two lookups matter: the path the
 * source wrote, which is what markup carries, and the attachment id, which is
 * what widget settings carry when they never spelled out a URL.
 */
interface MediaRenderer {
  readonly byPath: ReadonlyMap<string, MediaDeliveryEntry>;
  readonly byAssetId: ReadonlyMap<string, MediaDeliveryEntry>;
  readonly assets: ReadonlyMap<string, MediaAsset>;
}

function createMediaRenderer(project: MigrationProject): MediaRenderer | undefined {
  const plan = project.media.delivery;
  if (plan === undefined) {
    return undefined;
  }

  const rank = { copied: 0, linked: 1, remote: 2, missing: 3 } as const;
  const byPath = new Map<string, MediaDeliveryEntry>();
  const byAssetId = new Map<string, MediaDeliveryEntry>();

  for (const entry of plan.entries) {
    byPath.set(entry.sourcePath, entry);
    if (entry.assetId !== undefined) {
      const existing = byAssetId.get(entry.assetId);
      if (existing === undefined || rank[entry.status] < rank[existing.status]) {
        byAssetId.set(entry.assetId, entry);
      }
    }
  }

  return {
    byPath,
    byAssetId,
    assets: new Map(project.media.assets.map((asset) => [asset.id, asset]))
  };
}

/** Where the generated markup should point for a source URL, when the plan says. */
function deliveredMediaUrl(
  value: string,
  media: MediaRenderer
): { readonly url: string; readonly entry: MediaDeliveryEntry } | undefined {
  const path = mediaPath(value);
  const entry = path === undefined ? undefined : media.byPath.get(path);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.status === "copied" && entry.outputPath !== undefined) {
    return { url: encodedMediaPath(entry.outputPath), entry };
  }
  if (entry.status === "linked" && entry.url !== undefined) {
    return { url: entry.url, entry };
  }

  // Remote and missing files keep the URL the source wrote: the plan says it
  // cannot serve them, and inventing a path would be worse than saying so.
  return undefined;
}

function encodedMediaPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** The same substitution for `srcset`, which carries one URL per candidate. */
function deliveredSrcset(value: string, media: MediaRenderer): string | undefined {
  if (/data:/i.test(value)) {
    // A data URI can contain a comma, so a candidate split would corrupt it.
    return undefined;
  }

  let changed = false;
  const candidates = value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const [url, ...descriptors] = trimmed.split(/\s+/);
    if (url === undefined) {
      return trimmed;
    }
    const target = deliveredMediaUrl(url, media);
    if (target === undefined) {
      return trimmed;
    }
    changed = true;
    return [target.url, ...descriptors].join(" ");
  });

  return changed ? candidates.join(", ") : undefined;
}

/** What an Elementor image widget points at: a URL, an attachment id, or both. */
function elementorMediaSource(node: MigrationNode): {
  readonly url?: string | undefined;
  readonly assetId?: string | undefined;
} {
  const value = node.attributes.image;
  if (typeof value === "string" && value.trim() !== "") {
    return { url: value.trim() };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const settings = value as Record<string, unknown>;
  const url = typeof settings.url === "string" && settings.url.trim() !== "" ? settings.url.trim() : undefined;
  const id = typeof settings.id === "number" ? `media:${settings.id}` : undefined;
  return {
    ...(url === undefined ? {} : { url }),
    ...(id === undefined ? {} : { assetId: id })
  };
}

/**
 * The target for one reference, preferring the path the source wrote and
 * falling back to the attachment when the settings carried only an id.
 */
function resolveMediaTarget(
  media: MediaRenderer,
  target: { readonly url?: string | undefined; readonly assetId?: string | undefined }
): { readonly url: string; readonly entry?: MediaDeliveryEntry | undefined } | undefined {
  if (target.url !== undefined) {
    const delivered = deliveredMediaUrl(target.url, media);
    if (delivered !== undefined) {
      return delivered;
    }
  }

  if (target.assetId !== undefined) {
    const entry = media.byAssetId.get(target.assetId);
    if (entry?.status === "copied" && entry.outputPath !== undefined) {
      return { url: encodedMediaPath(entry.outputPath), entry };
    }
    if (entry?.status === "linked" && entry.url !== undefined) {
      return { url: entry.url, entry };
    }
  }

  return target.url === undefined ? undefined : { url: target.url };
}

function renderPackageJson(project: MigrationProject): string {
  const packageName = `${safeFileStem(project.site.title)}-astro`;
  return renderJson({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "astro dev",
      build: "astro build",
      preview: "astro preview",
      // The reports are the artifact; wp-migrate-core verify is the gate, so
      // these runs only fail when the audit itself could not complete.
      "check:source":
        "ssrwire check --config migration/checks/ssrwire-source.yml --format json --output ssrwire-source.json --fail-on never",
      "check:preview":
        "ssrwire check --config migration/checks/ssrwire-preview.yml --format json --output ssrwire-preview.json --fail-on never"
    },
    dependencies: {
      astro: "^5.13.0"
    },
    devDependencies: {
      ssrwire: ssrwireDependency
    }
  });
}

/**
 * Astro resolves canonical URLs and sitemap entries against `site`, so the
 * source origin is carried over as the default. A migration that also moves
 * domains has to change this line and `public/sitemap.xml` together.
 */
function renderAstroConfig(project: MigrationProject): string {
  const site = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  return `import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  trailingSlash: "always"${site === undefined
    ? ""
    : `,
  // Carried over from the WordPress site. Change it if the new site answers elsewhere.
  site: ${JSON.stringify(site)}`}
});
`;
}

function renderTsConfig(): string {
  return renderJson({
    extends: "astro/tsconfigs/strict",
    include: [".astro/types.d.ts", "**/*"],
    exclude: ["dist"]
  });
}

function renderContentConfig(project: MigrationProject): string {
  const collections = generatedCollections(project)
    .map(
      (name) => `  ${JSON.stringify(name)}: defineCollection({
    loader: glob({ base: "./src/content/${name}", pattern: "**/*.{md,mdx}" }),
    schema: migrationSchema
  })`
    )
    .join(",\n");

  return `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const migrationSchema = z.object({
  title: z.string(),
  route: z.string(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  categories: z.array(z.string()).default([])
});

export const collections = {
${collections}
};
`;
}

function renderCatchAllPage(project: MigrationProject, publishReady: boolean): string {
  const collections = generatedCollections(project);
  const sources = collections.map((name) => `    ...(await getCollection(${JSON.stringify(name)}))`).join(",\n");
  const layoutProps = publishReady
    ? '\n  route={entry.data.route}'
    : "";

  return `---
import { getCollection, render } from "astro:content";
import Layout from "../layouts/Layout.astro";

export async function getStaticPaths() {
  const entries = [
${sources}
  ];

  return entries.map((entry) => ({
    params: {
      slug: entry.data.route === "/"
        ? undefined
        : entry.data.route.replace(/^\\/|\\/$/g, "")
    },
    props: { entry }
  }));
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---

<Layout
  title={entry.data.title}${layoutProps}
>
  <Content />
</Layout>
`;
}

function renderLayout(project: MigrationProject, publishReady: boolean): string {
  const hasNavigation = project.menus.trees.length > 0;
  const importLine = hasNavigation ? '\nimport Nav from "../components/Nav.astro";' : "";
  const navLine = hasNavigation ? "\n    <Nav />" : "";
  const robotsMeta = publishReady ? "" : '\n    <meta name="robots" content="noindex, nofollow" />';
  const canonical = publishReady
    ? `
const canonical = route === undefined || Astro.site === undefined
  ? undefined
  : new URL(route, Astro.site).toString();`
    : "";
  const canonicalTag = publishReady
    ? '\n    {canonical !== undefined && <link rel="canonical" href={canonical} />}'
    : "";
  const routeProp = publishReady ? "\n  route?: string;" : "";
  const propsLine = publishReady ? "const { title, route } = Astro.props;" : "const { title } = Astro.props;";

  return `---
import "../styles/global.css";${importLine}

interface Props {
  title: string;${routeProp}
}

${propsLine}${canonical}
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="generator" content={Astro.generator} />${robotsMeta}${canonicalTag}
    <title>{title}</title>
  </head>
  <body>${navLine}
    <main>
      <article>
        <slot />
      </article>
    </main>
  </body>
</html>
`;
}

function renderStyles(): string {
  return `:root {
  color: #171717;
  background: #f5f5f3;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body { margin: 0; }
main { width: min(920px, calc(100% - 2rem)); margin: 3rem auto; }
article {
  padding: clamp(1.25rem, 4vw, 3rem);
  background: white;
  border: 1px solid #deded8;
  border-radius: 0.75rem;
}
img { max-width: 100%; height: auto; }
.content-review {
  display: grid;
  gap: 0.35rem;
  margin: 0 0 1rem;
  padding: 1rem;
  border: 1px solid #b98a18;
  border-radius: 0.5rem;
  background: #fff8dc;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
}

/**
 * The private default asks crawlers to stay away. `--publish-ready` writes the
 * file a launch needs instead: crawling allowed, and the sitemap named when
 * the site URL is known.
 */
function renderRobotsTxt(project: MigrationProject, publishReady: boolean): string {
  if (!publishReady) {
    return "User-agent: *\nDisallow: /\n";
  }

  const origin = siteOrigin(project);
  return `User-agent: *\nAllow: /\n${origin === undefined ? "" : `\nSitemap: ${absoluteOnOrigin(origin, "/sitemap.xml")}\n`}`;
}

/**
 * A static sitemap of the routes this plan generates. It is written from the
 * plan rather than from a build, so it doubles as the target list another
 * checker can be pointed at while the site is still being rebuilt.
 */
function renderSitemap(pages: readonly GeneratedPage[], origin: string): string {
  const entries = pages.map((generated) => {
    const lastModified =
      generated.kind === "content" ? sitemapLastModified(generated.record.modifiedAt) : undefined;
    return `  <url>
    <loc>${escapeHtml(absoluteOnOrigin(origin, generated.route))}</loc>${lastModified === undefined
      ? ""
      : `\n    <lastmod>${lastModified}</lastmod>`}
  </url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

/**
 * modifiedAt may contain either a GMT or a local WordPress timestamp. Keep
 * the date without inventing a timezone, and omit unset or invalid dates.
 */
function sitemapLastModified(value: string | undefined): string | undefined {
  const date = /^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}:\d{2}$/.exec(value ?? "")?.[1];
  if (date === undefined || date.startsWith("0000-")) return undefined;
  const timestamp = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === date
    ? date : undefined;
}

/**
 * The navigation WordPress served, as a component the layout renders. The tree
 * is serialized as HTML because a menu can nest to any depth and Astro
 * templates cannot recurse; every label and href is escaped here.
 */
function renderNavComponent(project: MigrationProject): string {
  const html = project.menus.trees
    .map((menu) => `<nav aria-label="${escapeHtmlAttribute(menu.name)} navigation">\n${renderMenuList(menu.items)}\n</nav>`)
    .join("\n");

  return `---
const navigation = ${JSON.stringify(html)};
---

<div set:html={navigation} />
`;
}

function renderMenuList(items: readonly MenuItem[]): string {
  return `<ul>\n${items.map((item) => renderMenuItem(item)).join("\n")}\n</ul>`;
}

function renderMenuItem(item: MenuItem): string {
  const href = item.href ?? item.targetRoute ?? item.url;
  const label = escapeHtml(item.label);
  const target = href === undefined ? `<span>${label}</span>` : `<a href="${escapeHtmlAttribute(href)}">${label}</a>`;
  const children = item.children.length === 0 ? "" : `\n${renderMenuList(item.children)}`;
  return `  <li>${target}${children}</li>`;
}

/**
 * A listing page, written as a content entry: the title, a link to every
 * record it lists, and the page links when a listing is paginated.
 */
function renderListingPage(listing: GeneratedListing, project: MigrationProject): string {
  const { archive } = listing;
  const recordsById = new Map(project.records.map((record) => [record.sourceId, record]));
  const items = archive.sourceIds.flatMap((sourceId) => {
    const record = recordsById.get(sourceId);
    if (record === undefined) {
      return [];
    }
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    return [`  <li><a href="${escapeHtmlAttribute(route)}">${escapeHtml(record.title)}</a></li>`];
  });

  const siblings = project.archives.pages.filter((page) => page.subject === archive.subject);
  const paging =
    siblings.length <= 1
      ? ""
      : `\n<p class="listing-pages">${siblings
          .map((page, index) =>
            page.route === archive.route
              ? `<span>Page ${index + 1}</span>`
              : `<a href="${escapeHtmlAttribute(page.route)}">Page ${index + 1}</a>`
          )
          .join(" ")}</p>`;

  const frontmatter = [
    "---",
    `title: ${yamlString(archive.title)}`,
    `route: ${yamlString(listing.route)}`,
    "categories: []",
    "---"
  ].join("\n");
  const body = `<h1>${escapeHtml(archive.title)}</h1>\n<ul>\n${items.join("\n")}\n</ul>${paging}`;

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * A static RSS 2.0 feed. Items carry a publication date only when the export
 * recorded one in GMT, so this never asserts a timezone WordPress did not.
 */
function renderFeed(feed: FeedFile, project: MigrationProject, origin: string): string {
  const recordsById = new Map(project.records.map((record) => [record.sourceId, record]));
  const items = feed.sourceIds.flatMap((sourceId) => {
    const record = recordsById.get(sourceId);
    if (record === undefined) {
      return [];
    }
    const link = absoluteOnOrigin(origin, normalizeRoute(record.route ?? `/${record.slug}/`));
    const published = rssPublicationDate(record.publishedAtGmt);
    return [
      `    <item>
      <title>${escapeHtml(record.title)}</title>
      <link>${escapeHtml(link)}</link>
      <guid isPermaLink="true">${escapeHtml(link)}</guid>${published === undefined ? "" : `\n      <pubDate>${escapeHtml(published)}</pubDate>`}
    </item>`
    ];
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(feed.title)}</title>
    <link>${escapeHtml(origin)}</link>
    <description>${escapeHtml(feed.title)}</description>
${items.join("\n")}
  </channel>
</rss>
`;
}

/** A GMT timestamp from the export, in the form RSS expects. */
function rssPublicationDate(value: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value ?? "");
  if (match === null || match[1] === "0000") {
    return undefined;
  }
  const timestamp = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toUTCString() : undefined;
}

function renderManifest(project: MigrationProject, pages: readonly GeneratedPage[]): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  const records = pages.filter((page): page is GeneratedRecord => page.kind === "content");
  const listings = pages.filter((page): page is GeneratedListing => page.kind === "listing");
  return renderJson({
    schemaVersion: "0.9",
    generator: {
      name: GENERATOR_NAME,
      version: packageVersion,
      target: "astro"
    },
    sourceSite: {
      title: project.site.title,
      ...(siteUrl === undefined ? {} : { url: siteUrl })
    },
    summary: project.summary,
    targets: targetRecords(),
    media: {
      file: "migration/media.json",
      summary: project.media.summary,
      ...(project.media.delivery === undefined ? {} : { delivery: project.media.delivery.summary })
    },
    ...(project.config === undefined ? {} : { config: { applied: true, decisions: project.config.decisions } }),
    redirects: {
      file: "migration/redirects.json",
      summary: project.routes.summary
    },
    links: {
      file: "migration/links.json",
      summary: project.links.summary
    },
    coverage: {
      file: "migration/coverage.json",
      summary: project.coverage.summary
    },
    types: project.types.map((entry) => ({
      name: entry.name,
      label: entry.label,
      collection: entry.collection,
      sourceItems: entry.sourceItems,
      records: entry.records,
      included: entry.included,
      ...(entry.reason === undefined ? {} : { reason: entry.reason })
    })),
    archives: {
      file: "migration/archives.json",
      summary: project.archives.summary
    },
    menus: {
      file: "migration/menus.json",
      summary: project.menus.summary
    },
    records: records.map(({ record, collection, fileName, route, sourceUrl }) => ({
      sourceId: record.sourceId,
      wordpressId: record.wordpressId,
      postType: record.type,
      sourceEditor: record.editor,
      route,
      sourceUrl: sanitizeSourceUrl(sourceUrl) ?? route,
      outputFile: `src/content/${collection}/${fileName}`
    })),
    listings: listings.map(({ archive, collection, fileName, route, sourceUrl }) => ({
      archiveId: archive.id,
      kind: archive.kind,
      route,
      sourceUrl: sanitizeSourceUrl(sourceUrl) ?? route,
      outputFile: `src/content/${collection}/${fileName}`
    }))
  });
}

function renderReadme(project: MigrationProject, rewriteLinks: boolean): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  const hasRuleFiles = redirectRuleFiles(project).length > 0;
  const coverage = project.coverage.summary;
  const delivery = project.media.delivery;
  const checkTargets = Math.min(deliveryCheckTargets(project).length, deliveryCheckTargetLimit);
  return `# ${project.site.title} — Astro migration handoff

Generated from ${siteUrl ?? "a WordPress export"} by ${GENERATOR_NAME} ${packageVersion}.

This is a rough migration output, not a production-ready replacement. The generator preserves source content where it can and emits explicit repair markers where it cannot.

## Run locally

\`\`\`bash
npm install
npm run dev
\`\`\`

## Handoff sequence

1. Open \`migration/issues.json\` and resolve every blocker.
2. Work through \`migration/media.json\`.${delivery === undefined
    ? " Nothing was copied for you: import each referenced asset from the source site, then write its alternative text."
    : ` ${delivery.summary.copied} of ${delivery.summary.files} referenced ${delivery.summary.files === 1 ? "file was" : "files were"} copied into \`public/wp-content/uploads/\`, ${delivery.summary.linked} point at the media base URL, ${delivery.summary.remote} are left on the source site, and ${delivery.summary.missing} could not be found locally. Every file the source still serves has to come from somewhere before publishing, and alternative text still needs a human.`}
3. Publish the redirect rules on whatever hosts the new site.${hasRuleFiles
    ? " Files for Netlify, Vercel, nginx and Apache are in `migration/redirect-rules/`. Netlify slash-only changes rely on Pretty URLs and are recorded as comments. Apache requires mod_rewrite; encoded slashes also require AllowEncodedSlashes NoDecode in the server configuration."
    : " This plan needs no path rule, so no rule files were written."} Then decide what happens to the source URLs in \`migration/redirects.json\` that have no target.
4. Check \`migration/coverage.json\`.${coverage.checked
    ? ` The live URLs you supplied were compared with this plan: ${coverage.routed} served by a generated route, ${coverage.redirected} covered by a proposed rule, ${coverage.uncovered} with no route or rule. Add a route or a rule for every uncovered URL before publishing, and review excluded, unresolved and unreadable entries separately.`
    : " No live URL source was supplied, so no live URL was compared with this plan. Save the sitemap of the live site and run the scan again with `--live-urls sitemap.xml` to see which routes you would lose."}
5. Read \`migration/links.json\` and check every link this export could not vouch for, along with the proposed rewrites.
6. Review warnings and accepted legacy HTML instead of assuming conversion fidelity.
7. Compare every generated route with the original WordPress route on desktop and mobile.
8. ${checkTargets === 0
    ? "This export produced no routes, so no SSRWire check files were written. Fix the export before publishing anything from this handoff."
    : `Run \`npm run check:source\` while WordPress is still online, before moving DNS. Then run \`npm run build\`, start \`npm run preview\` in one terminal, and run \`npm run check:preview\` in another. Compare the saved reports:

   \`\`\`bash
   npx wp-migrate-core verify ../export.xml --html-dir dist \\
     --ssrwire-report ssrwire-preview.json --ssrwire-baseline ssrwire-source.json
   \`\`\`

   The files in \`migration/checks/\` use matching IDs for the WordPress and preview URLs. They check content metadata and social tags, and cover the first ${checkTargets} planned ${checkTargets === 1 ? "route" : "routes"}. Edit both files to cover more pages. SSRWire makes the requests; \`verify\` reads the saved reports and groups problems for review.`}
9. Replace forms, dynamic widgets, shortcodes and plugin behavior deliberately.
10. Run \`npm run build\` only after the repair queue is understood.

Generated content lives in \`src/content/pages\` and \`src/content/posts\`. Route mappings and source IDs live in \`migration/manifest.json\`; the media inventory is \`migration/media.json\`, the URL and redirect map is \`migration/redirects.json\`, the link inventory is \`migration/links.json\`, the live URL coverage check is \`migration/coverage.json\`, and the SSRWire check files are in \`migration/checks/\`.

This handoff asks crawlers to stay away: \`public/robots.txt\` disallows crawling and the layout sets \`noindex, nofollow\`. Remove both before publishing. \`wp-migrate-core verify\` flags the layout's indexing directive; it does not check \`robots.txt\`.${siteUrl === undefined
    ? " No sitemap was generated because the export carries no site URL; add one with the routes in `src/content/`."
    : ` \`public/sitemap.xml\` lists every generated route at ${siteUrl}. Change \`site\` in \`astro.config.mjs\` and that sitemap together if the new site answers on another origin.`}

${delivery === undefined
    ? "No media was downloaded, copied or rewritten: this run was not given a place for the files to come from, so every source image is a repair marker. Pass an uploads directory or a media base URL to convert the export again and have the generated pages carry real images."
    : `Media delivery read local files only: ${delivery.source === "uploads-directory" ? "the uploads directory you supplied" : "the media base URL you named"} decided each path, and nothing was fetched over the network. Resized variants the uploads directory does not carry are served by the original file they were made from. Files marked \`remote\` still point at the source site and files marked \`missing\` are listed as findings; confirm every one of them against the original page.`}

The coverage check compares the paths you supplied with the routes and rules in this plan. It requested nothing over the network, so it cannot tell you whether a live URL still returns a page or where it redirects today.

${rewriteLinks
    ? "Automatic link rewriting was enabled for this handoff. Supported same-site links use the generated routes."
    : "Automatic link rewriting was disabled for this handoff. Source links were kept; the inventory lists proposed rewrites that were not applied."}
The link inventory omits credentials and query strings; consult the original export for complete source URLs.

Astro is the only enabled renderer in this handoff. Next.js and Nuxt appear in the migration manifest as planned, disabled targets; this output contains no fake compatibility layer for either framework.
`;
}

function renderContentRecord(
  generated: GeneratedRecord,
  rewrites: ReadonlyMap<string, string> | undefined,
  media: MediaRenderer | undefined
): string {
  const { record, route } = generated;
  const frontmatter = [
    "---",
    `title: ${yamlString(record.title)}`,
    `route: ${yamlString(route)}`,
    ...(record.author ? [`author: ${yamlString(record.author)}`] : []),
    ...(record.publishedAt ? [`publishedAt: ${yamlString(record.publishedAt)}`] : []),
    `categories: ${JSON.stringify(
      record.terms.filter((term) => term.domain === "category").map((term) => term.name)
    )}`,
    "---"
  ].join("\n");

  const body = ensureTitleH1(rewriteInternalLinks(renderRecordBody(record, media), rewrites), record.title);
  return `${frontmatter}\n\n${body.trim()}\n`;
}

/**
 * Same-site links that resolve to a different generated route are rewritten to
 * that route directly, so the handoff does not depend on a redirect rule being
 * published. Everything else, including external links and anchors, is left
 * exactly as the export wrote it.
 */
function rewriteInternalLinks(html: string, rewrites: ReadonlyMap<string, string> | undefined): string {
  if (rewrites === undefined || rewrites.size === 0) {
    return html;
  }

  return html.replace(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const href = readHtmlAttribute(tag, "href");
    if (href === undefined) {
      return tag;
    }

    const rewritten = rewrites.get(href);
    return rewritten === undefined || rewritten === href
      ? tag
      : replaceHtmlAttribute(tag, "href", rewritten);
  });
}

function replaceHtmlAttribute(tag: string, name: string, value: string): string {
  const pattern = /((?:^|\s)([^\s"'<>/=]+)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;
  const escaped = escapeHtmlAttribute(value);
  let replaced = false;
  return tag.replace(pattern, (match, prefix: string, attribute: string) => {
    if (replaced || attribute.toLowerCase() !== name.toLowerCase()) return match;
    replaced = true;
    return `${prefix}"${escaped}"`;
  });
}

function renderRecordBody(record: ContentRecord, media: MediaRenderer | undefined): string {
  if (record.rawContent.trim().length > 0) {
    const content = renderSafeRawHtml(record.rawContent, media);
    if (content === undefined) {
      return renderUnsafeMarkupRepair();
    }
    return record.issues.some((issue) => issue.code === "SHORTCODE_UNSUPPORTED")
      ? replaceUnsupportedShortcodes(content)
      : content;
  }

  const renderedNodes = record.nodes
    .map((node) => renderNode(node, media))
    .filter(Boolean)
    .join("\n\n");
  if (renderedNodes.length > 0) {
    return renderedNodes;
  }

  return renderRepairMarker("No renderable content was exported for this record.");
}

function renderNode(node: MigrationNode, media: MediaRenderer | undefined): string {
  if (node.rawHtml?.trim()) {
    return renderSafeRawHtml(node.rawHtml, media) ?? renderUnsafeMarkupRepair();
  }

  if (
    node.source === "elementor" &&
    (node.conversion === "native" || node.conversion === "legacy-html" || node.sourceType === "image")
  ) {
    const native = renderNativeElementorNode(node, media);
    if (native !== undefined) {
      return native;
    }
  }

  const children = node.children
    .map((child) => renderNode(child, media))
    .filter(Boolean)
    .join("\n");

  if (node.conversion === "manual" || node.conversion === "blocked") {
    const marker = renderRepairMarker(repairMessageForNode(node));
    return children ? `${marker}\n${children}` : marker;
  }

  if (children) {
    return children;
  }

  return renderRepairMarker(repairMessageForNode(node));
}

function renderNativeElementorNode(
  node: MigrationNode,
  media: MediaRenderer | undefined
): string | undefined {
  const children = node.children
    .map((child) => renderNode(child, media))
    .filter(Boolean)
    .join("\n");

  switch (node.sourceType) {
    case "container":
    case "section":
      return `<section>\n${children}\n</section>`;
    case "column":
      return `<div>\n${children}\n</div>`;
    case "heading": {
      const title = getString(node.attributes, "title");
      const requestedLevel = getString(node.attributes, "header_size");
      const level = /^h[1-6]$/.test(requestedLevel ?? "") ? requestedLevel : "h2";
      return title ? `<${level}>${escapeHtml(title)}</${level}>` : undefined;
    }
    case "text-editor": {
      const content = getString(node.attributes, "editor");
      return content === undefined ? undefined : renderSafeRawHtml(content, media) ?? renderUnsafeMarkupRepair();
    }
    case "button": {
      const text = getString(node.attributes, "text");
      const href = getNestedString(node.attributes, "link", "url");
      const safeHref = href === undefined ? undefined : safeHrefForElementorButton(href);
      return text && safeHref !== undefined
        ? `<p><a href="${escapeHtmlAttribute(safeHref)}">${escapeHtml(text)}</a></p>`
        : renderRepairMarker("This link needs review before publication.");
    }
    case "image": {
      if (media === undefined) {
        // Without a delivery plan the marker stays: nothing in this run found
        // a local file, so the handoff must not pretend the image is there.
        return renderRepairMarker("This image needs to be added from a verified local asset before publication.");
      }
      const target = resolveMediaTarget(media, elementorMediaSource(node));
      return target === undefined || hasUnsafeRawMarkup(`<img src="${escapeHtmlAttribute(target.url)}">`)
        ? renderRepairMarker("This image needs to be added from a verified local asset before publication.")
        : `<img src="${escapeHtmlAttribute(target.url)}"${imageAttributes(
            target.entry,
            media
          )} loading="lazy" decoding="async" />`;
    }
    case "divider":
      return "<hr />";
    case "spacer":
      return '<div aria-hidden="true"></div>';
    default:
      return undefined;
  }
}

function renderRepairMarker(message: string): string {
  return `<aside class="content-review">
  <strong>Content review required</strong>
  <span>${escapeHtml(message)}</span>
</aside>`;
}

function renderUnsafeMarkupRepair(): string {
  return renderRepairMarker("This part of the page was withheld pending review.");
}

function repairMessageForNode(node: MigrationNode): string {
  if (node.source === "elementor" && node.sourceType === "image") {
    return "This image needs to be added from a verified local asset before publication.";
  }
  if (node.source === "elementor" && node.sourceType === "button") {
    return "This link needs review before publication.";
  }
  return "This part of the page needs review before publication.";
}

function ensureTitleH1(body: string, title: string): string {
  if (hasH1(body)) {
    return body;
  }

  const heading = title.trim() || "Untitled page";
  return `<h1>${escapeHtml(heading)}</h1>\n\n${body}`;
}

function hasH1(value: string): boolean {
  return (
    /<\s*h1(?:\s|\/?>)/i.test(value) ||
    /^(?: {0,3})#(?!#)\s+\S/m.test(value) ||
    /^(?: {0,3})\S[^\n]*\n(?: {0,3})={3,}\s*$/m.test(value)
  );
}

function renderSafeRawHtml(value: string, media: MediaRenderer | undefined): string | undefined {
  return hasUnsafeRawMarkup(value) ? undefined : renderSourceMedia(value, media);
}

/**
 * Source imagery, resolved through the delivery plan.
 *
 * Without a plan, every `img` and `source` becomes a repair marker, which is
 * what 0.6 wrote: nothing was copied, so nothing may be promised. With a plan,
 * a tag whose file the plan delivers is rewritten to the path the new site
 * serves, a tag the plan leaves remote keeps the source URL, and a tag the plan
 * could not find a file for keeps the source URL too: the finding in
 * `migration/media.json` is what tells the reviewer, not a blank space in the
 * middle of the page.
 */
function renderSourceMedia(value: string, media: MediaRenderer | undefined): string {
  if (media === undefined) {
    return value.replace(
      /<(?:img|source)\b[^>]*>/gi,
      () =>
        renderRepairMarker(
          "This source media needs to be added as a verified local asset before publication: run convert again with --uploads pointing at your media library, or --media-base at the host that already serves it."
        )
    );
  }

  return value
    .replace(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
      const href = readHtmlAttribute(tag, "href");
      const target = href === undefined ? undefined : deliveredMediaUrl(href, media);
      return target === undefined ? tag : replaceHtmlAttribute(tag, "href", target.url + (href?.match(/[?#].*$/)?.[0] ?? ""));
    })
    .replace(/<(?:img|source)\b[^>]*>/gi, (tag) => renderMediaTag(tag, media));
}

function renderMediaTag(tag: string, media: MediaRenderer): string {
  const source = readHtmlAttribute(tag, "src");
  const target = source === undefined ? undefined : deliveredMediaUrl(source, media);
  let rendered = tag;

  if (target !== undefined) {
    rendered = replaceHtmlAttribute(rendered, "src", target.url);
  }

  const srcset = readHtmlAttribute(rendered, "srcset");
  if (srcset !== undefined) {
    const delivered = deliveredSrcset(srcset, media);
    if (delivered !== undefined) {
      rendered = replaceHtmlAttribute(rendered, "srcset", delivered);
    }
  }

  const entry = target?.entry ?? (source === undefined ? undefined : media.byPath.get(mediaPath(source) ?? ""));
  return /^<img\b/i.test(tag) ? augmentImage(rendered, entry, media) : rendered;
}

/**
 * Alt text and dimensions the export carries but the source markup left out.
 * An `alt=""` already in the markup is a decision about a decorative image, so
 * an existing attribute is never overwritten, and markup the source wrote is
 * otherwise left exactly as it was.
 */
function augmentImage(
  tag: string,
  entry: MediaDeliveryEntry | undefined,
  media: MediaRenderer
): string {
  const asset = entry?.assetId === undefined ? undefined : media.assets.get(entry.assetId);
  if (asset === undefined) {
    return tag;
  }

  let described = tag;
  if (
    !/\s+alt(?:\s*=|[\s/>])/i.test(described) &&
    asset.altText !== undefined &&
    asset.altText.trim() !== ""
  ) {
    described = addHtmlAttribute(described, "alt", asset.altText);
  }
  if (readHtmlAttribute(described, "width") === undefined && asset.width !== undefined) {
    described = addHtmlAttribute(described, "width", String(asset.width));
  }
  if (readHtmlAttribute(described, "height") === undefined && asset.height !== undefined) {
    described = addHtmlAttribute(described, "height", String(asset.height));
  }

  return described;
}

/** The attributes for an image this generator writes itself, rather than copies. */
function imageAttributes(entry: MediaDeliveryEntry | undefined, media: MediaRenderer): string {
  const asset = entry?.assetId === undefined ? undefined : media.assets.get(entry.assetId);
  const attributes: string[] = [];
  if (asset?.altText !== undefined && asset.altText.trim() !== "") {
    attributes.push(` alt="${escapeHtmlAttribute(asset.altText)}"`);
  }
  if (asset?.width !== undefined) {
    attributes.push(` width="${asset.width}"`);
  }
  if (asset?.height !== undefined) {
    attributes.push(` height="${asset.height}"`);
  }
  return attributes.join("");
}

/** Add an attribute the markup is missing, keeping the tag's own ending. */
function addHtmlAttribute(tag: string, name: string, value: string): string {
  const attribute = ` ${name}="${escapeHtmlAttribute(value)}"`;
  const trimmed = tag.trimEnd();
  if (trimmed.endsWith("/>")) {
    return `${trimmed.slice(0, -2)}${attribute} />`;
  }
  return trimmed.endsWith(">") ? `${trimmed.slice(0, -1)}${attribute}>` : `${trimmed}${attribute}`;
}

function replaceUnsupportedShortcodes(value: string): string {
  return value
    .replace(
      /\[(?!\/)([a-z][a-z0-9_-]*)(?:\s[^\]]*)?\]/gi,
      (_match, shortcode: string) =>
        renderRepairMarker(`Shortcode [${shortcode}] needs a deliberate replacement before publication.`)
    )
    .replace(/\[\/[a-z][a-z0-9_-]*\]/gi, "");
}

function hasUnsafeRawMarkup(value: string): boolean {
  const decoded = decodeHtmlEntitiesForSafety(value);

  return (
    /<\s*\/?\s*(?:applet|base|embed|form|iframe|input|link|math|meta|object|script|select|style|svg|textarea)\b/i.test(decoded) ||
    /\bon[a-z0-9:_-]+\s*=/i.test(decoded) ||
    /\b(?:href|src|srcset|action|formaction|poster|xlink:href)\s*=\s*["']?\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:/i.test(decoded) ||
    /\bstyle\s*=\s*[^>]*(?:expression\s*\(|url\s*\(\s*["']?\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:)/i.test(decoded) ||
    /\[[^\]]*\]\s*\(\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:/i.test(decoded)
  );
}

function safeHrefForElementorButton(value: string): string | undefined {
  const href = value.trim();
  if (href === "" || /[\u0000-\u001f\u007f-\u009f]/.test(href)) {
    return undefined;
  }

  const decodedHref = decodeHtmlEntitiesForSafety(href).trim();
  if (decodedHref === "" || /[\u0000-\u001f\u007f-\u009f]/.test(decodedHref)) {
    return undefined;
  }
  const normalized = decodedHref.replace(/\s+/g, "");
  if (normalized.startsWith("//") || normalized.startsWith("\\")) {
    return undefined;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return scheme === undefined || SAFE_ELEMENTOR_HREF_SCHEMES.has(scheme) ? decodedHref : undefined;
}

function decodeHtmlEntitiesForSafety(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded
      .replace(/&colon;/gi, ":")
      .replace(/&newline;/gi, "\n")
      .replace(/&tab;/gi, "\t")
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hexadecimal: string) =>
        decodeHtmlCodePoint(hexadecimal, 16)
      )
      .replace(/&#([0-9]+);?/g, (_match, decimal: string) => decodeHtmlCodePoint(decimal, 10))
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");

    if (next === decoded) {
      return next;
    }
    decoded = next;
  }
  return decoded;
}

function decodeHtmlCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : "\ufffd";
}

function getString(values: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedString(
  values: Readonly<Record<string, unknown>>,
  key: string,
  nestedKey: string
): string | undefined {
  const value = values[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nested = Reflect.get(value, nestedKey);
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sourceUrlFor(project: MigrationProject, record: ContentRecord, route: string): string {
  const candidate = project.routes.entries.find((entry) => entry.sourceId === record.sourceId)?.sourceUrl
    ?? record.route ?? route;
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  const origin = project.source.url ?? project.site.url;
  if (origin !== undefined) {
    try {
      return new URL(candidate, ensureTrailingSlash(origin)).toString();
    } catch {
      // Preserve the route below; malformed source URLs belong in the repair report.
    }
  }
  return candidate;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
