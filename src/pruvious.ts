import {
  renderArchivesArtifact,
  renderCoverageArtifact,
  renderIssuesArtifact,
  renderLinksArtifact,
  renderMediaArtifact,
  renderMenusArtifact,
  renderRedirectsArtifact
} from "./artifacts.js";
import { contentCollectionName, linkRewrites, mediaPath, normalizeRoute, readHtmlAttribute, sanitizeSourceUrl } from "./core.js";
import { artifactSchemaVersions } from "./contracts.js";
import { deliverMedia, rewriteDeliveredMedia } from "./media.js";
import { recordBodyHtml } from "./payload.js";
import { redirectRuleFiles } from "./redirect-rules.js";
import { prepareOutputDirectory, renderJson, safeFileStem, writeNewFile } from "./render.js";
import { targetRecords } from "./targets.js";
import { packageVersion, pruviousDependency, pruviousEditorDependencies, pruviousNuxtDependency } from "./version.js";
import type { ContentRecord, MenuItem, MenuTree, MigrationProject, WordPressTerm } from "./types.js";

/**
 * The Pruvious destination.
 *
 * The second CMS destination, and the second proof of the destination
 * boundary: it reuses the same migration model, the same drop shape and the
 * same review artifacts as the Payload bundle, and it re-implements only the
 * parts that are Pruvious's — the Nuxt module config, the collection
 * definitions, and the importer that calls Pruvious's own collection API.
 *
 * One documented destination structure is supported: a Nuxt app with the
 * `pruvious` module, whose collections live in `collections/`, whose drop and
 * importer live in `import/` and `server/`, and whose delivered media is
 * served from `public/`. The bundle is the app: `npm install`, `npm run dev`,
 * then `npm run migrate`.
 */

const GENERATOR_NAME = "wp-migrate-core";

export interface PruviousGenerateOptions {
  /** Rewrite same-site links so imported content points at its own routes. */
  readonly rewriteLinks?: boolean;
}

