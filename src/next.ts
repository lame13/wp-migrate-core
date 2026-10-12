import {
  renderArchivesArtifact,
  renderCoverageArtifact,
  renderIssuesArtifact,
  renderLinksArtifact,
  renderMediaArtifact,
  renderMenusArtifact,
  renderRedirectsArtifact
} from "./artifacts.js";
import { artifactSchemaVersions } from "./contracts.js";
import { deliveryCheckFiles, deliveryCheckTargetLimit, deliveryCheckTargets, siteOrigin } from "./delivery.js";
import {
  createLinkRewriteMap,
  createMediaRenderer,
  ensureTitleH1,
  prepareListings,
  prepareRecords,
  renderFeed,
  renderListingBody,
  renderMenuList,
  renderRecordBody,
  renderRobotsTxt,
  renderSitemap,
  renderStyles,
  rewriteInternalLinks,
  sourceUrlFor
} from "./generate.js";
import type { GeneratedListing, GeneratedPage, GeneratedRecord, MediaRenderer } from "./generate.js";
import { deliverMedia } from "./media.js";
import { redirectRuleFiles } from "./redirect-rules.js";
import { prepareOutputDirectory, renderJson, safeFileStem, writeNewFile } from "./render.js";
import { targetDefinitions, targetRecords } from "./targets.js";
import {
  nextDependency,
  packageVersion,
  reactDependency,
  reactDomDependency,
  ssrwireDependency
} from "./version.js";
import type { MigrationProject } from "./types.js";

/**
 * The Next.js destination.
 *
 * The third static renderer, and the first destination written against the
 * public boundary rather than inside `src/generate.ts`: it shares the page
 * model, the body renderer, the media renderer, the navigation, the sitemap,
 * the feed writer and every migration artifact with the Astro handoff, and it
 * decides only what files a Next app is made of.
 *
 * One documented structure is supported: the App Router, no database, no
 * server, and `output: "export"`. That choice is deliberate — a static export
 * writes one HTML file per route into `out/`, which is the directory
 * `wp-migrate-core verify --html-dir out` reads, so the handoff can be checked
 * with the same gate as every other destination. It also means Next cannot
 * serve a redirect itself (`redirects()` is not allowed with a static export),
 * so the redirect map is published as host rules in `migration/redirect-rules/`
 * exactly as it is for Astro.
 *
 * Content is written as JSON with the exported HTML already cleaned, escaped
 * and rewritten — the same HTML the Astro handoff writes into its content
 * entries. Nothing is rendered twice from two different code paths, and no
 * Markdown or MDX dependency is needed to boot the project.
 */

export interface NextGenerateOptions {
  /** Rewrite same-site links so generated content points at its own routes. Defaults to true. */
  readonly rewriteLinks?: boolean;
  /** Write a site ready to be indexed: canonical URLs, no noindex, crawling allowed. */
  readonly publishReady?: boolean;
}

/** The page file the Next app reads for one planned route. */
interface GeneratedPageFile {
  readonly kind: "content" | "listing";
  readonly title: string;
  readonly route: string;
  readonly sourceUrl: string;
  readonly html: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly categories?: readonly string[];
}

