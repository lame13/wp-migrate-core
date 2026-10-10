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
  linkRewrites,
  mediaPath,
  normalizeRoute,
  sanitizeSourceUrl,
  stripMediaVariants
} from "./core.js";
import { htmlToPayloadRichText } from "./payload-richtext.js";
import type { ContentReviewItem, ImageResolver } from "./payload-richtext.js";
export { htmlToPayloadRichText } from "./payload-richtext.js";
import { deliverMedia } from "./media.js";
import { redirectRuleFiles, renderVercelRedirects } from "./redirect-rules.js";
import { escapeHtml, prepareOutputDirectory, renderJson, safeFileStem, writeNewFile } from "./render.js";
import { targetRecords } from "./targets.js";
import { packageVersion, payloadAdminDependencies, payloadDependency } from "./version.js";
import type { ContentRecord, MigrationNode, MigrationProject, WordPressTerm } from "./types.js";

/**
 * The Payload destination.
 *
 * A static-site target writes pages; a CMS destination writes a reviewable
 * bundle — collections, configuration, a content and media drop — plus a
 * generated importer the caller runs *inside* the destination project. This
 * tool never talks to a database: the importer is the only thing that does,
 * and it is the caller's to run.
 *
 * One documented destination structure is supported: a Payload + Next app
 * whose collections live in `collections/`, whose config is
 * `payload.config.js`, whose admin host is `app/(payload)`, whose uploads land
 * in `media/`, and whose drop and importer live in `import/`. The bundle is
 * the app: `npm install`, `npm run import`, `npm run dev`.
 */