interface PruviousField {
  readonly type: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

interface PruviousCollection {
  readonly slug: string;
  readonly label: string;
  readonly kind: "content" | "media" | "taxonomy" | "author" | "navigation";
  readonly fields: Readonly<Record<string, PruviousField>>;
}

interface ContentJob {
  readonly wordpressSourceId: string;
  readonly wordpressId: number;
  readonly postType: string;
  readonly collection: string;
  readonly route: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface SupportingJob {
  readonly wordpressSourceId: string;
  readonly collection: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface DropFile {
  readonly path: string;
  readonly contents: string;
}

export async function generatePruviousBundle(
  project: MigrationProject,
  outDir: string,
  options: PruviousGenerateOptions = {}
): Promise<void> {
  const rewriteLinks = options.rewriteLinks !== false;
  const collections = pruviousCollections(project);
  const slugs = new Set(["users", "uploads", "presets", "previews", "redirects", "roles", "seo"]);
  for (const collection of collections) {
    if (slugs.has(collection.slug)) {
      throw new Error(
        `Pruvious collection name collision: ${collection.slug}. Exclude or rename the conflicting WordPress post type.`
      );
    }
    slugs.add(collection.slug);
  }

  const contentJobs = pruviousContentJobs(project, rewriteLinks);
  const mediaJobs = pruviousMediaJobs(project);
  const taxonomyJobs = pruviousTaxonomyJobs(project);
  const authorJobs = pruviousAuthorJobs(project);
  const navigationJobs = pruviousNavigationJobs(project);
  const outputDirectory = await prepareOutputDirectory(outDir);

  if (project.media.delivery !== undefined) {
    // Media is served from `public/`, so a delivered file keeps the upload path
    // the source site used, and a body `<img>` needs no rewrite to resolve.
    await deliverMedia(project.media.delivery, outputDirectory);
  }

  const files = new Map<string, string>([
    ["package.json", renderPruviousPackageJson(project)],
    ["nuxt.config.ts", renderPruviousNuxtConfig(project)],
    [".env.example", renderPruviousEnvExample()],
    [".gitignore", renderPruviousGitignore()],
    ["README.md", renderPruviousReadme(project)],
    ["app.vue", "<template><NuxtPage /></template>\n"],
    ["tsconfig.json", renderJson({ extends: "./.nuxt/tsconfig.json" })],
    ["import/migrate.mjs", renderPruviousMigrateScript()],
    ["server/api/migrate.post.ts", renderPruviousImporterRoute(project)],
    ["server/middleware/migrate-redirects.ts", renderPruviousRedirectMiddleware(project)],
    ["migration/issues.json", renderIssuesArtifact(project.issues)],
    ["migration/media.json", renderMediaArtifact(project, "pruvious")],
    ["migration/redirects.json", renderRedirectsArtifact(project, "pruvious")],
    ["migration/links.json", renderLinksArtifact(project, "pruvious")],
    ["migration/coverage.json", renderCoverageArtifact(project, "pruvious")],
    ["migration/archives.json", renderArchivesArtifact(project, "pruvious")],
    ["migration/menus.json", renderMenusArtifact(project, "pruvious")],
    ["migration/manifest.json", renderPruviousManifest(project, collections, contentJobs, mediaJobs)]
  ]);

  for (const collection of collections) {
    files.set(`collections/${collection.slug}.ts`, renderPruviousCollection(collection));
  }

  for (const drop of pruviousDropFiles(contentJobs, mediaJobs, taxonomyJobs, authorJobs, navigationJobs, collections)) {
    files.set(drop.path, drop.contents);
  }

  for (const ruleFile of redirectRuleFiles(project)) {
    files.set(ruleFile.path, ruleFile.contents);
  }

  for (const [relativePath, contents] of files) {
    await writeNewFile(outputDirectory, relativePath, contents);
  }
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

function pruviousCollections(project: MigrationProject): readonly PruviousCollection[] {
  const content = project.types
    .filter((entry) => entry.included)
    .map<PruviousCollection>((entry) => ({
      slug: entry.collection,
      label: entry.label,
      kind: "content",
      fields: contentFields()
    }));

  return [
    ...content,
    {
      slug: "media",
      label: "Media",
      kind: "media",
      fields: {
        wordpressSourceId: field("text", { required: true, description: "Stable id such as media:301." }),
        filename: field("text"),
        alt: field("text"),
        url: field("text", { description: "Served path under /wp-content/uploads/, delivered into public/." }),
        importHash: field("text", { description: "Written by the importer; do not edit." })
      }
    },
    {
      slug: "categories",
      label: "Categories",
      kind: "taxonomy",
      fields: taxonomyFields()
    },
    {
      slug: "tags",
      label: "Tags",
      kind: "taxonomy",
      fields: taxonomyFields()
    },
    {
      slug: "authors",
      label: "Authors",
      kind: "author",
      fields: {
        name: field("text", { required: true }),
        slug: field("text", { required: true }),
        wordpressLogin: field("text", { description: "The WordPress login dc:creator recorded." }),
        wordpressSourceId: field("text", { required: true }),
        importHash: field("text", { description: "Written by the importer; do not edit." })
      }
    },
    {
      slug: "navigation",
      label: "Navigation",
      kind: "navigation",
      fields: {
        title: field("text", { required: true }),
        slug: field("text", { required: true }),
        wordpressSourceId: field("text", { required: true }),
        items: field("repeater", {
          description: "The menu tree as the export recorded it.",
          subfields: {
            label: field("text", { required: true }),
            kind: field("text"),
            href: field("text"),
            targetRoute: field("text"),
            reason: field("text-area"),
            children: field("text-area", { description: "Nested entries as JSON, for the rendered menu." })
          }
        }),
        importHash: field("text", { description: "Written by the importer; do not edit." })
      }
    }
  ];
}

function contentFields(): Readonly<Record<string, PruviousField>> {
  return {
    title: field("text", { required: true }),
    slug: field("text", { required: true }),
    route: field("text", { required: true, description: "The path the migrated site serves." }),
    public: field("switch", { default: false, description: "Only WordPress publish becomes public." }),
    publishedAt: field("date-time"),
    modifiedAt: field("date-time"),
    wordpressStatus: field("text", { description: "The source status, such as publish, draft or future." }),
    wordpressId: field("number"),
    wordpressSourceId: field("text", { required: true, description: "Stable id such as wp:post:20." }),
    importHash: field("text", { description: "Written by the importer; do not edit." }),
    author: field("record", { collection: "authors" }),
    featuredImage: field("record", { collection: "media" }),
    categories: field("records", { collection: "categories" }),
    tags: field("records", { collection: "tags" }),
    body: field("editor", { description: "Rich text stored as HTML; rendered by PruviousHTML." }),
    sourceHtml: field("text-area", { trim: false, description: "The exact HTML the export carried." })
  };
}

function taxonomyFields(): Readonly<Record<string, PruviousField>> {
  return {
    name: field("text", { required: true }),
    slug: field("text", { required: true }),
    wordpressSourceId: field("text", { required: true }),
    importHash: field("text", { description: "Written by the importer; do not edit." })
  };
}

function field(type: string, options?: Readonly<Record<string, unknown>>): PruviousField {
  return { type, options: { ...(type === "text" || type === "text-area" ? { trim: false } : {}), ...options } };
}

function renderPruviousCollection(collection: PruviousCollection): string {
  return `import { defineCollection } from '#pruvious'

/* Generated by ${GENERATOR_NAME} ${packageVersion}. */
export default defineCollection(${renderJson({
    name: collection.slug,
    mode: "multi",
    fields: {
      ...collection.fields,
      importSnapshot: field("text-area", { description: "Written by the importer; do not edit." })
    },
    uniqueCompositeIndexes: [["wordpressSourceId"]]
  }).trimEnd()})
`;
}

/* -------------------------------------------------------------------------- */
/* The content drop                                                           */
/* -------------------------------------------------------------------------- */

function pruviousContentJobs(project: MigrationProject, rewriteLinks: boolean): readonly ContentJob[] {
  const collectionByType = new Map(
    project.types.filter((entry) => entry.included).map((entry) => [entry.name, entry.collection])
  );
  const rewrites = rewriteLinks ? linkRewrites(project.links) : [];

  const jobs = project.records.map((record) => {
    const collection = collectionByType.get(record.type) ?? contentCollectionName(record.type);
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    const hrefRewrites = new Map(
      rewrites.filter((rewrite) => rewrite.sourceId === record.sourceId).map((rewrite) => [rewrite.href, rewrite.rewritten])
    );
    const bodyHtml = rewriteDeliveredMedia(rewriteBodyLinks(recordBodyHtml(record), hrefRewrites), project.media.delivery);

    const data: Record<string, unknown> = {
      title: record.title,
      slug: record.slug || record.sourceId,
      route,
      public: record.status === "publish",
      wordpressStatus: record.status,
      wordpressId: record.wordpressId,
      wordpressSourceId: record.sourceId,
      publishedAt: null,
      modifiedAt: null,
      author: null,
      featuredImage: null,
      categories: [],
      tags: [],
      body: bodyHtml,
      sourceHtml: record.rawContent
    };
    if (record.publishedAt !== undefined) data.publishedAt = timestamp(record.publishedAt) ?? null;
    if (record.modifiedAt !== undefined) data.modifiedAt = timestamp(record.modifiedAt) ?? null;
    if (record.author !== undefined && record.author.trim() !== "") data.author = { $ref: authorSourceId(record.author) };
    const featured = featuredMediaReference(project, record);
    if (featured !== undefined) data.featuredImage = { $ref: featured };
    const categories = record.terms.filter((term) => term.domain === "category").map((term) => ({ $ref: termSourceId(term) }));
    const tags = record.terms.filter((term) => term.domain === "post_tag").map((term) => ({ $ref: termSourceId(term) }));
    if (categories.length > 0) data.categories = categories;
    if (tags.length > 0) data.tags = tags;

    return {
      wordpressSourceId: record.sourceId,
      wordpressId: record.wordpressId,
      postType: record.type,
      collection,
      route,
      data
    };
  });

  const routes = new Set<string>();
  for (const job of jobs) {
    if (routes.has(job.route)) throw new Error(`Cannot generate duplicate route: ${job.route}`);
    routes.add(job.route);
  }
  return jobs;
}

/**
 * One job per delivered attachment. Pruvious serves the delivered copy from
 * `public/`, so the media record carries the metadata and the served URL.
 */
function pruviousMediaJobs(project: MigrationProject): readonly SupportingJob[] {
  const outputPathByAssetId = new Map<string, string>();
  for (const entry of project.media.delivery?.entries ?? []) {
    if (entry.assetId !== undefined && entry.outputPath !== undefined) {
      outputPathByAssetId.set(entry.assetId, entry.outputPath);
    }
  }

  const jobs: SupportingJob[] = [];
  for (const asset of project.media.assets) {
    const outputPath = outputPathByAssetId.get(asset.id);
    if (outputPath === undefined) continue;
    jobs.push({
      wordpressSourceId: asset.id,
      collection: "media",
      data: {
        wordpressSourceId: asset.id,
        filename: outputPath.split("/").pop() ?? outputPath,
        url: outputPath,
        alt: asset.altText ?? ""
      }
    });
  }
  return jobs;
}

function pruviousTaxonomyJobs(project: MigrationProject): readonly SupportingJob[] {
  const terms = new Map<string, { term: WordPressTerm; collection: string }>();
  for (const record of project.records) {
    for (const term of record.terms) {
      if (term.domain !== "category" && term.domain !== "post_tag") continue;
      terms.set(termSourceId(term), { term, collection: term.domain === "category" ? "categories" : "tags" });
    }
  }
  return [...terms.values()]
    .sort((left, right) => termSourceId(left.term).localeCompare(termSourceId(right.term)))
    .map(({ term, collection }) => ({
      wordpressSourceId: termSourceId(term),
      collection,
      data: { name: term.name, slug: term.nicename, wordpressSourceId: termSourceId(term) }
    }));
}

function pruviousAuthorJobs(project: MigrationProject): readonly SupportingJob[] {
  const logins = new Set<string>();
  for (const record of project.records) {
    if (record.author !== undefined && record.author.trim() !== "") logins.add(record.author.trim());
  }
  return [...logins].sort().map((login) => ({
    wordpressSourceId: authorSourceId(login),
    collection: "authors",
    data: {
      name: login,
      slug: safeFileStem(login),
      wordpressLogin: login,
      wordpressSourceId: authorSourceId(login)
    }
  }));
}

function pruviousNavigationJobs(project: MigrationProject): readonly SupportingJob[] {
  return project.menus.trees.map((tree) => ({
    wordpressSourceId: navigationSourceId(tree),
    collection: "navigation",
    data: {
      title: tree.name,
      slug: tree.slug || tree.id,
      wordpressSourceId: navigationSourceId(tree),
      items: tree.items.map(navigationItemData)
    }
  }));
}

function navigationItemData(item: MenuItem): Readonly<Record<string, unknown>> {
  const data: Record<string, unknown> = { label: item.label, kind: item.kind };
  if (item.href !== undefined) data.href = item.href;
  if (item.targetRoute !== undefined) data.targetRoute = item.targetRoute;
  if (item.reason !== undefined) data.reason = item.reason;
  if (item.children.length > 0) data.children = renderJson(item.children.map(navigationItemData)).trimEnd();
  return data;
}

function pruviousDropFiles(
  contentJobs: readonly ContentJob[],
  mediaJobs: readonly SupportingJob[],
  taxonomyJobs: readonly SupportingJob[],
  authorJobs: readonly SupportingJob[],
  navigationJobs: readonly SupportingJob[],
  collections: readonly PruviousCollection[]
): readonly DropFile[] {
  const files: DropFile[] = [];
  const groups: { collection: string; jobs: readonly SupportingJob[] }[] = [
    ...groupByCollection(taxonomyJobs),
    ...(authorJobs.length === 0 ? [] : [{ collection: "authors", jobs: authorJobs }]),
    ...(navigationJobs.length === 0 ? [] : [{ collection: "navigation", jobs: navigationJobs }]),
    ...(mediaJobs.length === 0 ? [] : [{ collection: "media", jobs: mediaJobs }])
  ];

  const index: { collection: string; file: string; count: number }[] = [];
  for (const group of groups) {
    files.push({ path: `import/content/${group.collection}.json`, contents: renderJson(group.jobs) });
    index.push({ collection: group.collection, file: `content/${group.collection}.json`, count: group.jobs.length });
  }

  for (const collection of collections.filter((entry) => entry.kind === "content")) {
    const jobs = contentJobs.filter((job) => job.collection === collection.slug);
    if (jobs.length === 0) continue;
    files.push({ path: `import/content/${collection.slug}.json`, contents: renderJson(jobs) });
    index.push({ collection: collection.slug, file: `content/${collection.slug}.json`, count: jobs.length });
  }

  files.push({
    path: "import/content/index.json",
    contents: renderJson({ schemaVersion: artifactSchemaVersions.pruviousDrop, files: index })
  });
  return files;
}

function groupByCollection(jobs: readonly SupportingJob[]): { collection: string; jobs: SupportingJob[] }[] {
  const groups = new Map<string, SupportingJob[]>();
  for (const job of jobs) {
    const list = groups.get(job.collection) ?? [];
    list.push(job);
    groups.set(job.collection, list);
  }
  return [...groups.keys()].sort().map((collection) => ({ collection, jobs: groups.get(collection) ?? [] }));
}

/* -------------------------------------------------------------------------- */
/* Body HTML                                                                  */
/* -------------------------------------------------------------------------- */

/** Rewrite same-site anchors in stored HTML, exactly as the static target does. */
function rewriteBodyLinks(html: string, rewrites: ReadonlyMap<string, string>): string {
  if (rewrites.size === 0) return html;
  return html.replace(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const href = readHtmlAttribute(tag, "href");
    if (href === undefined) return tag;
    const rewritten = rewrites.get(href);
    if (rewritten === undefined || rewritten === href) return tag;
    const attribute = /(\shref\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i;
    return tag.replace(attribute, (_match, prefix: string) => `${prefix}"${rewritten.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`);
  });
}

/* -------------------------------------------------------------------------- */
/* Redirects, middleware, package, manifest                                   */
/* -------------------------------------------------------------------------- */

/**
 * The literal old-path → new-route rules the middleware applies. The Next
 * bundle can hand `source` regex patterns to `next.config.mjs`; Nuxt has no
 * equivalent, so the middleware matches the paths themselves.
 */
function pruviousRedirects(project: MigrationProject): { source: string; destination: string; statusCode: number }[] {
  return project.routes.redirects.map((rule) => ({
    source: rule.sourcePath,
    destination: rule.targetRoute,
    statusCode: 301
  }));
}

function renderPruviousRedirectMiddleware(project: MigrationProject): string {
  const redirects = pruviousRedirects(project);
  return `/* Generated by ${GENERATOR_NAME} ${packageVersion} from the WordPress redirect map. */
const redirects: { source: string; destination: string; statusCode: number }[] = ${renderJson(redirects).trimEnd()}

function normalizePath(path: string) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  const rule = redirects.find((entry) => path !== entry.destination && normalizePath(entry.source) === normalizePath(path))
  if (rule) return sendRedirect(event, rule.destination, rule.statusCode)
})
`;
}

function renderPruviousNuxtConfig(project: MigrationProject): string {
  return `/* Generated by ${GENERATOR_NAME} ${packageVersion} for the WordPress site ${JSON.stringify(project.site.title).replaceAll("*/", "* /")}. */
export default defineNuxtConfig({
  modules: ['pruvious'],
  pruvious: {
    standardCollections: { pages: false },
    database: process.env.NUXT_PRUVIOUS_DATABASE || 'sqlite:./pruvious.db',
  },
})
`;
}

function renderPruviousEnvExample(): string {
  return `# Copy to .env before running the bundle.
# Pruvious creates ./pruvious.db (SQLite) unless you set another database.
# NUXT_PRUVIOUS_DATABASE=sqlite:./pruvious.db
# Set a random token here before starting the app and running npm run migrate.
WP_MIGRATE_IMPORT_TOKEN=
`;
}

function renderPruviousGitignore(): string {
  return `node_modules
.nuxt
.output
.env
.env.*
!.env.example
pruvious.db
pruvious.db-*
.uploads
`;
}

function renderPruviousPackageJson(project: MigrationProject): string {
  return renderJson({
    name: `${safeFileStem(project.site.title)}-pruvious`,
    private: true,
    type: "module",
    engines: { node: ">=22.12.0" },
    scripts: {
      dev: "pruvious dev",
      build: "nuxt build",
      postinstall: "nuxt prepare",
      start: "node .output/server/index.mjs",
      migrate: "node import/migrate.mjs"
    },
    dependencies: {
      nuxt: pruviousNuxtDependency,
      pruvious: pruviousDependency,
      ...pruviousEditorDependencies
    }
  });
}

function renderPruviousMigrateScript(): string {
  return `import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  const token = process.env.WP_MIGRATE_IMPORT_TOKEN
  if (!token) throw new Error('Set WP_MIGRATE_IMPORT_TOKEN in .env before starting the app and importing.')
  const response = await fetch(new URL('/api/migrate', process.env.WP_MIGRATE_URL || 'http://localhost:3000'), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token }
  })
  if (!response.ok) throw new Error('Import request failed (' + response.status + '): ' + await response.text())
  const result = await response.json()
  console.log(JSON.stringify(result, null, 2))
  if (result.failed > 0) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
`;
}

function renderPruviousManifest(
  project: MigrationProject,
  collections: readonly PruviousCollection[],
  contentJobs: readonly ContentJob[],
  mediaJobs: readonly SupportingJob[]
): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  return renderJson({
    schemaVersion: artifactSchemaVersions.manifestPruvious,
    generator: { name: GENERATOR_NAME, version: packageVersion, target: "pruvious" },
    sourceSite: { title: project.site.title, ...(siteUrl === undefined ? {} : { url: siteUrl }) },
    destination: {
      target: "pruvious",
      kind: "cms",
      structure: "pruvious-nuxt",
      pruviousVersion: pruviousDependency,
      nuxtVersion: pruviousNuxtVersionForManifest(),
      config: "nuxt.config.ts",
      admin: "/dashboard",
      importer: "server/api/migrate.post.ts",
      importReport: "migration-import.json"
    },
    summary: project.summary,
    targets: targetRecords(),
    media: {
      file: "migration/media.json",
      summary: project.media.summary,
      drop: mediaJobs.length === 0 ? undefined : "import/content/media.json",
      ...(project.media.delivery === undefined ? {} : { delivery: project.media.delivery.summary })
    },
    ...(project.config === undefined ? {} : { config: { applied: true, decisions: project.config.decisions } }),
    redirects: { file: "migration/redirects.json", summary: project.routes.summary },
    links: { file: "migration/links.json", summary: project.links.summary },
    coverage: { file: "migration/coverage.json", summary: project.coverage.summary },
    types: project.types.map((entry) => ({
      name: entry.name,
      label: entry.label,
      collection: entry.collection,
      sourceItems: entry.sourceItems,
      records: entry.records,
      included: entry.included,
      ...(entry.reason === undefined ? {} : { reason: entry.reason })
    })),
    archives: { file: "migration/archives.json", summary: project.archives.summary },
    menus: { file: "migration/menus.json", summary: project.menus.summary },
    collections: collections.map((collection) => ({
      slug: collection.slug,
      label: collection.label,
      kind: collection.kind,
      fields: Object.keys(collection.fields),
      drop:
        collection.kind === "content" || collection.kind === "navigation" || collection.kind === "media" ||
        collection.kind === "author"
          ? `import/content/${collection.slug}.json`
          : undefined
    })),
    records: contentJobs.map((job) => ({
      sourceId: job.wordpressSourceId,
      wordpressId: job.wordpressId,
      postType: job.postType,
      collection: job.collection,
      route: job.route,
      dropFile: `import/content/${job.collection}.json`
    }))
  });
}

function pruviousNuxtVersionForManifest(): string {
  return pruviousNuxtDependency;
}

/* -------------------------------------------------------------------------- */
/* README                                                                     */
/* -------------------------------------------------------------------------- */

function renderPruviousReadme(project: MigrationProject): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  const delivery = project.media.delivery;
  const collections = project.types.filter((entry) => entry.included);
  const redirects = project.routes.redirects.length;
  const mediaLine =
    delivery === undefined
      ? "No media was delivered: this run was not given a local uploads directory."
      : `${delivery.summary.copied} delivered ${delivery.summary.copied === 1 ? "file" : "files"}, served from \`public/\`.`;

  return `# ${project.site.title} — Pruvious migration bundle

Generated from ${siteUrl ?? "a WordPress export"} by ${GENERATOR_NAME} ${packageVersion}.

This is a CMS destination for Nuxt: the \`pruvious\` module turns the app into a
CMS with a dashboard, collections, media and a publishing workflow. The bundle
is the app — the collections, the config, a content and media drop, and the
importer you run inside it. ${GENERATOR_NAME} itself never talks to a database.

## Structure

* \`nuxt.config.ts\` — the Nuxt config with the \`pruvious\` module.
* \`collections/\` — one file per collection: ${collections.map((entry) => entry.collection).join(", ") || "none"}, plus \`media\`, \`categories\`, \`tags\`, \`authors\` and \`navigation\`.
* \`server/api/migrate.post.ts\` — the generated importer.
* \`import/content/\` — the drop: one file per collection, with \`{ "$ref": ... }\` markers the importer resolves.
* \`server/middleware/migrate-redirects.ts\` — the redirect map, as Nitro middleware.
* \`public/wp-content/uploads/\` — ${mediaLine}
* \`migration/\` — the same review artifacts an Astro handoff writes.
* \`.env.example\`, \`.gitignore\` — keep the database and build out of git.

## Run it

\`\`\`bash
npm install
cp .env.example .env
# Set WP_MIGRATE_IMPORT_TOKEN in .env to a random secret before starting.
npm run dev                 # the dashboard is at http://localhost:3000/dashboard
# in another terminal, once the app is up:
npm run migrate             # imports the drop and writes migration-import.json
\`\`\`

Open \`/dashboard\` to create the first admin account. The importer runs inside
the Nuxt app because Pruvious's collection API is a server API; the
\`npm run migrate\` script posts to the generated \`/api/migrate\` route and
prints the summary. Both processes use \`WP_MIGRATE_IMPORT_TOKEN\` from \`.env\`;
requests without that token are rejected. Set \`WP_MIGRATE_URL\` for a different
app URL. \`WP_MIGRATE_IMPORT_REPORT\` overrides the report's full file path.

The importer writes \`migration-import.json\`. Point verification at it:

\`\`\`bash
npx wp-migrate-core verify ../export.xml --import-report migration-import.json --fail-on blocker
\`\`\`

## What transferred

* Posts and pages from every included post type, with title, slug, route, dates, author, taxonomy and the source publication status. Only WordPress \`publish\` becomes public; every other status stays unpublished with its \`wordpressStatus\` recorded.
* The body as HTML in an \`editor\` field, with same-site links rewritten to the generated routes. \`sourceHtml\` keeps the exact export HTML.
* The WordPress menus as a \`navigation\` collection.
* Delivered media as a \`media\` collection plus files under \`public/wp-content/uploads/\`, with body image and download URLs rewritten to the served copies.
* ${redirects === 0 ? "No redirect rules (this plan needs none)" : redirects === 1 ? "1 redirect rule" : `${redirects} redirect rules`} as Nitro middleware and the host rule files.
* Stable source identifiers (\`wordpressSourceId\`) so a re-import does not duplicate anything.

## What needs a human

* The front end that renders these collections is yours to build with Nuxt components and blocks. This bundle gives you the collections and the data, not the pages that show them.
* Media files are served from \`public/\`; wiring them into Pruvious's own uploads library (optimization, the media manager) is not done here.
* Rich text is stored as the export HTML inside Pruvious's editor field. Converting it into native blocks is the next step.

This bundle is written against Pruvious ${pruviousDependency} and Nuxt ${pruviousNuxtDependency}. The 0.11.1 review manually verified imports, repeat runs, source updates, dashboard edit protection, navigation and local media paths with Pruvious 3.9.10, Nuxt 3.9.3 and SQLite. A real-site migration and a repeatable integration check remain validation gates. Nested menu entries are stored as JSON in a text field.
`;
}

/* -------------------------------------------------------------------------- */
/* The generated importer                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The importer as a Nitro route. It runs inside the Nuxt app, resolves the
 * reference markers against the ids earlier passes created, and upserts by
 * `wordpressSourceId` through Pruvious's own collection API. It writes the
 * same `migration-import.json` the Payload importer does, so one verification
 * step reads either destination.
 */
export function renderPruviousImporterRoute(project: MigrationProject): string {
  return `/**
 * Generated by ${GENERATOR_NAME} ${packageVersion} for ${JSON.stringify(project.site.title).replaceAll("*/", "* /")}.
 *
 * Runs inside the Nuxt app with Pruvious's collection API. It reads the drop
 * in import/content, resolves every { "$ref": ... } marker against the ids
 * earlier passes created, and upserts each record by wordpressSourceId.
 *
 * Re-imports are safe: an unchanged record is left alone, a changed one is
 * updated, and a record somebody edited in the dashboard is skipped and
 * reported rather than overwritten.
 *
 * Trigger it with:  npm run migrate   (server/api/migrate.post.ts)
 * Result:           ./migration-import.json
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { query } from '#pruvious/server'

const bundleRoot = process.cwd()

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value === undefined ? null : value)
}

function managedFieldsHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function projectFields(doc, data) {
  if (Array.isArray(data)) return (doc ?? []).map((value, index) => projectFields(value, data[index] ?? value))
  if (!data || typeof data !== 'object') return doc ?? null
  const out = {}
  for (const key of Object.keys(data)) out[key] = projectFields(doc?.[key], data[key])
  return out
}

function resolveReferences(value, ids) {
  const missing = []
  const visit = (input) => {
    if (Array.isArray(input)) return input.map(visit).filter((entry) => entry !== undefined)
    if (input && typeof input === 'object') {
      if (typeof input.$ref === 'string') {
        const id = ids[input.$ref]
        if (id === undefined) {
          missing.push(input.$ref)
          return undefined
        }
        return id
      }
      const out = {}
      for (const [key, entry] of Object.entries(input)) {
        const resolved = visit(entry)
        out[key] = resolved === undefined ? null : resolved
      }
      return out
    }
    return input
  }
  return { data: visit(value), missing }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(file, index = false) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(index ? value?.files : value)) throw new Error('Expected an array of ' + (index ? 'files' : 'records'))
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

async function upsert(entry, job, ids, counters, records) {
  const resolved = resolveReferences(job.data, ids)
  counters.unresolved += resolved.missing.length
  const importHash = managedFieldsHash(resolved.data)
  const base = {
    id: job.wordpressSourceId,
    sourceId: job.wordpressSourceId,
    postType: job.postType ?? null,
    collection: entry.collection,
    route: job.route ?? null,
    title: typeof resolved.data.title === 'string' ? resolved.data.title : null
  }

  const existing = await query(entry.collection).where('wordpressSourceId', job.wordpressSourceId).first()

  if (!existing) {
    const result = await query(entry.collection).create({
      ...resolved.data,
      importHash,
      importSnapshot: JSON.stringify(resolved.data)
    })
    if (!result.success || !result.record) {
      throw new Error('create failed: ' + JSON.stringify(result.errors))
    }
    ids[job.wordpressSourceId] = result.record.id
    counters.created += 1
    records.push({ ...base, action: 'created', unresolved: resolved.missing })
    return
  }

  ids[job.wordpressSourceId] = existing.id

  const snapshot = existing.importSnapshot ? JSON.parse(existing.importSnapshot) : resolved.data
  const previousHash = existing.importSnapshot ? managedFieldsHash(snapshot) : existing.importHash
  if (managedFieldsHash(projectFields(existing, snapshot)) !== previousHash) {
    counters.skipped += 1
    records.push({ ...base, action: 'skipped', reason: 'record-modified', unresolved: resolved.missing })
    return
  }

  if (existing.importHash !== importHash) {
    const cleared = {}
    for (const key of Object.keys(snapshot)) {
      if (!(key in resolved.data)) cleared[key] = Array.isArray(snapshot[key]) ? [] : null
    }
    const result = await query(entry.collection).where('id', existing.id).update({
      ...cleared,
      ...resolved.data,
      importHash,
      importSnapshot: JSON.stringify(resolved.data)
    })
    if (!result.success) {
      throw new Error('update failed: ' + JSON.stringify(result.errors))
    }
    counters.updated += 1
    records.push({ ...base, action: 'updated', unresolved: resolved.missing })
    return
  }

  counters.unchanged += 1
  records.push({ ...base, action: 'unchanged', unresolved: resolved.missing })
}

export default defineEventHandler(async (event) => {
  const token = process.env.WP_MIGRATE_IMPORT_TOKEN
  if (!token || getHeader(event, 'authorization') !== 'Bearer ' + token) {
    throw createError({ statusCode: 403, statusMessage: 'Import token required' })
  }
  const records = []
  const counters = { planned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, unresolved: 0 }
  const ids = {}

  const indexFile = resolve(bundleRoot, 'import/content/index.json')
  const index = await readJson(indexFile, true)
  if (!index.ok) {
    counters.planned += 1
    counters.failed += 1
    records.push({
      id: 'import:index',
      sourceId: 'import:index',
      postType: null,
      collection: 'index',
      route: null,
      title: null,
      action: 'failed',
      reason: 'Cannot read the drop index ' + indexFile + ': ' + index.error,
      unresolved: []
    })
  }

  for (const entry of (index.ok ? index.value.files : [])) {
    const file = await readJson(resolve(bundleRoot, 'import', entry.file))
    if (!file.ok) {
      counters.planned += 1
      counters.failed += 1
      records.push({
        id: 'import-file:' + entry.file,
        sourceId: 'import-file:' + entry.file,
        postType: null,
        collection: entry.collection,
        route: null,
        title: null,
        action: 'failed',
        reason: 'Cannot read ' + entry.file + ': ' + file.error,
        unresolved: []
      })
      continue
    }
    for (const job of file.value) {
      counters.planned += 1
      try {
        await upsert(entry, job, ids, counters, records)
      } catch (error) {
        counters.failed += 1
        records.push({
          id: job.wordpressSourceId,
          sourceId: job.wordpressSourceId,
          postType: job.postType ?? null,
          collection: entry.collection,
          route: job.route ?? null,
          title: null,
          action: 'failed',
          reason: messageOf(error),
          unresolved: []
        })
      }
    }
  }

  const report = {
    schemaVersion: '${artifactSchemaVersions.importReport}',
    generator: { name: '${GENERATOR_NAME}', version: '${packageVersion}', target: 'pruvious' },
    generatedAt: new Date().toISOString(),
    destination: { target: 'pruvious', kind: 'cms', structure: 'pruvious-nuxt' },
    summary: counters,
    records
  }

  const reportPath = resolve(process.env.WP_MIGRATE_IMPORT_REPORT || resolve(bundleRoot, 'migration-import.json'))
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\\n')

  return {
    planned: counters.planned,
    created: counters.created,
    updated: counters.updated,
    unchanged: counters.unchanged,
    skipped: counters.skipped,
    failed: counters.failed,
    report: reportPath
  }
})
`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function featuredMediaReference(project: MigrationProject, record: ContentRecord): string | undefined {
  return project.media.references.find(
    (reference) =>
      reference.sourceId === record.sourceId && reference.kind === "featured-image" && reference.assetId !== undefined
  )?.assetId;
}

function termSourceId(term: WordPressTerm): string {
  return `wp:term:${term.domain}:${term.nicename}`;
}

function authorSourceId(login: string): string {
  return `wp:author:${login}`;
}

function navigationSourceId(tree: MenuTree): string {
  return `wp:menu:${tree.slug || tree.id}`;
}

/** Pruvious stores date-times as milliseconds, so an ISO string is converted. */
function timestamp(value: string): number | undefined {
  const iso = value.replace(" ", "T");
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(date.valueOf()) ? undefined : date.valueOf();
}

/** Kept so the media module and this module agree on what a media path is. */
export function pruviousMediaPath(value: string | undefined): string | undefined {
  return mediaPath(value);
}