export async function generateNextProject(
  project: MigrationProject,
  outDir: string,
  options: NextGenerateOptions = {}
): Promise<void> {
  const outputDirectory = await prepareOutputDirectory(outDir);
  const pages: readonly GeneratedPage[] = [...prepareRecords(project), ...prepareListings(project)];
  const routes = new Set<string>();
  for (const page of pages) {
    if (routes.has(page.route)) throw new Error(`Cannot generate duplicate route: ${page.route}`);
    routes.add(page.route);
  }

  const rewrite = options.rewriteLinks !== false;
  const linkRewritesByRecord = createLinkRewriteMap(project, rewrite);
  const media = createMediaRenderer(project);
  const origin = siteOrigin(project);
  const publishReady = options.publishReady === true;

  if (project.media.delivery !== undefined) {
    // Every copied file lands in `public/`, so the source upload paths keep
    // serving from the static export the way they did from WordPress.
    await deliverMedia(project.media.delivery, outputDirectory);
  }

  const pageFiles = new Map<string, string>();
  const routeIndex: { readonly route: string; readonly file: string }[] = [];
  for (const page of pages) {
    const file = `content/${page.collection}/${page.fileName.replace(/\.md$/, ".json")}`;
    pageFiles.set(file, renderJson(pageFileFor(page, project, linkRewritesByRecord, media)));
    routeIndex.push({ route: page.route, file });
  }

  const files = new Map<string, string>([
    ["package.json", renderPackageJson(project)],
    ["next.config.mjs", renderNextConfig()],
    ["tsconfig.json", renderTsConfig()],
    ["next-env.d.ts", renderNextEnvTypes()],
    [".gitignore", renderGitignore()],
    ["app/layout.tsx", renderLayout(project, publishReady)],
    ["app/globals.css", renderStyles()],
    ["app/page.tsx", renderHomePage()],
    ["app/[...segments]/page.tsx", renderCatchAllPage()],
    ["lib/content.ts", renderContentLibrary(origin)],
    ["content/routes.json", renderRouteIndex(origin, routeIndex)],
    ["public/robots.txt", renderRobotsTxt(project, publishReady)],
    ["migration/issues.json", renderIssuesArtifact(project.issues)],
    ["migration/media.json", renderMediaArtifact(project, "next")],
    ["migration/redirects.json", renderRedirectsArtifact(project, "next")],
    ["migration/links.json", renderLinksArtifact(project, "next")],
    ["migration/coverage.json", renderCoverageArtifact(project, "next")],
    ["migration/archives.json", renderArchivesArtifact(project, "next")],
    ["migration/menus.json", renderMenusArtifact(project, "next")],
    ["migration/manifest.json", renderManifest(project, pages, routeIndex)],
    ["README.md", renderReadme(project, rewrite, publishReady)]
  ]);

  if (project.menus.trees.length > 0) {
    files.set("components/Nav.tsx", renderNavComponent(project));
  }

  if (origin !== undefined) {
    files.set("public/sitemap.xml", renderSitemap(pages, origin));
  }

  for (const feed of project.archives.feeds) {
    if (origin === undefined) continue;
    const path = `public${feed.path}`;
    if (files.has(path)) throw new Error(`Cannot overwrite generated file with a feed: ${feed.path}`);
    files.set(path, renderFeed(feed, project, origin));
  }

  for (const ruleFile of redirectRuleFiles(project)) {
    files.set(ruleFile.path, ruleFile.contents);
  }

  for (const checkFile of deliveryCheckFiles(project, {
    previewOrigin: targetDefinitions.next.previewOrigin,
    previewCommand: targetDefinitions.next.previewCommand
  })) {
    files.set(checkFile.path, checkFile.contents);
  }

  for (const [relativePath, contents] of pageFiles) {
    files.set(relativePath, contents);
  }

  for (const [relativePath, contents] of files) {
    await writeNewFile(outputDirectory, relativePath, contents);
  }
}