const GENERATOR_NAME = "wp-migrate-core";
const SAFE_HREF = /^(?:https?:|mailto:|tel:|\/|#)/i;

export interface PayloadGenerateOptions {
  /**
   * Rewrite same-site links so imported content points at its own routes
   * instead of the source permalinks. Defaults to true.
   */
  readonly rewriteLinks?: boolean;
}

interface ContentJob {
  readonly wordpressSourceId: string;
  readonly wordpressId: number;
  readonly postType: string;
  readonly collection: string;
  readonly route: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface MediaJob {
  readonly wordpressSourceId: string;
  readonly wordpressId: number;
  readonly collection: "media";
  readonly data: Readonly<Record<string, unknown>>;
  /** Path inside the bundle the importer uploads, when a local file was delivered. */
  readonly file?: string;
}

interface PayloadField {
  readonly name: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PayloadCollection {
  readonly slug: string;
  readonly fileName: string;
  readonly label: string;
  readonly kind: "content" | "media" | "taxonomy" | "author";
  readonly sourceTypes: readonly string[];
  readonly fields: readonly PayloadField[];
}

interface DropFile {
  readonly path: string;
  readonly contents: string;
}

export async function generatePayloadBundle(
  project: MigrationProject,
  outDir: string,
  options: PayloadGenerateOptions = {}
): Promise<void> {
  const rewriteLinks = options.rewriteLinks !== false;
  const collections = payloadCollections(project);
  const slugs = new Set(["users"]);
  const modules = new Set<string>();
  for (const collection of collections) {
    if (slugs.has(collection.slug) || modules.has(collection.fileName)) {
      throw new Error(`Payload collection name collision: ${collection.slug}. Exclude or rename the conflicting WordPress post type.`);
    }
    slugs.add(collection.slug);
    modules.add(collection.fileName);
  }
  const contentJobs = payloadContentJobs(project, rewriteLinks);
  const mediaJobs = payloadMediaJobs(project);
  const taxonomies = payloadTaxonomies(project);
  const authors = payloadAuthors(project);
  const outputDirectory = await prepareOutputDirectory(outDir);

  if (project.media.delivery !== undefined) {
    // `deliverMedia` writes every copied file under `<dir>/public/`. The
    // importer uploads them from `import/media/public/...`, so the source
    // upload paths stay exactly what the export recorded.
    await deliverMedia(project.media.delivery, resolveMediaRoot(outputDirectory));
  }

  const files = new Map<string, string>([
    ["package.json", renderPayloadPackageJson(project)],
    ["payload.config.js", renderPayloadConfig(project, collections)],
    ["README.md", renderPayloadReadme(project)],
    ["next.config.mjs", renderNextConfig(project)],
    ["import/import.mjs", renderPayloadImporter(project)],
    ["import/redirects.json", renderNextRedirects(project)],
    ["migration/issues.json", renderIssuesArtifact(project.issues)],
    ["migration/media.json", renderMediaArtifact(project, "payload")],
    ["migration/redirects.json", renderRedirectsArtifact(project, "payload")],
    ["migration/links.json", renderLinksArtifact(project, "payload")],
    ["migration/coverage.json", renderCoverageArtifact(project, "payload")],
    ["migration/archives.json", renderArchivesArtifact(project, "payload")],
    ["migration/menus.json", renderMenusArtifact(project, "payload")],
    ["migration/manifest.json", renderPayloadManifest(project, collections, contentJobs, mediaJobs)]
  ]);

  for (const collection of collections) {
    files.set(`collections/${collection.fileName}`, renderCollectionModule(collection));
  }

  for (const file of payloadAppFiles()) {
    files.set(file.path, file.contents);
  }

  for (const drop of payloadDropFiles(contentJobs, mediaJobs, taxonomies, authors, collections)) {
    files.set(drop.path, drop.contents);
  }

  for (const ruleFile of redirectRuleFiles(project)) {
    files.set(ruleFile.path, ruleFile.contents);
  }

  for (const [relativePath, contents] of files) {
    await writeNewFile(outputDirectory, relativePath, contents);
  }
}

/** Where the importer reads delivered files from, and Payload uploads from. */
function resolveMediaRoot(outputDirectory: string): string {
  return `${outputDirectory}/import/media`;
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

function payloadCollections(project: MigrationProject): readonly PayloadCollection[] {
  const content = project.types
    .filter((entry) => entry.included)
    .map<PayloadCollection>((entry) => ({
      slug: entry.collection,
      fileName: `${collectionModuleName(entry.collection)}.mjs`,
      label: entry.label,
      kind: "content",
      sourceTypes: [entry.name],
      fields: contentFields()
    }));

  return [
    ...content,
    {
      slug: "media",
      fileName: "Media.mjs",
      label: "Media",
      kind: "media",
      sourceTypes: ["attachment"],
      fields: [
        { name: "alt", type: "text", admin: { description: "Alternative text from the export, when it carried one." } },
        { name: "wordpressId", type: "number", index: true },
        { name: "wordpressSourceId", type: "text", required: true, unique: true, index: true },
        { name: "importHash", type: "text", admin: { readOnly: true } }
      ]
    },
    {
      slug: "categories",
      fileName: "Categories.mjs",
      label: "Categories",
      kind: "taxonomy",
      sourceTypes: ["category"],
      fields: taxonomyFields()
    },
    {
      slug: "tags",
      fileName: "Tags.mjs",
      label: "Tags",
      kind: "taxonomy",
      sourceTypes: ["post_tag"],
      fields: taxonomyFields()
    },
    {
      slug: "authors",
      fileName: "Authors.mjs",
      label: "Authors",
      kind: "author",
      sourceTypes: ["author"],
      fields: [
        { name: "name", type: "text", required: true },
        { name: "slug", type: "text", required: true, index: true },
        {
          name: "wordpressLogin",
          type: "text",
          admin: { description: "The WordPress login dc:creator recorded. Not a Payload user." }
        },
        { name: "wordpressSourceId", type: "text", required: true, unique: true, index: true },
        { name: "importHash", type: "text", admin: { readOnly: true } }
      ]
    }
  ];
}

/**
 * The fields a content record needs. `_status` is Payload's own draft flag;
 * `wordpressStatus` keeps the source status verbatim, because `future` and
 * `private` are not the same thing as a draft.
 */
function contentFields(): readonly PayloadField[] {
  return [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, index: true },
    { name: "route", type: "text", index: true, admin: { description: "The path the migrated site serves." } },
    { name: "publishedAt", type: "date" },
    { name: "modifiedAt", type: "date" },
    {
      name: "wordpressStatus",
      type: "select",
      options: ["publish", "draft", "future", "pending", "private", "trash", "inherit", "unknown"].map((value) => ({
        label: value,
        value
      }))
    },
    { name: "wordpressId", type: "number", index: true },
    { name: "wordpressSourceId", type: "text", required: true, unique: true, index: true },
    { name: "importHash", type: "text", admin: { readOnly: true } },
    { name: "author", type: "relationship", relationTo: "authors" },
    { name: "featuredImage", type: "relationship", relationTo: "media" },
    { name: "categories", type: "relationship", relationTo: "categories", hasMany: true },
    { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
    {
      name: "wordpressTerms",
      type: "array",
      admin: { description: "Taxonomy terms outside category and post_tag, kept for a decision." },
      fields: [
        { name: "domain", type: "text" },
        { name: "name", type: "text" },
        { name: "slug", type: "text" }
      ]
    },
    { name: "body", type: "richText" },
    {
      name: "sourceHtml",
      type: "textarea",
      admin: { description: "The exact HTML the export carried, kept so nothing is lost." }
    },
    {
      name: "contentReview",
      type: "array",
      admin: { description: "Constructs that did not become native editor content." },
      fields: [
        { name: "kind", type: "text" },
        { name: "label", type: "text" },
        { name: "reason", type: "textarea" },
        { name: "html", type: "textarea" }
      ]
    }
  ];
}

function taxonomyFields(): readonly PayloadField[] {
  return [
    { name: "name", type: "text", required: true },
    { name: "slug", type: "text", required: true, index: true },
    { name: "wordpressSourceId", type: "text", required: true, unique: true, index: true },
    { name: "importHash", type: "text", admin: { readOnly: true } }
  ];
}

function collectionModuleName(slug: string): string {
  const name = slug
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
  return /^[0-9]/.test(name) ? `Collection${name}` : name || "Collection";
}

function renderCollectionModule(collection: PayloadCollection): string {
  const body: Record<string, unknown> = {
    slug: collection.slug,
    labels: { singular: collection.label, plural: collection.label },
    fields: [...collection.fields, { name: "importSnapshot", type: "json", admin: { hidden: true } }]
  };

  if (collection.kind === "content" || collection.kind === "author") {
    body.versions = { drafts: true };
  }
  if (collection.kind === "content") {
    body.admin = { useAsTitle: "title" };
  }
  if (collection.kind === "media") {
    body.upload = { staticDir: "media" };
    body.admin = { useAsTitle: "filename" };
  }

  const name = collectionModuleName(collection.slug);
  return `/** Generated by ${GENERATOR_NAME} ${packageVersion}. */
export const ${name} = ${renderJson(body).trimEnd()};

export default ${name};
`;
}

function renderPayloadConfig(project: MigrationProject, collections: readonly PayloadCollection[]): string {
  const imports = collections
    .map((collection) => `import { ${collectionModuleName(collection.slug)} } from "./collections/${collection.fileName}";`)
    .join("\n");
  const list = collections.map((collection) => `    ${collectionModuleName(collection.slug)}`).join(",\n");

  return `import { buildConfig } from "payload";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
${imports}

/**
 * Generated by ${GENERATOR_NAME} ${packageVersion} for the WordPress site
 * ${JSON.stringify(project.site.title).replaceAll("*/", "* /")}. One documented destination structure:
 * a Payload + Next app. The admin host is in app/(payload), the importer is
 * import/import.mjs, and the collections live next to this file.
 *
 * Set PAYLOAD_SECRET and DATABASE_URI in the environment before running.
 */
export default buildConfig({
  secret: process.env.PAYLOAD_SECRET || "change-me-before-deploying",
  editor: lexicalEditor(),
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URI || "file:./payload.db" }
  }),
  collections: [
${list}
  ]
});
`;
}

/* -------------------------------------------------------------------------- */
/* The content drop                                                           */
/* -------------------------------------------------------------------------- */

function payloadContentJobs(project: MigrationProject, rewriteLinks: boolean): readonly ContentJob[] {
  const collectionByType = new Map(
    project.types.filter((entry) => entry.included).map((entry) => [entry.name, entry.collection])
  );
  const rewrites = rewriteLinks ? linkRewrites(project.links) : [];
  const delivered = deliveredAssetIds(project);

  const jobs = project.records.map((record) => {
    const collection = collectionByType.get(record.type) ?? contentCollectionName(record.type);
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    const hrefRewrites = new Map(
      rewrites.filter((rewrite) => rewrite.sourceId === record.sourceId).map((rewrite) => [rewrite.href, rewrite.rewritten])
    );
    const { body, review } = htmlToPayloadRichText(
      recordBodyHtml(record),
      hrefRewrites,
      payloadImageResolver(project, record, delivered)
    );
    const featuredImage = featuredMediaReference(project, record);
    const categoryRefs = record.terms
      .filter((term) => term.domain === "category")
      .map((term) => ({ $ref: termSourceId(term) }));
    const tagRefs = record.terms
      .filter((term) => term.domain === "post_tag")
      .map((term) => ({ $ref: termSourceId(term) }));
    const otherTerms = record.terms
      .filter((term) => term.domain !== "category" && term.domain !== "post_tag")
      .map((term) => ({ domain: term.domain, name: term.name, slug: term.nicename }));

    const data: Record<string, unknown> = {
      title: record.title,
      slug: record.slug || record.sourceId,
      route,
      wordpressStatus: record.status,
      wordpressId: record.wordpressId,
      wordpressSourceId: record.sourceId,
      _status: payloadDocumentStatus(record),
      publishedAt: null,
      modifiedAt: null,
      author: null,
      featuredImage: null,
      categories: [],
      tags: [],
      wordpressTerms: [],
      body,
      sourceHtml: record.rawContent,
      contentReview: review
    };
    const publishedAt = record.publishedAt === undefined ? undefined : payloadDate(record.publishedAt);
    const modifiedAt = record.modifiedAt === undefined ? undefined : payloadDate(record.modifiedAt);
    if (publishedAt !== undefined) data.publishedAt = publishedAt;
    if (modifiedAt !== undefined) data.modifiedAt = modifiedAt;
    if (record.author !== undefined && record.author.trim() !== "") data.author = { $ref: authorSourceId(record.author) };
    if (featuredImage !== undefined) data.featuredImage = { $ref: featuredImage };
    if (categoryRefs.length > 0) data.categories = categoryRefs;
    if (tagRefs.length > 0) data.tags = tagRefs;
    if (otherTerms.length > 0) data.wordpressTerms = otherTerms;

    return {
      wordpressSourceId: record.sourceId,
      wordpressId: record.wordpressId,
      postType: record.type,
      collection,
      route,
      data
    };
  });

  // A CMS bundle serves one URL per route, exactly like the static target does.
  const routes = new Set<string>();
  for (const job of jobs) {
    if (routes.has(job.route)) throw new Error(`Cannot generate duplicate route: ${job.route}`);
    routes.add(job.route);
  }
  return jobs;
}

/** Attachment ids this run delivered a local file for, so the importer can upload them. */
function deliveredAssetIds(project: MigrationProject): ReadonlySet<string> {
  const delivered = new Set<string>();
  for (const entry of project.media.delivery?.entries ?? []) {
    if (entry.assetId !== undefined && entry.outputPath !== undefined) delivered.add(entry.assetId);
  }
  return delivered;
}

/**
 * Body images become Payload upload nodes when the export ties them to an
 * attachment this run actually delivered. Every other image stays a
 * `contentReview` row, because a node pointing at a record that will never
 * exist is worse than saying so.
 *
 * The lookup is by upload path with the WordPress size suffix stripped, so a
 * body that references `tap-768x512.jpg` matches the `tap.jpg` attachment
 * WordPress generated it from.
 */
function payloadImageResolver(
  project: MigrationProject,
  record: ContentRecord,
  delivered: ReadonlySet<string>
): ImageResolver | undefined {
  const byKey = new Map<string, string | null>();
  const byVariant = new Map<string, string | null>();
  const add = (index: Map<string, string | null>, key: string, assetId: string): void => {
    index.set(key, index.has(key) && index.get(key) !== assetId ? null : assetId);
  };
  for (const reference of project.media.references) {
    if (reference.sourceId !== record.sourceId) continue;
    if (reference.kind === "featured-image") continue;
    if (reference.assetId === undefined || !delivered.has(reference.assetId)) continue;
    const key = payloadMediaKey(reference.url ?? reference.path, project.site.url);
    if (key === undefined) continue;
    add(byKey, key, reference.assetId);
    add(byVariant, stripMediaVariants(key), reference.assetId);
  }
  if (byKey.size === 0) return undefined;

  return (image) => {
    const key = payloadMediaKey(image.src, project.site.url);
    if (key === undefined) return undefined;
    const sourceId = byKey.has(key) ? byKey.get(key) : byVariant.get(stripMediaVariants(key));
    if (sourceId == null) return undefined;
    return image.alt === undefined ? { sourceId } : { sourceId, alt: image.alt };
  };
}

/** Normalize paths without losing the host that identifies an attachment. */
function payloadMediaKey(value: string | undefined, siteUrl: string | undefined): string | undefined {
  const path = mediaPath(value);
  if (path === undefined) return undefined;
  try {
    return `${new URL(sanitizeSourceUrl(value) ?? value!, siteUrl).host}${path}`;
  } catch {
    return path;
  }
}

/** Only content published in WordPress may be published in Payload. */
function payloadDocumentStatus(record: ContentRecord): "draft" | "published" {
  return record.status === "publish" ? "published" : "draft";
}

/** Payload stores a date; keep the export's value and drop an invalid one. */
function payloadDate(value: string): string | undefined {
  const iso = value.replace(" ", "T");
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

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

function payloadTaxonomies(
  project: MigrationProject
): readonly { domain: string; collection: string; terms: readonly WordPressTerm[] }[] {
  const byDomain = new Map<string, Map<string, WordPressTerm>>();
  for (const record of project.records) {
    for (const term of record.terms) {
      // Other taxonomies are already preserved in each record's wordpressTerms.
      if (term.domain !== "category" && term.domain !== "post_tag") continue;
      const domain = byDomain.get(term.domain) ?? new Map<string, WordPressTerm>();
      domain.set(term.nicename, term);
      byDomain.set(term.domain, domain);
    }
  }

  return [...byDomain.entries()]
    .map(([domain, terms]) => ({ domain, collection: taxonomyCollectionSlug(domain), terms: [...terms.values()] }))
    .sort((left, right) => left.domain.localeCompare(right.domain));
}

function taxonomyCollectionSlug(domain: string): string {
  if (domain === "category") return "categories";
  if (domain === "post_tag") return "tags";
  const stem = domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "taxonomy"}s`;
}

function payloadAuthors(project: MigrationProject): readonly { login: string; name: string; slug: string }[] {
  const logins = new Set<string>();
  for (const record of project.records) {
    if (record.author !== undefined && record.author.trim() !== "") logins.add(record.author);
  }

  return [...logins].sort().map((login) => ({ login, name: login, slug: safeFileStem(login) }));
}

/**
 * One job per attachment that has a local file to upload. A `linked` or
 * `remote` file has no bytes the importer can send, so it is left out and any
 * reference to it is reported as unresolved instead of inventing an empty
 * media record.
 */
function payloadMediaJobs(project: MigrationProject): readonly MediaJob[] {
  const outputPathByAssetId = new Map<string, string>();
  for (const entry of project.media.delivery?.entries ?? []) {
    if (entry.assetId !== undefined && entry.outputPath !== undefined) {
      outputPathByAssetId.set(entry.assetId, entry.outputPath);
    }
  }

  const jobs: MediaJob[] = [];
  for (const asset of project.media.assets) {
    const outputPath = outputPathByAssetId.get(asset.id);
    if (outputPath === undefined) continue;
    const data: Record<string, unknown> = {
      wordpressSourceId: asset.id,
      wordpressId: asset.wordpressId,
      alt: null
    };
    if (asset.altText !== undefined && asset.altText.trim() !== "") data.alt = asset.altText;
    jobs.push({
      wordpressSourceId: asset.id,
      wordpressId: asset.wordpressId,
      collection: "media",
      data,
      file: `import/media/public${outputPath}`
    });
  }
  return jobs;
}

/* -------------------------------------------------------------------------- */
/* The drop files                                                             */
/* -------------------------------------------------------------------------- */

function payloadDropFiles(
  contentJobs: readonly ContentJob[],
  mediaJobs: readonly MediaJob[],
  taxonomies: readonly { domain: string; collection: string; terms: readonly WordPressTerm[] }[],
  authors: readonly { login: string; name: string; slug: string }[],
  collections: readonly PayloadCollection[]
): readonly DropFile[] {
  const files: DropFile[] = [];

  const termsByCollection = new Map<string, Record<string, unknown>[]>();
  for (const taxonomy of taxonomies) {
    const list = termsByCollection.get(taxonomy.collection) ?? [];
    list.push(
      ...taxonomy.terms.map((term) => ({
        wordpressSourceId: termSourceId(term),
        collection: taxonomy.collection,
        data: { name: term.name, slug: term.nicename, wordpressSourceId: termSourceId(term) }
      }))
    );
    termsByCollection.set(taxonomy.collection, list);
  }
  for (const collection of [...termsByCollection.keys()].sort()) {
    files.push({ path: `import/content/${collection}.json`, contents: renderJson(termsByCollection.get(collection)) });
  }

  if (authors.length > 0) {
    files.push({
      path: "import/content/authors.json",
      contents: renderJson(
        authors.map((author) => ({
          wordpressSourceId: authorSourceId(author.login),
          collection: "authors",
          data: {
            name: author.name,
            slug: author.slug,
            wordpressLogin: author.login,
            wordpressSourceId: authorSourceId(author.login)
          }
        }))
      )
    });
  }

  if (mediaJobs.length > 0) {
    files.push({ path: "import/content/media.json", contents: renderJson(mediaJobs) });
  }

  for (const collection of collections.filter((entry) => entry.kind === "content")) {
    const jobs = contentJobs.filter((job) => job.collection === collection.slug);
    if (jobs.length > 0) {
      files.push({ path: `import/content/${collection.slug}.json`, contents: renderJson(jobs) });
    }
  }

  files.push({ path: "import/content/index.json", contents: renderContentIndex(contentJobs, mediaJobs, taxonomies, authors, collections) });
  return files;
}

/**
 * The importer reads this to know what to load and in what order: taxonomies
 * and authors first, then the media the content references, then the content
 * itself. Relationships resolve against the ids those passes recorded.
 */
function renderContentIndex(
  contentJobs: readonly ContentJob[],
  mediaJobs: readonly MediaJob[],
  taxonomies: readonly { domain: string; collection: string; terms: readonly WordPressTerm[] }[],
  authors: readonly { login: string; name: string; slug: string }[],
  collections: readonly PayloadCollection[]
): string {
  const files: { collection: string; file: string; count: number }[] = [];

  const taxonomyCounts = new Map<string, number>();
  for (const taxonomy of taxonomies) {
    taxonomyCounts.set(taxonomy.collection, (taxonomyCounts.get(taxonomy.collection) ?? 0) + taxonomy.terms.length);
  }
  for (const collection of [...taxonomyCounts.keys()].sort()) {
    files.push({ collection, file: `content/${collection}.json`, count: taxonomyCounts.get(collection) ?? 0 });
  }
  if (authors.length > 0) files.push({ collection: "authors", file: "content/authors.json", count: authors.length });
  if (mediaJobs.length > 0) files.push({ collection: "media", file: "content/media.json", count: mediaJobs.length });

  for (const collection of collections.filter((entry) => entry.kind === "content")) {
    const count = contentJobs.filter((job) => job.collection === collection.slug).length;
    if (count > 0) files.push({ collection: collection.slug, file: `content/${collection.slug}.json`, count });
  }

  return renderJson({ schemaVersion: "0.9", files });
}

/* -------------------------------------------------------------------------- */
/* Body HTML                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The HTML the rich-text conversion reads. Classic and Gutenberg records carry
 * it in `rawContent`; an Elementor record that stored its layout in widget
 * settings is rendered back to simple HTML from the parsed nodes.
 */
function recordBodyHtml(record: ContentRecord): string {
  if (record.rawContent.trim() !== "") return record.rawContent;
  return record.nodes.map(elementorNodeHtml).filter((value) => value !== "").join("\n");
}

function elementorNodeHtml(node: MigrationNode): string {
  if (node.rawHtml !== undefined && node.rawHtml.trim() !== "") return node.rawHtml;
  const children = node.children.map(elementorNodeHtml).filter((value) => value !== "").join("\n");

  if (node.source === "elementor") {
    switch (node.sourceType) {
      case "heading": {
        const title = stringAttribute(node, "title");
        const requested = stringAttribute(node, "header_size");
        const level = requested !== undefined && /^h[1-6]$/.test(requested) ? requested : "h2";
        return title === undefined ? children : `<${level}>${escapeHtml(title)}</${level}>`;
      }
      case "text-editor": {
        const editor = stringAttribute(node, "editor");
        return editor ?? children;
      }
      case "button": {
        const text = stringAttribute(node, "text");
        const href = nestedStringAttribute(node, "link", "url");
        return text !== undefined && href !== undefined && SAFE_HREF.test(href)
          ? `<p><a href="${escapeHtml(href)}">${escapeHtml(text)}</a></p>`
          : children;
      }
      case "divider":
        return "<hr />";
      case "spacer":
        return "";
      default:
        return children;
    }
  }

  return children;
}

function stringAttribute(node: MigrationNode, key: string): string | undefined {
  const value = node.attributes[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nestedStringAttribute(node: MigrationNode, key: string, nested: string): string | undefined {
  const value = node.attributes[key];
  if (value === null || typeof value !== "object") return undefined;
  const candidate = Reflect.get(value, nested);
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

/* -------------------------------------------------------------------------- */
/* Redirects, package, manifest                                               */
/* -------------------------------------------------------------------------- */

function renderNextRedirects(project: MigrationProject): string {
  return renderJson({
    schemaVersion: "0.9",
    generator: { name: GENERATOR_NAME, version: packageVersion, target: "payload" },
    redirects: nextRedirects(project)
  });
}

function nextRedirects(project: MigrationProject): object[] {
  const rules = JSON.parse(renderVercelRedirects(project)) as {
    redirects: { source: string; destination: string }[];
  };
  return rules.redirects.map(({ source, destination }) => ({
    source,
    destination,
    permanent: true
  }));
}

function renderNextConfig(project: MigrationProject): string {
  const redirects = nextRedirects(project);

  return `import { withPayload } from "@payloadcms/next/withPayload";

/** @type {import("next").NextConfig} */
const nextConfig = {
  skipTrailingSlashRedirect: true,
  async redirects() {
    // Generated by ${GENERATOR_NAME} ${packageVersion} from the WordPress
    // redirect map. Review before publishing; the same rules are also written
    // for Netlify, Vercel, nginx and Apache under migration/redirect-rules/.
    return ${renderJson(redirects).trimEnd()};
  }
};

export default withPayload(nextConfig);
`;
}

function renderPayloadPackageJson(project: MigrationProject): string {
  return renderJson({
    name: `${safeFileStem(project.site.title)}-payload`,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "npm run generate:importmap && next dev",
      build: "npm run generate:importmap && next build",
      start: "next start",
      "generate:importmap": "payload generate:importmap",
      import: "payload run import/import.mjs"
    },
    dependencies: {
      payload: payloadDependency,
      ...payloadAdminDependencies
    },
    devDependencies: {
      typescript: "^7.0.0",
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0"
    }
  });
}

/* -------------------------------------------------------------------------- */
/* The admin host                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The Next + Payload app that renders the admin. Payload 3 hands the editing
 * surface to a Next app, so a bundle that stops at `payload.config.js` can
 * import content but cannot be opened and edited. These are the files the
 * official blank template ships, written against Payload's own API — the
 * route handlers call `@payloadcms/next`, and nothing here is app-specific.
 *
 * `importMap.js` is a placeholder: \`npm run dev\`, \`npm run build\` and
 * \`npm run generate:importmap\` regenerate it from the config.
 */
function payloadAppFiles(): readonly DropFile[] {
  return [
    {
      path: ".env.example",
      contents: `# Copy to .env before running the bundle.
PAYLOAD_SECRET=replace-me-with-a-long-random-string
DATABASE_URI=file:./payload.db
`
    },
    {
      path: ".gitignore",
      contents: `node_modules
.next
next-env.d.ts
.env
.env.*
!.env.example
payload.db
payload.db-*
media
`
    },
    {
      path: "tsconfig.json",
      // Payload's own CLI resolves the config through tsconfig, so a bundle
      // without this file cannot run `payload generate:importmap`. Next
      // adjusts the file the first time it builds.
      contents: `${renderJson({
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
          plugins: [{ name: "next" }],
          paths: { "@payload-config": ["./payload.config.js"] }
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"]
      })}`
    },
    {
      path: "app/(payload)/custom.css",
      contents: `/* Admin styles. The Payload admin layout imports this file. */
`
    },
    {
      path: "app/(payload)/layout.jsx",
      contents: `import config from "../../payload.config.js";
import "@payloadcms/next/css";
import { handleServerFunctions, RootLayout } from "@payloadcms/next/layouts";

import { importMap } from "./admin/importMap.js";
import "./custom.css";

const serverFunction = async function (args) {
  "use server";
  return handleServerFunctions({ ...args, config, importMap });
};

const Layout = ({ children }) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
);

export default Layout;
`
    },
    {
      path: "app/(payload)/admin/importMap.js",
      contents: `/** @type {import("payload").ImportMap} */
export const importMap = {};
`
    },
    {
      path: "app/(payload)/admin/[[...segments]]/page.jsx",
      contents: `import config from "../../../../payload.config.js";
import { generatePageMetadata, RootPage } from "@payloadcms/next/views";

import { importMap } from "../importMap.js";

export const generateMetadata = ({ params, searchParams }) =>
  generatePageMetadata({ config, params, searchParams });

const Page = ({ params, searchParams }) => RootPage({ config, importMap, params, searchParams });

export default Page;
`
    },
    {
      path: "app/(payload)/admin/[[...segments]]/not-found.jsx",
      contents: `import config from "../../../../payload.config.js";
import { generatePageMetadata, NotFoundPage } from "@payloadcms/next/views";

import { importMap } from "../importMap.js";

export const generateMetadata = ({ params, searchParams }) =>
  generatePageMetadata({ config, params, searchParams });

const NotFound = ({ params, searchParams }) => NotFoundPage({ config, importMap, params, searchParams });

export default NotFound;
`
    },
    {
      path: "app/(payload)/api/[...slug]/route.js",
      contents: `import config from "../../../../payload.config.js";
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT
} from "@payloadcms/next/routes";

export const GET = REST_GET(config);
export const POST = REST_POST(config);
export const DELETE = REST_DELETE(config);
export const PATCH = REST_PATCH(config);
export const PUT = REST_PUT(config);
export const OPTIONS = REST_OPTIONS(config);
`
    },
    {
      path: "app/(payload)/api/graphql/route.js",
      contents: `import config from "../../../../payload.config.js";
import { GRAPHQL_POST, REST_OPTIONS } from "@payloadcms/next/routes";

export const POST = GRAPHQL_POST(config);
export const OPTIONS = REST_OPTIONS(config);
`
    },
    {
      path: "app/(payload)/api/graphql-playground/route.js",
      contents: `import config from "../../../../payload.config.js";
import { GRAPHQL_PLAYGROUND_GET } from "@payloadcms/next/routes";

export const GET = GRAPHQL_PLAYGROUND_GET(config);
`
    }
  ];
}

function renderPayloadManifest(
  project: MigrationProject,
  collections: readonly PayloadCollection[],
  contentJobs: readonly ContentJob[],
  mediaJobs: readonly MediaJob[]
): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  return renderJson({
    schemaVersion: "0.10",
    generator: { name: GENERATOR_NAME, version: packageVersion, target: "payload" },
    sourceSite: { title: project.site.title, ...(siteUrl === undefined ? {} : { url: siteUrl }) },
    destination: {
      target: "payload",
      kind: "cms",
      structure: "payload-next",
      payloadVersion: payloadDependency,
      config: "payload.config.js",
      admin: "app/(payload)",
      importer: "import/import.mjs",
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
      sourceTypes: collection.sourceTypes,
      fields: [...collection.fields.map((field) => field.name), "importSnapshot"],
      drop: collection.kind === "content" ? `import/content/${collection.slug}.json` : undefined
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

/* -------------------------------------------------------------------------- */
/* README                                                                     */
/* -------------------------------------------------------------------------- */

function renderPayloadReadme(project: MigrationProject): string {
  const siteUrl = project.site.url === undefined ? undefined : sanitizeSourceUrl(project.site.url);
  const delivery = project.media.delivery;
  const collections = project.types.filter((entry) => entry.included);
  const redirects = project.routes.redirects.length;
  const mediaLine =
    delivery === undefined
      ? "No media was delivered: this run was not given a local uploads directory."
      : `${delivery.summary.copied} delivered ${delivery.summary.copied === 1 ? "file" : "files"}, uploaded by the importer.`;

  return `# ${project.site.title} — Payload migration bundle

Generated from ${siteUrl ?? "a WordPress export"} by ${GENERATOR_NAME} ${packageVersion}.

This is a CMS destination, not a static site: it gives you collections to edit
in, media management, and a publishing workflow. The bundle is a Payload + Next
app — the collections, the config, the admin host, a content and media drop,
and the importer you run inside it. ${GENERATOR_NAME} itself never talks to a
database.

## Structure

* \`payload.config.js\` — the Payload config, built for Payload ${payloadDependency}.
* \`collections/\` — one module per collection: ${collections.map((entry) => entry.collection).join(", ") || "none"}, plus \`media\`, \`categories\`, \`tags\` and \`authors\`.
* \`app/\` — the Next + Payload admin host, so the bundle opens in a browser instead of only importing.
* \`tsconfig.json\` — what Payload's own CLI reads to find the config file.
* \`import/import.mjs\` — the generated importer. Run it with \`npm run import\`.
* \`import/content/\` — the drop: one file per collection, with \`{ "$ref": ... }\` markers the importer resolves.
* \`import/media/\` — ${mediaLine}
* \`import/redirects.json\` and \`next.config.mjs\` — the redirect map, in the shape a Next front end uses.
* \`migration/\` — the same review artifacts an Astro handoff writes: the repair queue, media, URLs, links, coverage, archives and menus.
* \`.env.example\`, \`.gitignore\` — copy the env file, and keep the database, the uploaded media and the build out of git.

## Run it

\`\`\`bash
npm install
cp .env.example .env        # then set PAYLOAD_SECRET
npm run import              # writes migration-import.json
npm run dev                 # the admin is at http://localhost:3000/admin
\`\`\`

Payload adds its own \`users\` collection for admin accounts, and the first one
is created in the browser. WordPress authors are not turned into logins: they
live in the \`authors\` collection, because \`dc:creator\` is a WordPress login
and creating accounts is a deployment decision.

The importer writes \`migration-import.json\`. Point verification at it, with a
content check too if you also built a front end:

\`\`\`bash
npx wp-migrate-core verify ../export.xml --import-report migration-import.json --fail-on blocker
\`\`\`

## What transferred

* Posts and pages from every included post type, with title, slug, route, dates, author, taxonomy and the source publication status mapped explicitly. Only WordPress \`publish\` becomes published in Payload. All other statuses, including \`future\` and \`private\`, remain drafts and keep their original \`wordpressStatus\`.
* Media from a supplied \`--uploads\` directory, uploaded into the media collection with the alt text the export carried.
* Images used inside the body. When the export ties an image to an upload this run delivered, it becomes a media node in the rich text instead of a note, so the picture is in the page as well as in the library.
* Rewritten internal links, and ${redirects === 0 ? "no redirect rules (this plan needs none)" : redirects === 1 ? "1 redirect rule" : `${redirects} redirect rules`} in the Next config and the host rule files.
* Stable source identifiers (\`wordpressSourceId\`, such as \`wp:post:20\`) so a re-import does not duplicate anything.

## What needs a human

* \`body\` is native rich text for the documented subset — headings, paragraphs, lists, quotes, code, links, emphasis and delivered images. Preformatted code uses code-formatted text with line breaks. Images with no delivered upload, embeds, forms, tables, shortcodes and layout containers become \`contentReview\` entries instead of being guessed at.
* \`sourceHtml\` keeps the exact HTML the export carried, so nothing is lost when a construct does not convert.
* The front end is yours to build. This bundle targets Payload plus a documented Next structure; it does not generate the site that renders it.

Re-imports check the latest CMS draft against the saved import snapshot. A
record you edited in the CMS is skipped and reported as \`record-modified\`.
When updating a 0.9.0 bundle, copy the regenerated collections along with the
importer to add \`importSnapshot\`. Older records whose prior values cannot
be established are skipped for review.

This bundle is written for Payload ${payloadDependency} and checked against it
with SQLite in the package's own \`npm run test:payload\` round trip: a real
import, a repeated import, a source update, CMS draft protection and media.
A migration of a real site remains the roadmap's validation gate.
`;
}

/* -------------------------------------------------------------------------- */
/* The generated importer                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The importer is a small, self-contained ESM file that runs inside the
 * destination project. It resolves the reference markers against ids it
 * created earlier, upserts by `wordpressSourceId`, and writes the import
 * report the verification step reads.
 */
export function renderPayloadImporter(project: MigrationProject): string {
  return `#!/usr/bin/env node
/**
 * Generated by ${GENERATOR_NAME} ${packageVersion} for ${JSON.stringify(project.site.title).replaceAll("*/", "* /")}.
 *
 * Runs inside the destination project with Payload's Local API. It reads the
 * drop in ./content, resolves every { "$ref": ... } marker against the ids
 * earlier passes created, and upserts each record by wordpressSourceId.
 *
 * Re-imports are safe: a record that has not changed is left alone, a record
 * whose source changed is updated, and a record somebody edited in the CMS is
 * skipped and reported rather than overwritten.
 *
 * Usage:  npm run import
 * Result: ./migration-import.json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPayload } from "payload";

import config from "../payload.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(here, "..");

/** Deterministic JSON, so the same document always hashes the same way. */
function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value === undefined ? null : value);
}

function managedFieldsHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Replace { "$ref": id } markers with the numeric ids earlier passes created. */
function resolveReferences(value, ids) {
  const missing = [];
  const visit = (input) => {
    if (Array.isArray(input)) return input.map(visit).filter((entry) => entry !== undefined);
    if (input && typeof input === "object") {
      if (typeof input.$ref === "string") {
        const id = ids[input.$ref];
        if (id === undefined) {
          missing.push(input.$ref);
          return undefined;
        }
        return id;
      }
      const out = {};
      for (const [key, entry] of Object.entries(input)) {
        const resolved = visit(entry);
        out[key] = resolved === undefined ? null : resolved;
      }
      return out;
    }
    return input;
  };
  return { data: visit(value), missing };
}

/** Compare imported fields, ignoring Payload's generated array row IDs. */
function projectFields(doc, data) {
  if (Array.isArray(data)) {
    return (doc ?? []).map((value, index) => projectFields(value, data[index] ?? value));
  }
  if (!data || typeof data !== "object") return doc ?? null;
  const out = {};
  for (const key of Object.keys(data)) out[key] = projectFields(doc?.[key], data[key]);
  return out;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function upsert(payload, entry, job, ids, counters, records) {
  const resolved = resolveReferences(job.data, ids);
  counters.unresolved += resolved.missing.length;
  const importHash = managedFieldsHash(resolved.data);
  const filePath = job.file === undefined ? undefined : resolve(bundleRoot, job.file);

  const found = await payload.find({
    collection: entry.collection,
    where: { wordpressSourceId: { equals: job.wordpressSourceId } },
    limit: 1,
    depth: 0,
    draft: true,
    pagination: false
  });
  const existing = found.docs[0];

  const base = {
    id: job.wordpressSourceId,
    sourceId: job.wordpressSourceId,
    postType: job.postType ?? null,
    collection: entry.collection,
    route: job.route ?? null,
    title: typeof resolved.data.title === "string" ? resolved.data.title : null
  };

  if (existing === undefined) {
    const created = await payload.create({
      collection: entry.collection,
      data: { ...resolved.data, importHash, importSnapshot: resolved.data },
      depth: 0,
      ...(filePath === undefined ? {} : { filePath })
    });
    ids[job.wordpressSourceId] = created.id;
    counters.created += 1;
    records.push({ ...base, action: "created", unresolved: resolved.missing });
    return;
  }

  ids[job.wordpressSourceId] = existing.id;

  const snapshot = existing.importSnapshot ?? resolved.data;
  const currentHash = managedFieldsHash(projectFields(existing, snapshot));
  const previousHash = existing.importSnapshot == null ? existing.importHash : managedFieldsHash(snapshot);
  if (currentHash !== previousHash) {
    counters.skipped += 1;
    records.push({ ...base, action: "skipped", reason: "record-modified", unresolved: resolved.missing });
    return;
  }

  if (existing.importHash === importHash) {
    counters.unchanged += 1;
    records.push({ ...base, action: "unchanged", unresolved: resolved.missing });
    return;
  }

  const cleared = {};
  for (const key of Object.keys(snapshot)) {
    if (!(key in resolved.data)) cleared[key] = Array.isArray(snapshot[key]) ? [] : null;
  }
  await payload.update({
    collection: entry.collection,
    id: existing.id,
    data: { ...cleared, ...resolved.data, importHash, importSnapshot: resolved.data },
    depth: 0,
    ...(filePath === undefined ? {} : { filePath })
  });
  counters.updated += 1;
  records.push({ ...base, action: "updated", unresolved: resolved.missing });
}

async function main() {
  const index = JSON.parse(await readFile(resolve(here, "content/index.json"), "utf8"));
  const payload = await getPayload({ config });
  try {
    const ids = {};
    const records = [];
    const counters = { planned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, unresolved: 0 };

    for (const entry of index.files) {
      const jobs = JSON.parse(await readFile(resolve(here, entry.file), "utf8"));
      for (const job of jobs) {
        counters.planned += 1;
        try {
          await upsert(payload, entry, job, ids, counters, records);
        } catch (error) {
          counters.failed += 1;
          records.push({
            id: job.wordpressSourceId,
            sourceId: job.wordpressSourceId,
            postType: job.postType ?? null,
            collection: entry.collection,
            route: job.route ?? null,
            title: null,
            action: "failed",
            reason: messageOf(error),
            unresolved: []
          });
        }
      }
    }

    const report = {
      schemaVersion: "0.9",
      generator: { name: "${GENERATOR_NAME}", version: "${packageVersion}", target: "payload" },
      generatedAt: new Date().toISOString(),
      destination: { target: "payload", kind: "cms", structure: "payload-next" },
      summary: counters,
      records
    };

    const reportPath = resolve(process.cwd(), "migration-import.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\\n");

    console.log(
      "Imported " + counters.planned + " record(s): " + counters.created + " created, " + counters.updated +
        " updated, " + counters.unchanged + " unchanged, " + counters.skipped + " skipped, " + counters.failed + " failed."
    );
    console.log("Import report: " + reportPath);
    if (counters.failed > 0) throw new Error(counters.failed + " record(s) failed to import.");
  } finally {
    await payload.destroy();
  }
}

await main().catch((error) => {
  console.error("wp-migrate-core import: " + messageOf(error));
  process.exit(1);
});
`;
}

/** The media delivery record, re-exported so the artifacts stay in one place. */
export type { ContentReviewItem };