function pageFileFor(
  page: GeneratedPage,
  project: MigrationProject,
  rewrites: ReadonlyMap<string, Map<string, string>>,
  media: MediaRenderer | undefined
): GeneratedPageFile {
  if (page.kind === "listing") {
    return {
      kind: "listing",
      title: page.archive.title,
      route: page.route,
      sourceUrl: page.sourceUrl,
      html: renderListingBody(page, project)
    };
  }

  const { record } = page;
  const author = record.author;
  const publishedAt = record.publishedAt;
  const categories = record.terms.filter((term) => term.domain === "category").map((term) => term.name);
  return {
    kind: "content",
    title: record.title,
    route: page.route,
    sourceUrl: page.sourceUrl,
    html: ensureTitleH1(rewriteInternalLinks(renderRecordBody(record, media), rewrites.get(record.sourceId)), record.title),
    ...(author === undefined || author === "" ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(categories.length === 0 ? {} : { categories })
  };
}

/**
 * The route index the app reads. It carries the site origin too, so a page
 * component can write a canonical URL without asking the plan again, and the
 * build stays a pure function of the files in `content/`.
 */
function renderRouteIndex(
  origin: string | undefined,
  routeIndex: readonly { readonly route: string; readonly file: string }[]
): string {
  return renderJson({
    schemaVersion: artifactSchemaVersions.nextRoutes,
    ...(origin === undefined ? {} : { siteUrl: origin }),
    routes: routeIndex
  });
}

function renderPackageJson(project: MigrationProject): string {
  return renderJson({
    name: `${safeFileStem(project.site.title)}-next`,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "next dev",
      build: "next build",
      // The static export is the deliverable: out/ is what you host and what
      // `verify --html-dir out` reads. There is no `next start` for an export.
      "check:source": "ssrwire check --config migration/checks/ssrwire-source.yml --format json --output ssrwire-source.json --fail-on never",
      "check:preview": "ssrwire check --config migration/checks/ssrwire-preview.yml --format json --output ssrwire-preview.json --fail-on never",
      typecheck: "tsc --noEmit"
    },
    dependencies: {
      next: nextDependency,
      react: reactDependency,
      "react-dom": reactDomDependency
    },
    devDependencies: {
      "@types/node": "^24.0.0",
      "@types/react": "^19.2.0",
      "@types/react-dom": "^19.2.0",
      ssrwire: ssrwireDependency,
      typescript: "^5.9.0"
    }
  });
}

/**
 * A static export on purpose. `output: "export"` writes one HTML file per
 * prerendered route into `out/`, and Next refuses `redirects()` alongside it,
 * which is why the redirect map ships as host rules instead.
 */
function renderNextConfig(): string {
  return `/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  // The handoff carries the files WordPress served; there is no image server
  // to optimise them, and a static export has no runtime to do it at.
  images: { unoptimized: true }
};

export default nextConfig;
`;
}

function renderTsConfig(): string {
  return renderJson({
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }]
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules", "out"]
  });
}

function renderNextEnvTypes(): string {
  return `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`;
}

function renderGitignore(): string {
  return `node_modules/
.next/
out/
next-env.d.ts
ssrwire-source.json
ssrwire-preview.json
`;
}

/**
 * The app shell. The noindex default and the canonical URL behave exactly as
 * they do in the Astro handoff, so `verify` reads the same evidence from
 * either build.
 */
function renderLayout(project: MigrationProject, publishReady: boolean): string {
  const hasNavigation = project.menus.trees.length > 0;
  const navImport = hasNavigation ? '\nimport Nav from "../components/Nav";' : "";
  const navLine = hasNavigation ? "\n        <Nav />" : "";
  const robots = publishReady ? "" : "\n  robots: { index: false, follow: false },";

  return `import type { Metadata } from "next";
import type { ReactNode } from "react";${navImport}
import "./globals.css";

export const metadata: Metadata = {
  title: ${JSON.stringify(project.site.title)},
  other: { generator: "wp-migrate-core ${packageVersion}" },${robots}
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>${navLine}
        <main>
          <article>{children}</article>
        </main>
      </body>
    </html>
  );
}
`;
}

function renderHomePage(): string {
  return `import type { Metadata } from "next";
import { metadataFor, pageForRoute } from "../lib/content";

export function generateMetadata(): Metadata {
  return metadataFor("/");
}

export default function HomePage() {
  const page = pageForRoute("/");
  if (page === undefined) {
    // Nothing was invented for the site root. The repair queue says why.
    return <p>This handoff did not generate a page for the site root.</p>;
  }

  return <div dangerouslySetInnerHTML={{ __html: page.html }} />;
}
`;
}

function renderCatchAllPage(): string {
  return `import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { metadataFor, pageForRoute, routes } from "../../lib/content";

// Every route in the plan is prerendered by generateStaticParams, and the
// static export refuses anything else, so an unplanned path is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return routes()
    .filter((route) => route !== "/")
    .map((route) => ({ segments: route.replace(/^\\/|\\/$/g, "").split("/") }));
}

function routeFor(segments: readonly string[]): string {
  return "/" + segments.join("/") + "/";
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ segments: string[] }>;
}): Promise<Metadata> {
  const { segments } = await params;
  return metadataFor(routeFor(segments));
}

export default async function GeneratedPage({ params }: { params: Promise<{ segments: string[] }> }) {
  const { segments } = await params;
  const page = pageForRoute(routeFor(segments));
  if (page === undefined) notFound();

  return <div dangerouslySetInnerHTML={{ __html: page.html }} />;
}
`;
}

/**
 * The content loader. It reads the plan the tool wrote — a route index and one
 * JSON file per page — at build time, so the app needs no database, no network
 * and no second parser to render what the migration decided.
 */
function renderContentLibrary(origin: string | undefined): string {
  const canonical = origin === undefined ? "" : `\n    alternates: { canonical: new URL(page.route, siteUrl).toString() },`;

  return `import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";

export interface GeneratedPage {
  readonly kind: "content" | "listing";
  readonly title: string;
  readonly route: string;
  readonly sourceUrl: string;
  readonly html: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly categories?: readonly string[];
}

interface RouteIndex {
  readonly schemaVersion: string;
  readonly siteUrl?: string;
  readonly routes: readonly { readonly route: string; readonly file: string }[];
}

const root = process.cwd();
const index = JSON.parse(readFileSync(join(root, "content", "routes.json"), "utf8")) as RouteIndex;

export const siteUrl = index.siteUrl;

const pages = new Map<string, GeneratedPage>(
  index.routes.map((entry) => [entry.route, readPage(entry.file)])
);

function readPage(file: string): GeneratedPage {
  return JSON.parse(readFileSync(join(root, file), "utf8")) as GeneratedPage;
}

export function routes(): readonly string[] {
  return index.routes.map((entry) => entry.route);
}

export function pageForRoute(route: string): GeneratedPage | undefined {
  return pages.get(route);
}

export function metadataFor(route: string): Metadata {
  const page = pageForRoute(route);
  if (page === undefined) return {};

  return {
    title: page.title,${canonical}
  };
}
`;
}

/**
 * The navigation WordPress served. The tree is serialized as HTML because it
 * can nest to any depth; every label and href is escaped by the shared menu
 * renderer, so the Next handoff draws the same menu as the Astro one.
 */
function renderNavComponent(project: MigrationProject): string {
  const html = project.menus.trees
    .map((menu) => `<nav aria-label="${menu.name.replaceAll('"', "&quot;")} navigation">\n${renderMenuList(menu.items)}\n</nav>`)
    .join("\n");

  return `const navigation = ${JSON.stringify(html)};

export default function Nav() {
  return <div dangerouslySetInnerHTML={{ __html: navigation }} />;
}
`;
}

function renderManifest(
  project: MigrationProject,
  pages: readonly GeneratedPage[],
  routeIndex: readonly { readonly route: string; readonly file: string }[]
): string {
  const siteUrl = project.site.url === undefined ? undefined : project.site.url;
  const records = pages.filter((page): page is GeneratedRecord => page.kind === "content");
  const listings = pages.filter((page): page is GeneratedListing => page.kind === "listing");
  const fileByRoute = new Map(routeIndex.map((entry) => [entry.route, entry.file]));
  return renderJson({
    schemaVersion: artifactSchemaVersions.manifestNext,
    generator: {
      name: "wp-migrate-core",
      version: packageVersion,
      target: "next"
    },
    sourceSite: {
      title: project.site.title,
      ...(siteUrl === undefined ? {} : { url: siteUrl })
    },
    summary: project.summary,
    targets: targetRecords(),
    destination: {
      target: "next",
      kind: "static-site",
      structure: "next-app-router",
      output: "export",
      build: "next build",
      buildDirectory: "out",
      contentDirectory: "content",
      routesIndex: "content/routes.json",
      app: "app/"
    },
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
    records: records.map(({ record, collection, route, sourceUrl }) => ({
      sourceId: record.sourceId,
      wordpressId: record.wordpressId,
      postType: record.type,
      sourceEditor: record.editor,
      route,
      sourceUrl: sourceUrlFor(project, record, route),
      outputFile: fileByRoute.get(route) ?? `content/${collection}/`
    })),
    listings: listings.map(({ archive, route, sourceUrl }) => ({
      archiveId: archive.id,
      kind: archive.kind,
      route,
      sourceUrl,
      outputFile: fileByRoute.get(route) ?? "content/listings/"
    }))
  });
}

function renderReadme(project: MigrationProject, rewrite: boolean, publishReady: boolean): string {
  const origin = project.site.url === undefined ? "" : siteOrigin(project) ?? "";
  const checkTargets = Math.min(deliveryCheckTargets(project, { previewOrigin: targetDefinitions.next.previewOrigin }).length, deliveryCheckTargetLimit);

  return `# ${project.site.title} — Next.js handoff

Generated by wp-migrate-core ${packageVersion} from a WordPress export. This is a
static-export Next.js app: \`next build\` prerenders every route into \`out/\`,
which is what you host and what \`wp-migrate-core verify\` reads.

## Run it

\`\`\`bash
npm install
npm run dev        # http://localhost:3000
npm run build      # writes the static site to out/
\`\`\`

## Check it

\`\`\`bash
# The build is the evidence: content, media, links, canonical, robots, sitemap.
npx wp-migrate-core verify ../export.xml --html-dir out${origin === "" ? "" : ` --out migration-verification.json`}

# Response, metadata and crawler delivery, on the site you are leaving and on
# the one you built. ${checkTargets} route${checkTargets === 1 ? "" : "s"} are listed.
npm run check:source
npm run check:preview
\`\`\`

## What is in here

| Path | What it is |
| --- | --- |
| \`app/\` | The App Router shell: layout, home page and one catch-all that renders every planned route. |
| \`content/\` | One JSON file per page plus \`routes.json\`, the index the app reads. |
| \`lib/content.ts\` | The loader. It reads \`content/\` at build time; there is no database and no network. |
| \`components/Nav.tsx\` | The menu WordPress served${project.menus.trees.length === 0 ? " (none was in this export)." : "."} |
| \`migration/\` | The repair queue, media, URL, link and coverage inventories, the manifest, the redirect rules and the SSRWire checks. |

## Before you publish

${publishReady
    ? "This handoff was written ready to be indexed: canonical URLs are set, no page asks crawlers to stay away and `robots.txt` allows crawling."
    : "This handoff deliberately asks crawlers to stay away: every page carries `noindex, nofollow` and `robots.txt` disallows everything. Re-run `convert` with `--publish-ready` when you are ready to be indexed."}

${rewrite
    ? "Supported same-site links were rewritten to the generated routes."
    : "Source links were kept as the export wrote them; `migration/links.json` lists the rewrites that were not applied."}

Redirects are **not** served by this app: a static export cannot run Next's
\`redirects()\`. Publish \`migration/redirect-rules/\` in the format your host
expects (Netlify, Vercel, nginx or Apache) instead.

Review the repair queue in \`migration/report.html\` before you consider the
migration finished. The theme, the forms and the plugin behaviour are yours to
rebuild; this handoff carries the content, the media and the decisions.
`;
}
