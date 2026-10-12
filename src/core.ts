import type {
  ArchiveKind,
  ArchivePage,
  ArchiveRouteSource,
  ArchiveSummary,
  ContentRecord,
  ContentTypeEntry,
  ConversionDisposition,
  FeedFile,
  InspectOptions,
  LinkReference,
  LinkReferenceKind,
  LinkReferenceStatus,
  LinkRewrite,
  LinkSummary,
  LiveUrlCoverage,
  LiveUrlEntry,
  LiveUrlShape,
  LiveUrlSource,
  LiveUrlStatus,
  LiveUrlSummary,
  MediaAsset,
  MediaReference,
  MediaReferenceKind,
  MediaReferenceStatus,
  MediaSummary,
  MenuItem,
  MenuItemKind,
  MenuSummary,
  MenuTree,
  MigrationArchives,
  MigrationConfig,
  MigrationMenus,
  MigrationIssue,
  MigrationIssueCode,
  MigrationLinks,
  MigrationMedia,
  MigrationNode,
  MigrationNodeKind,
  MigrationProject,
  MigrationRoutes,
  MigrationSummary,
  RedirectEntry,
  RouteEntry,
  RouteStatus,
  RouteSummary,
  SourceEditor,
  WordPressContentType,
  WordPressPostMeta,
  WordPressStatus,
  WordPressTerm
} from "./types.js";

interface MutableNode {
  id: string;
  source: MigrationNode["source"];
  sourceType: string;
  kind: MigrationNodeKind;
  conversion: ConversionDisposition;
  attributes: Record<string, unknown>;
  children: MutableNode[];
  text?: string;
  rawHtml?: string;
}

interface GutenbergFrame {
  readonly blockName: string;
  readonly node: MutableNode;
  readonly contentStart: number;
}

interface IssueCollector {
  readonly issues: MigrationIssue[];
  add(
    severity: MigrationIssue["severity"],
    code: MigrationIssueCode,
    message: string,
    requiredAction: string,
    details?: { readonly nodeId?: string; readonly evidence?: string }
  ): void;
}

const GUTENBERG_BLOCK_PATTERN =
  /<!--\s*(\/)?wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+(\{[\s\S]*?\}))?\s*(\/)?-->/gi;

const SHORTCODE_PATTERN = /\[(?!\/)([a-z][a-z0-9_-]*)(?:\s[^\]]*)?\]/gi;

const NATIVE_GUTENBERG_BLOCKS = new Map<
  string,
  { readonly kind: MigrationNodeKind; readonly conversion: ConversionDisposition }
>([
  ["core/paragraph", { kind: "paragraph", conversion: "native" }],
  ["core/heading", { kind: "heading", conversion: "native" }],
  ["core/list", { kind: "list", conversion: "native" }],
  ["core/list-item", { kind: "list", conversion: "native" }],
  ["core/quote", { kind: "quote", conversion: "native" }],
  ["core/code", { kind: "code", conversion: "native" }],
  ["core/preformatted", { kind: "code", conversion: "native" }],
  ["core/image", { kind: "image", conversion: "manual" }],
  ["core/gallery", { kind: "gallery", conversion: "manual" }],
  ["core/columns", { kind: "columns", conversion: "native" }],
  ["core/column", { kind: "column", conversion: "native" }],
  ["core/group", { kind: "group", conversion: "native" }],
  ["core/buttons", { kind: "group", conversion: "native" }],
  ["core/button", { kind: "button", conversion: "native" }],
  ["core/separator", { kind: "separator", conversion: "native" }],
  ["core/spacer", { kind: "spacer", conversion: "native" }],
  ["core/html", { kind: "html", conversion: "legacy-html" }],
  ["core/embed", { kind: "embed", conversion: "legacy-html" }],
  ["core/shortcode", { kind: "shortcode", conversion: "manual" }]
]);

const DYNAMIC_GUTENBERG_BLOCKS = new Set([
  "core/archives",
  "core/calendar",
  "core/categories",
  "core/latest-comments",
  "core/latest-posts",
  "core/loginout",
  "core/navigation",
  "core/post-comments-form",
  "core/post-template",
  "core/query",
  "core/query-no-results",
  "core/query-pagination",
  "core/query-pagination-next",
  "core/query-pagination-numbers",
  "core/query-pagination-previous",
  "core/rss",
  "core/search",
  "core/tag-cloud"
]);

const FORM_GUTENBERG_BLOCKS = new Set([
  "contact-form-7/contact-form-selector",
  "formidable/simple-form",
  "gravityforms/form",
  "jetpack/contact-form",
  "wpforms/form-selector"
]);

const ELEMENTOR_NATIVE_WIDGETS = new Map<string, MigrationNodeKind>([
  ["heading", "heading"],
  ["text-editor", "html"],
  ["button", "button"],
  ["divider", "separator"],
  ["spacer", "spacer"]
]);

const ELEMENTOR_FORM_WIDGETS = new Set(["form", "wp-widget-wpforms-widget", "wp-widget-gform_widget"]);

const ELEMENTOR_QUERY_WIDGETS = new Set([
  "archive-posts",
  "loop-carousel",
  "loop-grid",
  "portfolio",
  "posts",
  "products",
  "woocommerce-products"
]);

const BLOCKING_SHORTCODES = new Set([
  "contact-form-7",
  "elementor-template",
  "gravityform",
  "learndash_course_grid",
  "product",
  "products",
  "tutor_course",
  "woocommerce_cart",
  "woocommerce_checkout",
  "wpforms"
]);

const SAFE_ELEMENTOR_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Parse a bounded WXR export into a target-neutral migration model.
 *
 * This deliberately does not claim to be a complete XML or WordPress parser. It
 * is dependency-free so the conversion boundary stays visible.
 */
export function parseWxr(xml: string, options: InspectOptions = {}): MigrationProject {
  const records: ContentRecord[] = [];
  const projectIssues: MigrationIssue[] = [];
  const seenWordPressIds = new Set<number>();
  const pendingRoutes: PendingRoute[] = [];
  const config = options.config;
  const includeDrafts = options.includeDrafts === true || config?.includeDrafts === true;
  const matchedConfigKeys = {
    routes: new Set<string>(),
    exclusions: new Set<string>(),
    postTypes: new Set<string>()
  };
  const channelHeader = xml.slice(0, xml.search(/<item\b/i) === -1 ? xml.length : xml.search(/<item\b/i));
  const items = readWxrItems(xml);
  const untypedItems = items.filter((item) => item.postType === "");
  const typePolicy = buildTypePolicy(
    [...new Set(items.filter((item) => item.postType !== "").map((item) => item.postType))],
    config
  );
  for (const name of typePolicy.keys()) {
    matchedConfigKeys.postTypes.add(name);
  }
  const termRegistry = parseTermRegistry(channelHeader);

  // Attachments are collected first so content references can be matched
  // against them regardless of where the export places the attachment items.
  const baseAssets = buildMediaAssets(
    items.filter((item) => item.postType === "attachment").map((item) => item.xml)
  );
  const assetIndex = createMediaAssetIndex(baseAssets);

  for (const item of items) {
    const { xml: itemXml, postType } = item;
    const policy = typePolicy.get(postType);
    if (policy === undefined) {
      continue;
    }
    policy.sourceItems += 1;
    // WordPress internals keep no generated route here; a type the config
    // excluded is reported per item instead, so its live URLs still show up as
    // a decision rather than as a surprise.
    if (!policy.included && !policy.excludedByConfig) {
      continue;
    }

    const sourceUrl = cleanOptionalField(readTag(itemXml, "link"));
    const status = normalizeStatus(cleanField(readTag(itemXml, "wp:status")));
    if (!includeDrafts && status !== "publish") {
      pendingRoutes.push({
        id: `route:${pendingRoutes.length + 1}`,
        sourceUrl,
        status: "excluded",
        reason: `This scan reads published content only, so the ${status} item has no generated route.`
      });
      continue;
    }

    const rawId = cleanField(readTag(itemXml, "wp:post_id"));
    const wordpressId = parseWordPressId(rawId);
    if (wordpressId === undefined) {
      const missingId = rawId === "";
      projectIssues.push({
        id: `project:${missingId ? "WXR_ITEM_MISSING_ID" : "WXR_ITEM_INVALID_ID"}:${projectIssues.length + 1}`,
        severity: "warning",
        code: missingId ? "WXR_ITEM_MISSING_ID" : "WXR_ITEM_INVALID_ID",
        sourceId: "wp:unknown",
        title: missingId ? "WordPress item is missing its ID" : "WordPress item has an invalid ID",
        message: missingId
          ? `Skipped a ${postType} without a wp:post_id.`
          : `Skipped a ${postType} because wp:post_id must be a positive integer.`,
        requiredAction: missingId
          ? "Inspect the WXR export and restore the missing post identifier."
          : "Inspect the WXR export and restore a positive integer post identifier."
      });
      pendingRoutes.push({
        id: `route:${pendingRoutes.length + 1}`,
        sourceUrl,
        status: "skipped",
        reason: missingId
          ? "Skipped because the item has no wp:post_id."
          : "Skipped because wp:post_id is not a positive integer."
      });
      continue;
    }

    if (seenWordPressIds.has(wordpressId)) {
      projectIssues.push({
        id: `project:WXR_ITEM_DUPLICATE_ID:${projectIssues.length + 1}`,
        severity: "warning",
        code: "WXR_ITEM_DUPLICATE_ID",
        sourceId: `wp:${postType}:${wordpressId}`,
        title: "WordPress item repeats an existing ID",
        message: `Skipped a duplicate ${postType} with wp:post_id ${wordpressId}.`,
        requiredAction: "Inspect the WXR export and resolve the duplicate post identifier before migration."
      });
      pendingRoutes.push({
        id: `route:${pendingRoutes.length + 1}`,
        sourceId: `wp:${postType}:${wordpressId}`,
        sourceUrl,
        status: "skipped",
        reason: `Skipped because wp:post_id ${wordpressId} is used by an earlier item in this export.`
      });
      continue;
    }

    const sourceId = `wp:${postType}:${wordpressId}`;
    if (!policy.included) {
      pendingRoutes.push({
        id: `route:${pendingRoutes.length + 1}`,
        sourceId,
        sourceUrl,
        status: "excluded",
        reason: `${policy.reason ?? "The migration config leaves this content type out."} This item keeps no generated route.`
      });
      continue;
    }

    const keyForms = configKeyForms(sourceUrl, sourceId);
    const exclusion = firstConfiguredEntry(config?.exclude, keyForms);
    if (exclusion !== undefined) {
      matchedConfigKeys.exclusions.add(exclusion);
      pendingRoutes.push({
        id: `route:${pendingRoutes.length + 1}`,
        sourceId,
        sourceUrl,
        status: "excluded",
        reason: `The migration config excludes this item, which it names as "${configKeyLabel(exclusion)}".`
      });
      continue;
    }

    seenWordPressIds.add(wordpressId);
    const override = configuredRoute(config?.routes, keyForms);
    const parsedRecord = parseItem(itemXml, postType, status, wordpressId);
    const record =
      override === undefined ? parsedRecord : { ...parsedRecord, route: normalizeRoute(override.route) };
    if (override !== undefined) {
      matchedConfigKeys.routes.add(override.key);
    }

    records.push(record);
    pendingRoutes.push({
      id: `route:${pendingRoutes.length + 1}`,
      sourceId: record.sourceId,
      sourceUrl,
      record,
      ...(override === undefined ? {} : { override: override.route }),
      status: "generated",
      reason:
        override === undefined
          ? sourceUrl === undefined
            ? "Generated from the item slug because no permalink was exported."
            : "Generated from the exported permalink."
          : `The migration config decides this route, which it names as "${configKeyLabel(override.key)}". The exported permalink now redirects to it unless it was a query permalink.`
    });
  }

  if (records.length === 0) {
    projectIssues.push({
      id: "project:WXR_NO_ITEMS:1",
      severity: "warning",
      code: "WXR_NO_ITEMS",
      sourceId: "project",
      title: "No eligible WordPress content found",
      message: "The WXR input contains no content items included by the current scan settings.",
      requiredAction: "Confirm that the export includes published content. Drafts are excluded by default; library users can pass { includeDrafts: true } when appropriate, and postTypes.include can widen what a config brings across."
    });
  }

  if (untypedItems.length > 0) {
    projectIssues.push({
      id: "project:WXR_POST_TYPE_SKIPPED:untyped",
      severity: "warning",
      code: "WXR_POST_TYPE_SKIPPED",
      sourceId: "project",
      title: "Items without a WordPress post type",
      message: `${untypedItems.length} ${untypedItems.length === 1 ? "item carries" : "items carry"} no wp:post_type, so this scan cannot tell whether ${untypedItems.length === 1 ? "it is" : "they are"} content.`,
      requiredAction: "Inspect the export and restore the post type for each item, or confirm the migration does not need them."
    });
  }

  const types: ContentTypeEntry[] = [...typePolicy.values()].map((policy) => ({
    name: policy.name,
    label: policy.label,
    collection: policy.collection,
    sourceItems: policy.sourceItems,
    records: records.filter((record) => record.type === policy.name).length,
    included: policy.included,
    ...(policy.reason === undefined ? {} : { reason: policy.reason })
  }));

  for (const entry of types) {
    if (entry.included || entry.sourceItems === 0 || CONSUMED_POST_TYPES.has(entry.name)) {
      continue;
    }
    projectIssues.push({
      id: `project:WXR_POST_TYPE_SKIPPED:${entry.name}`,
      severity: "warning",
      code: "WXR_POST_TYPE_SKIPPED",
      sourceId: "project",
      title: `Content type "${entry.label}" is not part of this handoff`,
      message: `${entry.sourceItems} ${entry.sourceItems === 1 ? "item" : "items"} of type "${entry.name}" ${entry.sourceItems === 1 ? "was" : "were"} left out. ${entry.reason ?? ""}`.trim(),
      requiredAction: `Add "${entry.name}" to postTypes.include in the migration config to bring it across, or confirm this migration does not need it.`
    });
  }

  const source = compactOptionalObject({
    title: cleanOptionalField(readTag(channelHeader, "title")),
    url: cleanOptionalField(readTag(channelHeader, "link"))
  });
  const siteUrl = source.url;

  // Archive routes join the same route model as content, so coverage, links
  // and redirect rules never disagree about what the generated site serves.
  const archives = buildArchives({
    records,
    liveUrlSource: options.liveUrlSource,
    config,
    siteTitle: source.title,
    siteUrl
  });
  for (const page of archives.pages) {
    pendingRoutes.push({
      id: `route:${page.id}`,
      sourceId: page.id,
      ...(page.sourceUrl === undefined ? {} : { sourceUrl: page.sourceUrl }),
      status: "generated",
      override: page.route,
      reason: archiveRouteReason(page)
    });
  }
  for (const feed of archives.feeds) {
    pendingRoutes.push({
      id: `route:${feed.id}`,
      sourceId: feed.id,
      sourceUrl: feed.sourcePath ?? feed.path,
      status: "generated",
      override: feed.path,
      raw: true,
      reason: "This feed is written as a static file, so the address WordPress served needs a rule."
    });
  }
  if (config?.archives?.attachmentPages !== "ignore") {
    for (const asset of baseAssets) {
      if (asset.pagePath === undefined || asset.path === undefined || asset.pagePath === asset.path) {
        continue;
      }
      pendingRoutes.push({
        id: `route:attachment-page:${asset.wordpressId}`,
        sourceId: asset.id,
        sourceUrl: asset.pagePath,
        status: "generated",
        override: asset.path,
        raw: true,
        redirectOnly: true,
        reason:
          "WordPress served an attachment page for this upload, and the upload itself is the destination."
      });
    }
  }
  if (archives.feeds.length > 0 && (config?.site?.url ?? source.url) === undefined) {
    projectIssues.push({
      id: "project:SITE_URL_MISSING:1",
      severity: "warning",
      code: "SITE_URL_MISSING",
      sourceId: "project",
      title: "A feed was requested without a site URL",
      message:
        "This run was asked to write a feed, and neither the export nor the migration config carries a site URL, so the feed has no origin to point its entries at.",
      requiredAction:
        "Add site.url to the migration config, or remove the feed path from archives.feeds."
    });
  }

  const referencesByRecord = records.map((record) => collectMediaReferences(record, assetIndex));
  const routes = finalizeRoutes(pendingRoutes);
  const linkIndex = createLinkTargetIndex(routes.entries, siteUrl);
  const linkReferencesByRecord = records.map((record) => collectLinkReferences(record, linkIndex));
  const annotatedRecords = records.map((record, index) =>
    withLinkIssues(
      withMediaIssues(record, referencesByRecord[index] ?? []),
      linkReferencesByRecord[index] ?? []
    )
  );
  const menus = buildMenus({ items, records, archives, termRegistry, linkIndex });
  const links = finalizeLinks(linkReferencesByRecord.flat());
  const media = finalizeMedia(baseAssets, referencesByRecord.flat());
  const coverage = buildLiveUrlCoverage(
    options.liveUrlSource,
    routes,
    annotatedRecords,
    media.assets,
    siteUrl,
    config
  );
  const recordIssues = annotatedRecords.flatMap((record) => record.issues);
  const archiveIssues = createArchiveIssues(archives);
  const menuIssues = createMenuIssues(menus);
  const configIssues = createConfigIssues(config, matchedConfigKeys);
  const waivedCodes = new Set<string>(config?.ignoreIssues ?? []);
  // A waived finding stays in the plan: a reviewer can see what the config
  // accepted, while the summary and the `--fail-on` gate leave it out.
  const waive = (issue: MigrationIssue): MigrationIssue =>
    waivedCodes.has(issue.code) ? { ...issue, ignored: true } : issue;
  const finalRecords = annotatedRecords.map((record) => ({
    ...record,
    issues: record.issues.map(waive)
  }));
  const issues = [
    ...projectIssues,
    ...coverage.issues,
    ...archiveIssues,
    ...menuIssues,
    ...recordIssues,
    ...configIssues
  ].map(waive);
  const ignoredIssues = issues.filter((issue) => issue.ignored === true).length;
  const siteTargetUrl = config?.site?.url ?? siteUrl;

  return {
    site: {
      title: config?.site?.title ?? source.title ?? "WordPress migration",
      ...(siteTargetUrl === undefined ? {} : { url: siteTargetUrl })
    },
    source,
    records: finalRecords,
    issues,
    types,
    media,
    routes,
    links,
    coverage: coverage.coverage,
    archives,
    menus,
    ...(config === undefined
      ? {}
      : {
          config: {
            decisions: {
              routes: matchedConfigKeys.routes.size,
              exclusions: matchedConfigKeys.exclusions.size,
              ignoredIssues,
              ignoredIssueCodes: [...waivedCodes] as MigrationIssueCode[]
            }
          }
        }),
    summary: summarize(
      finalRecords,
      issues,
      media.summary,
      routes.summary,
      links.summary,
      types,
      archives.summary,
      menus.summary
    )
  };
}

export const inspectWxr = parseWxr;

/**
 * The names a migration config can use for one exported item: its content id,
 * the permalink as exported, and the path or query the permalink carries.
 *
 * A query permalink offers its query and its path-plus-query, never its bare
 * path: `?p=82` and the site root share a pathname, and letting the bare path
 * stand in for a query permalink would silently move the home page.
 */
function configKeyForms(sourceUrl: string | undefined, sourceId: string): readonly string[] {
  const forms = new Set<string>([sourceId]);
  const trimmed = sourceUrl?.trim() ?? "";
  if (trimmed === "") {
    return [...forms];
  }

  forms.add(trimmed);
  const sanitized = sanitizeSourceUrl(trimmed);

  if (trimmed.includes("?")) {
    const query = trimmed.slice(trimmed.indexOf("?"));
    forms.add(query);
    if (sanitized !== undefined) {
      const path = sourcePath(sanitized);
      if (path !== undefined) {
        forms.add(`${path}${query}`);
      }
    }
    return [...forms];
  }

  if (sanitized !== undefined) {
    forms.add(sanitized);
  }

  const path = sourcePath(trimmed);
  if (path !== undefined) {
    forms.add(path);
  }

  return [...forms];
}

/** Show config keys without copying URL credentials or query strings into artifacts. */
function configKeyLabel(key: string): string {
  if (/^wp:(?:page|post):\d+$/.test(key)) return key;
  if (/^[a-z][a-z0-9+.-]*:|^[/?\\]/i.test(key)) {
    return sanitizeSourceUrl(key) ?? "query permalink or invalid URL";
  }
  return key;
}

/** The first configured entry that names this item, in config order. */
function firstConfiguredEntry(
  configured: readonly string[] | undefined,
  keyForms: readonly string[]
): string | undefined {
  if (configured === undefined || configured.length === 0) {
    return undefined;
  }

  return configured.find((key) => keyForms.includes(key));
}

/** The decided route for this item, when the config names it. */
function configuredRoute(
  routes: Readonly<Record<string, string>> | undefined,
  keyForms: readonly string[]
): { readonly key: string; readonly route: string } | undefined {
  if (routes === undefined) {
    return undefined;
  }

  for (const [key, route] of Object.entries(routes)) {
    if (keyForms.includes(key)) {
      return { key, route };
    }
  }

  return undefined;
}

/**
 * A config entry that matched nothing is a decision the plan never applied:
 * usually a stale id, a permalink that has since been edited, or a typo. It is
 * reported rather than dropped, because a config that quietly does nothing is
 * the failure mode this file exists to prevent.
 */
function createConfigIssues(
  config: MigrationConfig | undefined,
  matched: {
    readonly routes: ReadonlySet<string>;
    readonly exclusions: ReadonlySet<string>;
    readonly postTypes: ReadonlySet<string>;
  }
): MigrationIssue[] {
  if (config === undefined) {
    return [];
  }

  const issues: MigrationIssue[] = [];
  const unmatched = (keys: ReadonlySet<string>, list: string): void => {
    for (const key of keys) {
      const message = `The migration config names "${configKeyLabel(key)}" in ${list}, and no exported item matches it.`;
      issues.push({
        id: `project:CONFIG_ENTRY_UNMATCHED:${issues.length + 1}`,
        severity: "warning",
        code: "CONFIG_ENTRY_UNMATCHED",
        sourceId: "project",
        title: "A migration config entry matched nothing",
        message,
        requiredAction: "Check the content id, path or permalink, or remove the entry so the config and the export agree."
      });
    }
  };

  unmatched(
    new Set(Object.keys(config.routes ?? {}).filter((key) => !matched.routes.has(key))),
    "routes"
  );
  unmatched(
    new Set((config.exclude ?? []).filter((key) => !matched.exclusions.has(key))),
    "exclude"
  );
  unmatched(
    new Set((config.postTypes?.include ?? []).filter((name) => !matched.postTypes.has(name))),
    "postTypes.include"
  );

  return issues;
}

/**
 * Post types that are not content pages. The first two are consumed elsewhere
 * in this run, so their absence from the generated pages is not a loss; the
 * rest are WordPress's own bookkeeping.
 */
const NON_CONTENT_POST_TYPES: Readonly<Record<string, string>> = {
  attachment: "Uploads become the media inventory rather than generated pages.",
  nav_menu_item: "Menu items become the generated navigation.",
  revision: "Revisions are editorial history, not content.",
  custom_css: "Customizer CSS belongs to the theme, not to a page.",
  customize_changeset: "Customizer drafts are not content.",
  oembed_cache: "WordPress caches embed responses for its own use.",
  wp_block: "Reusable blocks are page parts, inlined where they are used.",
  wp_navigation: "Block-theme navigation is stored as a menu, not as a page."
};

/** Types this run does something else with, so leaving them out is not a loss. */
const CONSUMED_POST_TYPES = new Set(["attachment", "nav_menu_item"]);

interface TypePolicy {
  readonly name: string;
  readonly label: string;
  readonly collection: string;
  readonly included: boolean;
  /** True when the migration config, rather than WordPress, left the type out. */
  readonly excludedByConfig: boolean;
  readonly reason?: string | undefined;
  sourceItems: number;
}

/**
 * The directory under `src/content/` a post type generates into. `page` and
 * `post` keep the names 0.1 wrote, so an existing handoff reads the same.
 */
export function contentCollectionName(postType: string): string {
  const slug = postType.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "page") return "pages";
  if (slug === "post") return "posts";
  if (slug === "") return "content";
  return slug.endsWith("s") ? slug : `${slug}s`;
}

/** A readable label for a post type slug, for reports and page listings. */
export function contentTypeLabel(postType: string): string {
  const words = postType.replace(/[_-]+/g, " ").trim();
  return words === "" ? postType : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which post types become content, and which do not.
 *
 * Default is everything the export carries that is actual content. A config
 * narrows that with an include list, an exclude list, or both, and every
 * decision leaves a reason behind so the plan can explain itself.
 */
function buildTypePolicy(
  postTypes: readonly string[],
  config: MigrationConfig | undefined
): Map<string, TypePolicy> {
  const include = config?.postTypes?.include;
  const exclude = config?.postTypes?.exclude ?? [];
  const usedCollections = new Map<string, string>([["listings", "archives"]]);
  const policies = new Map<string, TypePolicy>();

  for (const name of [...postTypes].sort()) {
    const configReason = exclude.includes(name)
      ? "The migration config leaves this type out."
      : include !== undefined && !include.includes(name)
        ? "The migration config lists the types to bring across, and this one is not in that list."
        : undefined;
    const internalReason = Object.hasOwn(NON_CONTENT_POST_TYPES, name) &&
      (CONSUMED_POST_TYPES.has(name) || !include?.includes(name))
      ? NON_CONTENT_POST_TYPES[name] : undefined;
    const reason = internalReason ?? configReason;

    policies.set(name, {
      name,
      label: contentTypeLabel(name),
      collection: uniqueCollectionName(name, usedCollections),
      included: reason === undefined,
      excludedByConfig: internalReason === undefined && configReason !== undefined,
      reason,
      sourceItems: 0
    });
  }

  return policies;
}

function uniqueCollectionName(name: string, used: Map<string, string>): string {
  const base = contentCollectionName(name);
  if (!used.has(base)) {
    used.set(base, name);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  const unique = `${base}-${suffix}`;
  used.set(unique, name);
  return unique;
}

interface TermRegistryEntry {
  readonly id: number;
  readonly taxonomy: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * The channel-level category, tag and term declarations. WordPress exports
 * these for the whole site, and they are the only place a term id can be
 * turned back into the slug a URL uses.
 */
function parseTermRegistry(channelHeader: string): ReadonlyMap<number, TermRegistryEntry> {
  const terms = new Map<number, TermRegistryEntry>();

  const collect = (
    pattern: RegExp,
    taxonomy: string | ((block: string) => string),
    slugTag: string,
    nameTag: string
  ): void => {
    for (const match of channelHeader.matchAll(pattern)) {
      const block = match[1] ?? "";
      const id = Number.parseInt(cleanField(readTag(block, "wp:term_id")), 10);
      const slug = cleanField(readTag(block, slugTag));
      if (!Number.isSafeInteger(id) || id <= 0 || slug === "") {
        continue;
      }
      const name = cleanField(readTag(block, nameTag));
      terms.set(id, {
        id,
        taxonomy: typeof taxonomy === "string" ? taxonomy : taxonomy(block),
        slug,
        name: name === "" ? slug : name
      });
    }
  };

  collect(/<wp:category\b[^>]*>([\s\S]*?)<\/wp:category>/gi, "category", "wp:category_nicename", "wp:cat_name");
  collect(/<wp:tag\b[^>]*>([\s\S]*?)<\/wp:tag>/gi, "post_tag", "wp:tag_slug", "wp:tag_name");
  collect(
    /<wp:term\b[^>]*>([\s\S]*?)<\/wp:term>/gi,
    (block) => cleanField(readTag(block, "wp:term_taxonomy")),
    "wp:term_slug",
    "wp:term_name"
  );

  return terms;
}

function parseItem(
  itemXml: string,
  type: WordPressContentType,
  status: WordPressStatus,
  wordpressId: number
): ContentRecord {
  const sourceId = `wp:${type}:${wordpressId}`;
  const route = cleanOptionalField(readTag(itemXml, "link"));
  const collector = createIssueCollector(sourceId, route);
  const rawContent = unwrapXmlValue(readTag(itemXml, "content:encoded"));
  const meta = parsePostMeta(itemXml);
  const elementorData = meta._elementor_data?.[0];
  const hasGutenberg = /<!--\s*wp:/i.test(rawContent);
  const hasElementor = typeof elementorData === "string" && elementorData.trim() !== "";
  const editor: SourceEditor = hasElementor ? (hasGutenberg ? "mixed" : "elementor") : hasGutenberg ? "gutenberg" : "classic";

  const nodes: MigrationNode[] = [];
  if (hasGutenberg) {
    nodes.push(...parseGutenberg(rawContent, sourceId, collector));
  } else if (rawContent.trim() !== "") {
    nodes.push(createClassicNode(rawContent, `${sourceId}:classic:1`));
  }

  if (hasElementor && elementorData !== undefined) {
    nodes.push(...parseElementor(elementorData, sourceId, collector));
  }

  scanShortcodes(rawContent, sourceId, collector);

  const title = cleanField(readTag(itemXml, "title"));
  const slug = cleanField(readTag(itemXml, "wp:post_name")) || slugify(title) || String(wordpressId);

  return {
    sourceId,
    wordpressId,
    type,
    status,
    title,
    slug,
    ...(route === undefined ? {} : { route }),
    ...optionalProperty(
      "publishedAt",
      cleanOptionalField(readTag(itemXml, "wp:post_date_gmt")) ?? cleanOptionalField(readTag(itemXml, "wp:post_date"))
    ),
    ...optionalProperty("publishedAtGmt", cleanOptionalField(readTag(itemXml, "wp:post_date_gmt"))),
    ...optionalProperty(
      "modifiedAt",
      cleanOptionalField(readTag(itemXml, "wp:post_modified_gmt")) ?? cleanOptionalField(readTag(itemXml, "wp:post_modified"))
    ),
    ...optionalProperty("author", cleanOptionalField(readTag(itemXml, "dc:creator"))),
    editor,
    rawContent,
    meta,
    terms: parseTerms(itemXml),
    nodes,
    issues: collector.issues
  };
}

function parseGutenberg(content: string, sourceId: string, collector: IssueCollector): MigrationNode[] {
  const roots: MutableNode[] = [];
  const stack: GutenbergFrame[] = [];
  let cursor = 0;
  let ordinal = 0;
  let match: RegExpExecArray | null;

  GUTENBERG_BLOCK_PATTERN.lastIndex = 0;
  while ((match = GUTENBERG_BLOCK_PATTERN.exec(content)) !== null) {
    if (stack.length === 0) {
      appendLooseHtml(content.slice(cursor, match.index), roots, sourceId, () => ++ordinal);
    }

    const closing = match[1] === "/";
    const blockName = normalizeBlockName(match[2] ?? "unknown");
    const selfClosing = match[4] === "/";

    if (closing) {
      const frame = stack.pop();
      if (frame === undefined || frame.blockName !== blockName) {
        collector.add(
          "warning",
          "GUTENBERG_UNMATCHED_CLOSE",
          `Found an unmatched closing marker for ${blockName}.`,
          "Inspect the original block markup and repair the affected content.",
          { evidence: match[0].slice(0, 160) }
        );
        if (frame !== undefined) {
          stack.push(frame);
        }
      } else {
        const rawHtml = content.slice(frame.contentStart, match.index).trim();
        if (rawHtml !== "") {
          frame.node.rawHtml = rawHtml;
          const text = htmlToText(rawHtml);
          if (text !== "") {
            frame.node.text = text;
          }
        }
      }
      cursor = GUTENBERG_BLOCK_PATTERN.lastIndex;
      continue;
    }

    const nodeId = `${sourceId}:gutenberg:${++ordinal}`;
    const attributes = parseBlockAttributes(match[3], blockName, nodeId, collector);
    const classification = classifyGutenbergBlock(blockName);
    const node: MutableNode = {
      id: nodeId,
      source: "gutenberg",
      sourceType: blockName,
      kind: classification.kind,
      conversion: classification.conversion,
      attributes,
      children: []
    };

    const parent = stack.at(-1)?.node;
    (parent?.children ?? roots).push(node);
    reportGutenbergCompatibility(node, collector);

    if (!selfClosing) {
      stack.push({ blockName, node, contentStart: GUTENBERG_BLOCK_PATTERN.lastIndex });
    }
    cursor = GUTENBERG_BLOCK_PATTERN.lastIndex;
  }

  if (stack.length === 0) {
    appendLooseHtml(content.slice(cursor), roots, sourceId, () => ++ordinal);
  } else {
    for (const frame of stack) {
      collector.add(
        "warning",
        "GUTENBERG_UNCLOSED_BLOCK",
        `Block ${frame.blockName} is missing its closing marker.`,
        "Repair the Gutenberg block markup or accept the preserved HTML fallback.",
        { nodeId: frame.node.id }
      );
      frame.node.conversion = "manual";
      const rawHtml = content.slice(frame.contentStart).trim();
      if (rawHtml !== "") {
        frame.node.rawHtml = rawHtml;
      }
    }
  }

  return roots;
}

function parseElementor(serialized: string, sourceId: string, collector: IssueCollector): MigrationNode[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeXmlEntities(serialized));
    if (typeof value === "string") {
      value = JSON.parse(value);
    }
  } catch (error: unknown) {
    collector.add(
      "blocker",
      "ELEMENTOR_INVALID_DATA",
      "Elementor data exists but is not valid JSON.",
      "Re-export the page from a working WordPress installation.",
      { evidence: error instanceof Error ? error.message : String(error) }
    );
    return [];
  }

  if (!Array.isArray(value)) {
    collector.add(
      "blocker",
      "ELEMENTOR_INVALID_DATA",
      "Elementor data does not contain the expected top-level element array.",
      "Extract _elementor_data from a working WordPress installation."
    );
    return [];
  }

  let ordinal = 0;
  return value.flatMap((element) => convertElementorElement(element, sourceId, collector, () => ++ordinal));
}

function convertElementorElement(
  value: unknown,
  sourceId: string,
  collector: IssueCollector,
  nextOrdinal: () => number
): MutableNode[] {
  if (!isUnknownRecord(value)) {
    return [];
  }

  const nodeId = `${sourceId}:elementor:${nextOrdinal()}`;
  const elementType = typeof value.elType === "string" ? value.elType : "unknown";
  const widgetType = typeof value.widgetType === "string" ? value.widgetType : undefined;
  const settings = isUnknownRecord(value.settings) ? value.settings : {};
  const childValues = Array.isArray(value.elements) ? value.elements : [];
  const children = childValues.flatMap((child) => convertElementorElement(child, sourceId, collector, nextOrdinal));

  if (elementType === "section" || elementType === "container") {
    return [createMutableNode(nodeId, "elementor", elementType, "section", "native", settings, children)];
  }

  if (elementType === "column") {
    return [createMutableNode(nodeId, "elementor", elementType, "column", "native", settings, children)];
  }

  if (elementType !== "widget" || widgetType === undefined) {
    const node = createMutableNode(nodeId, "elementor", elementType, "unknown", "manual", settings, children);
    collector.add(
      "warning",
      "ELEMENTOR_WIDGET_UNKNOWN",
      `Unknown Elementor element type ${elementType}.`,
      "Replace it with an Astro component or preserve its rendered HTML.",
      { nodeId, evidence: elementType }
    );
    return [node];
  }

  if (ELEMENTOR_FORM_WIDGETS.has(widgetType)) {
    const node = createMutableNode(nodeId, "elementor", widgetType, "form", "blocked", settings, children);
    collector.add(
      "blocker",
      "ELEMENTOR_FORM_UNSUPPORTED",
      `Elementor widget ${widgetType} submits data and cannot be migrated as static content.`,
      "Choose a form backend and rebuild this form explicitly.",
      { nodeId, evidence: widgetType }
    );
    return [node];
  }

  if (ELEMENTOR_QUERY_WIDGETS.has(widgetType)) {
    const node = createMutableNode(nodeId, "elementor", widgetType, "query", "blocked", settings, children);
    collector.add(
      "blocker",
      "ELEMENTOR_QUERY_UNSUPPORTED",
      `Elementor widget ${widgetType} depends on a WordPress query.`,
      "Map the query to an Astro content collection and verify its filtering and ordering.",
      { nodeId, evidence: widgetType }
    );
    return [node];
  }

  if (widgetType === "image") {
    const node = createMutableNode(nodeId, "elementor", widgetType, "image", "manual", settings, children);
    collector.add(
      "warning",
      "ELEMENTOR_IMAGE_REMOTE_MEDIA",
      "An Elementor image widget needs a file the generated site can serve.",
      "Deliver the image from the uploads directory or media host you supply, confirm its alternative text, and rebuild this widget.",
      { nodeId }
    );
    return [node];
  }

  if (widgetType === "button") {
    const href = getNestedString(settings, "link", "url");
    if (href !== undefined && !isSafeElementorHref(href)) {
      const node = createMutableNode(nodeId, "elementor", widgetType, "button", "manual", settings, children);
      collector.add(
        "warning",
        "ELEMENTOR_BUTTON_UNSAFE_URL",
        "Elementor button has an unsafe link and was withheld.",
        "Replace the link with an http, https, mailto, tel, or relative URL before publishing.",
        { nodeId }
      );
      return [node];
    }
  }

  const kind = ELEMENTOR_NATIVE_WIDGETS.get(widgetType);
  if (kind !== undefined) {
    const node = createMutableNode(nodeId, "elementor", widgetType, kind, kind === "html" ? "legacy-html" : "native", settings, children);
    const text = elementorWidgetText(widgetType, settings);
    if (text !== undefined) {
      node.text = text;
    }
    return [node];
  }

  const node = createMutableNode(nodeId, "elementor", widgetType, "unknown", "manual", settings, children);
  collector.add(
    "warning",
    "ELEMENTOR_WIDGET_UNKNOWN",
    `Elementor widget ${widgetType} has no supported adapter in this release.`,
    "Replace it with an Astro component or preserve its rendered HTML.",
    { nodeId, evidence: widgetType }
  );
  return [node];
}

function scanShortcodes(content: string, sourceId: string, collector: IssueCollector): void {
  SHORTCODE_PATTERN.lastIndex = 0;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = SHORTCODE_PATTERN.exec(content)) !== null) {
    const shortcode = (match[1] ?? "unknown").toLowerCase();
    if (seen.has(shortcode)) {
      continue;
    }
    seen.add(shortcode);
    const blocked = BLOCKING_SHORTCODES.has(shortcode);
    collector.add(
      blocked ? "blocker" : "warning",
      "SHORTCODE_UNSUPPORTED",
      `Shortcode [${shortcode}] cannot be executed by Astro.`,
      blocked
        ? "Choose a replacement integration and rebuild this behavior."
        : "Replace the shortcode or accept a static HTML fallback.",
      { evidence: match[0].slice(0, 200) }
    );
  }
}

function classifyGutenbergBlock(blockName: string): {
  readonly kind: MigrationNodeKind;
  readonly conversion: ConversionDisposition;
} {
  const native = NATIVE_GUTENBERG_BLOCKS.get(blockName);
  if (native !== undefined) {
    return native;
  }
  if (DYNAMIC_GUTENBERG_BLOCKS.has(blockName)) {
    return { kind: "query", conversion: "blocked" };
  }
  if (FORM_GUTENBERG_BLOCKS.has(blockName)) {
    return { kind: "form", conversion: "blocked" };
  }
  return { kind: "unknown", conversion: "manual" };
}

function reportGutenbergCompatibility(node: MutableNode, collector: IssueCollector): void {
  if (node.sourceType === "core/image" || node.sourceType === "core/gallery") {
    collector.add(
      "warning",
      "GUTENBERG_MEDIA_UNSUPPORTED",
      `Gutenberg ${node.sourceType === "core/image" ? "image" : "gallery"} media needs files the generated site can serve.`,
      "Deliver the media from the uploads directory or media host you supply, then confirm every file against the original page.",
      { nodeId: node.id, evidence: node.sourceType }
    );
    return;
  }

  if (DYNAMIC_GUTENBERG_BLOCKS.has(node.sourceType) || FORM_GUTENBERG_BLOCKS.has(node.sourceType)) {
    collector.add(
      "blocker",
      "GUTENBERG_DYNAMIC_BLOCK",
      `Dynamic Gutenberg block ${node.sourceType} depends on WordPress runtime behavior.`,
      "Map the block to an Astro data source and verify the generated behavior.",
      { nodeId: node.id, evidence: node.sourceType }
    );
    return;
  }

  if (node.sourceType === "core/shortcode") {
    collector.add(
      "warning",
      "SHORTCODE_UNSUPPORTED",
      "The Gutenberg Shortcode block cannot execute inside Astro.",
      "Replace the shortcode with static content or an explicit Astro integration.",
      { nodeId: node.id, evidence: node.sourceType }
    );
    return;
  }

  if (!NATIVE_GUTENBERG_BLOCKS.has(node.sourceType)) {
    collector.add(
      "warning",
      "GUTENBERG_UNKNOWN_BLOCK",
      `Gutenberg block ${node.sourceType} has no supported adapter in this release.`,
      "Add an adapter or preserve the block's rendered HTML.",
      { nodeId: node.id, evidence: node.sourceType }
    );
  }
}

function parseBlockAttributes(
  serialized: string | undefined,
  blockName: string,
  nodeId: string,
  collector: IssueCollector
): Record<string, unknown> {
  if (serialized === undefined || serialized.trim() === "") {
    return {};
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (isUnknownRecord(value)) {
      return value;
    }
  } catch (error: unknown) {
    collector.add(
      "warning",
      "GUTENBERG_INVALID_ATTRIBUTES",
      `Block ${blockName} contains invalid JSON attributes.`,
      "Repair the block attributes or accept the preserved HTML fallback.",
      { nodeId, evidence: error instanceof Error ? error.message : String(error) }
    );
  }
  return {};
}

function parsePostMeta(itemXml: string): WordPressPostMeta {
  const values: Record<string, string[]> = {};
  const pattern = /<wp:postmeta\b[^>]*>([\s\S]*?)<\/wp:postmeta>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(itemXml)) !== null) {
    const block = match[1] ?? "";
    const key = cleanField(readTag(block, "wp:meta_key"));
    if (key === "") {
      continue;
    }
    const value = unwrapXmlValue(readTag(block, "wp:meta_value"));
    (values[key] ??= []).push(value);
  }
  return values;
}

function parseTerms(itemXml: string): WordPressTerm[] {
  const terms: WordPressTerm[] = [];
  const pattern = /<category\b([^>]*)>([\s\S]*?)<\/category>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(itemXml)) !== null) {
    const attributes = match[1] ?? "";
    const domain = decodeXmlEntities(readAttribute(attributes, "domain") ?? "");
    const nicename = decodeXmlEntities(readAttribute(attributes, "nicename") ?? "");
    const name = cleanField(match[2] ?? "");
    terms.push({ domain, nicename, name });
  }
  return terms;
}

interface WxrItem {
  readonly xml: string;
  readonly postType: string;
}

interface PendingRoute {
  readonly id: string;
  readonly sourceId?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly record?: ContentRecord | undefined;
  readonly status: RouteStatus;
  readonly reason: string;
  /** The route a migration config decided, which overrides the permalink. */
  readonly override?: string | undefined;
  /**
   * True when the target already exists as a file and only the old address
   * needs a rule, as with an attachment page pointing at its upload.
   */
  readonly redirectOnly?: boolean | undefined;
  /**
   * True when the override is a file path rather than a route, so it must not
   * be given the trailing slash a page route carries.
   */
  readonly raw?: boolean | undefined;
}

interface MediaAssetDraft {
  readonly id: string;
  readonly wordpressId: number;
  readonly parentId?: number;
  readonly title: string;
  readonly path?: string;
  readonly pagePath?: string;
  readonly url?: string;
  readonly file?: string;
  readonly mimeType?: string;
  readonly altText?: string;
  readonly width?: number;
  readonly height?: number;
}

interface MediaAssetIndex {
  readonly byId: ReadonlyMap<number, MediaAssetDraft>;
  readonly byKey: ReadonlyMap<string, MediaAssetDraft | null>;
  readonly byVariant: ReadonlyMap<string, MediaAssetDraft | null>;
}

interface MediaCandidate {
  readonly kind: MediaReferenceKind;
  readonly url?: string | undefined;
  readonly id?: number | undefined;
  readonly altText?: string | undefined;
  readonly nodeId?: string | undefined;
}

/**
 * Normalize an exported permalink into the single route the handoff serves.
 * The parser and the generator share this so the plan, the manifest and the
 * redirect list always describe the same path.
 */
export function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  let pathname = sourcePath(trimmed) ?? (
    /^[a-z][a-z0-9+.-]*:|^[\/\\]{2}/i.test(trimmed) ? "/" : trimmed.split(/[?#]/, 1)[0] ?? "/"
  );
  pathname = pathname.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const segments = pathname.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

/**
 * Keep local review artifacts free of credentials, query strings and
 * fragments. Returns a path when the value is not an absolute http(s) URL.
 */
export function sanitizeSourceUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  try {
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    const pathname = trimmed.split(/[?#]/, 1)[0] ?? "";
    return /^\/(?![\/\\])/.test(pathname) ? pathname : undefined;
  }
}

/** Keep source path spelling intact: redirect rules must use the old URL. */
function sourcePath(value: string | undefined): string | undefined {
  const sanitized = sanitizeSourceUrl(value);
  if (sanitized === undefined) return undefined;
  try {
    return new URL(sanitized).pathname;
  } catch {
    return sanitized;
  }
}

function readWxrItems(xml: string): WxrItem[] {
  const items: WxrItem[] = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1] ?? "";
    items.push({ xml: itemXml, postType: cleanField(readTag(itemXml, "wp:post_type")) });
  }

  return items;
}

function buildMediaAssets(attachmentItems: readonly string[]): MediaAssetDraft[] {
  const assets: MediaAssetDraft[] = [];
  const seen = new Set<number>();

  for (const itemXml of attachmentItems) {
    const asset = parseAttachment(itemXml);
    if (asset === undefined || seen.has(asset.wordpressId)) {
      continue;
    }
    seen.add(asset.wordpressId);
    assets.push(asset);
  }

  return assets;
}

/**
 * Read one attachment item. WordPress stores media details in post meta, so
 * this is a targeted extraction of the documented keys, not a PHP
 * unserializer: `_wp_attachment_metadata` is PHP-serialized and only the file
 * name and the stored dimensions are read out of it.
 */
function parseAttachment(itemXml: string): MediaAssetDraft | undefined {
  const wordpressId = parseWordPressId(cleanField(readTag(itemXml, "wp:post_id")));
  if (wordpressId === undefined) {
    return undefined;
  }

  // Trashed uploads are not part of the site being migrated.
  if (normalizeStatus(cleanField(readTag(itemXml, "wp:status"))) === "trash") {
    return undefined;
  }

  const meta = parsePostMeta(itemXml);
  const file = cleanOptionalField(meta._wp_attached_file?.[0] ?? "");
  const metadata = meta._wp_attachment_metadata?.[0] ?? "";
  const attachmentUrl = cleanOptionalField(readTag(itemXml, "wp:attachment_url"));
  if (attachmentUrl === undefined && file === undefined) {
    return undefined;
  }

  const path = mediaPath(attachmentUrl) ?? mediaPath(file === undefined ? undefined : `/wp-content/uploads/${file}`);
  const pageUrl = cleanOptionalField(readTag(itemXml, "link"));
  const pagePath = urlHasQuery(pageUrl) ? undefined : sourcePath(pageUrl);

  return {
    id: `media:${wordpressId}`,
    wordpressId,
    ...optionalProperty("parentId", parseWordPressId(cleanField(readTag(itemXml, "wp:post_parent")))),
    title: cleanField(readTag(itemXml, "title")) || file || `Attachment ${wordpressId}`,
    ...optionalProperty("path", path),
    ...optionalProperty("pagePath", pagePath === path ? undefined : pagePath),
    ...optionalProperty("url", sanitizeSourceUrl(attachmentUrl)),
    ...optionalProperty("file", file),
    ...optionalProperty("mimeType", cleanOptionalField(readTag(itemXml, "wp:post_mime_type"))),
    ...optionalProperty("altText", cleanOptionalField(meta._wp_attachment_image_alt?.[0] ?? "")),
    ...optionalProperty("width", readSerializedInteger(metadata, "width")),
    ...optionalProperty("height", readSerializedInteger(metadata, "height"))
  };
}

function readSerializedInteger(metadata: string, key: string): number | undefined {
  if (metadata.trim() === "") {
    return undefined;
  }

  const match = new RegExp(`s:${key.length}:"${key}";i:([0-9]+);`).exec(metadata);
  const value = match?.[1];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function createMediaAssetIndex(assets: readonly MediaAssetDraft[]): MediaAssetIndex {
  const byId = new Map<number, MediaAssetDraft>();
  const byKey = new Map<string, MediaAssetDraft | null>();
  const byVariant = new Map<string, MediaAssetDraft | null>();

  const indexKey = (map: Map<string, MediaAssetDraft | null>, key: string, asset: MediaAssetDraft): void => {
    const existing = map.get(key);
    map.set(key, existing === undefined || existing === asset ? asset : null);
  };

  for (const asset of assets) {
    byId.set(asset.wordpressId, asset);
    const keys = new Set<string>();
    const uploadPath = asset.file === undefined ? undefined : `/wp-content/uploads/${asset.file}`;
    for (const value of [asset.url, asset.path, asset.file, uploadPath]) {
      const key = mediaKey(value);
      if (key !== undefined) {
        keys.add(key);
      }
    }

    for (const key of keys) {
      indexKey(byKey, key, asset);
      indexKey(byVariant, stripMediaVariants(key), asset);
    }
  }

  return { byId, byKey, byVariant };
}

function resolveMediaAsset(
  index: MediaAssetIndex,
  url: string | undefined,
  id: number | undefined
): MediaAssetDraft | undefined {
  if (id !== undefined) {
    const byId = index.byId.get(id);
    if (byId !== undefined) {
      return byId;
    }
  }

  const key = mediaKey(url);
  if (key === undefined) {
    return undefined;
  }

  if (index.byKey.has(key)) return index.byKey.get(key) ?? undefined;
  const variant = index.byVariant.get(stripMediaVariants(key));
  if (variant !== undefined) return variant ?? undefined;

  // A file-only attachment has no hostname to compare, but its upload path
  // still supplies evidence. Do not ignore a known, different source host.
  const path = mediaPath(url);
  if (path === undefined) return undefined;
  const pathMatch = index.byKey.has(path)
    ? index.byKey.get(path)
    : index.byVariant.get(stripMediaVariants(path));
  return pathMatch?.url === undefined ? pathMatch ?? undefined : undefined;
}

function collectMediaReferences(record: ContentRecord, index: MediaAssetIndex): MediaReference[] {
  const candidates = new Map<string, MediaCandidate>();

  const add = (candidate: MediaCandidate): void => {
    const trimmedUrl = candidate.url?.trim();
    const url = trimmedUrl === undefined || trimmedUrl === "" ? undefined : trimmedUrl;
    if (url !== undefined && isIgnoredMediaUrl(url)) {
      return;
    }
    if (url === undefined && candidate.id === undefined) {
      return;
    }

    const asset = resolveMediaAsset(index, url, candidate.id);
    const assetKey = asset?.id ?? mediaKey(url) ?? (candidate.id === undefined ? undefined : `id:${candidate.id}`);
    if (assetKey === undefined) {
      return;
    }
    const key = candidate.kind === "linked-file" ? `linked-file:${assetKey}` : assetKey;

    const existing = candidates.get(key);
    // The same asset is often described twice in one record: an attachment ID
    // in block or widget settings, then the rendered URL and alt text in the
    // markup. Keep the richer description instead of the first one seen.
    candidates.set(key, {
      kind: existing?.kind ?? candidate.kind,
      url: existing?.url ?? url,
      id: existing?.id ?? candidate.id,
      altText: existing?.altText ?? candidate.altText,
      nodeId: existing?.nodeId ?? candidate.nodeId
    });
  };

  // A non-image upload the content links to — a PDF, a price list, a zip — is
  // a file the site must keep serving, so it is tracked like an image. Only a
  // link the export carries an attachment for is recorded: a link to an upload
  // this export cannot vouch for stays a plain link rather than a false claim
  // that a file will be delivered.
  const addFileLink = (href: string, nodeId?: string): void => {
    if (resolveMediaAsset(index, href, undefined) === undefined) {
      return;
    }
    add({ kind: "linked-file", url: href, nodeId });
  };

  const visit = (node: MigrationNode): void => {
    addNodeMediaSettings(node, add);
    for (const child of node.children) {
      visit(child);
    }
    const widgetHtml = node.source === "elementor"
      ? stringAttribute(node.attributes, node.sourceType === "text-editor" ? "editor" : "html")
      : undefined;
    for (const html of [node.rawHtml, widgetHtml]) {
      if (html === undefined) continue;
      for (const image of scanHtmlImages(html)) {
        add({
          kind: mediaKindForNode(node),
          url: image.url,
          altText: image.altText,
          nodeId: node.id
        });
      }
      for (const href of scanHtmlFileLinks(html)) {
        addFileLink(href, node.id);
      }
    }
  };

  for (const href of scanHtmlFileLinks(record.rawContent)) {
    addFileLink(href);
  }
  for (const node of record.nodes) {
    visit(node);
  }

  const thumbnailId = parseWordPressId(cleanField(record.meta._thumbnail_id?.[0] ?? ""));
  if (thumbnailId !== undefined) {
    add({ kind: "featured-image", id: thumbnailId });
  }

  const references: MediaReference[] = [];
  for (const candidate of candidates.values()) {
    const asset = resolveMediaAsset(index, candidate.url, candidate.id);
    const altText = firstFilled(candidate.altText, asset?.altText);
    // A linked file is not an image, so it never needs alt text: it is matched
    // when the export carries it, and out of the export otherwise.
    const status: MediaReferenceStatus =
      candidate.kind === "linked-file"
        ? asset === undefined
          ? "not-in-export"
          : "matched"
        : asset === undefined
          ? "not-in-export"
          : altText === undefined
            ? "missing-alt-text"
            : "matched";

    references.push({
      id: `${record.sourceId}:media:${references.length + 1}`,
      sourceId: record.sourceId,
      ...optionalProperty("route", sanitizeSourceUrl(record.route)),
      ...optionalProperty("nodeId", candidate.nodeId),
      kind: candidate.kind,
      ...optionalProperty("path", mediaPath(candidate.url) ?? asset?.path),
      ...optionalProperty("url", sanitizeSourceUrl(candidate.url) ?? asset?.url),
      ...optionalProperty("altText", altText),
      ...optionalProperty("assetId", asset?.id),
      status
    });
  }

  return references;
}

function addNodeMediaSettings(
  node: MigrationNode,
  add: (candidate: MediaCandidate) => void
): void {
  if (node.source === "gutenberg" && node.sourceType === "core/image") {
    add({
      kind: "gutenberg-image",
      url: stringAttribute(node.attributes, "url"),
      id: numberAttribute(node.attributes, "id"),
      altText: stringAttribute(node.attributes, "alt"),
      nodeId: node.id
    });
    return;
  }

  if (node.source === "gutenberg" && node.sourceType === "core/gallery") {
    const images = node.attributes.images;
    if (Array.isArray(images)) {
      for (const image of images) {
        if (!isUnknownRecord(image)) {
          continue;
        }
        add({
          kind: "gutenberg-gallery",
          url: stringAttribute(image, "url"),
          id: numberAttribute(image, "id"),
          altText: stringAttribute(image, "alt"),
          nodeId: node.id
        });
      }
    }
    const ids = node.attributes.ids;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        add({ kind: "gutenberg-gallery", id: numberAttribute({ id }, "id"), nodeId: node.id });
      }
    }
    return;
  }

  if (node.source !== "elementor") {
    return;
  }

  const image = readElementorMediaSetting(node.attributes, "image");
  if (image !== undefined) {
    add({ ...image, kind: "elementor-image", nodeId: node.id });
  }
  const background = readElementorMediaSetting(node.attributes, "background_image");
  if (background !== undefined) {
    add({ ...background, kind: "elementor-background", nodeId: node.id });
  }
}

function readElementorMediaSetting(
  settings: Readonly<Record<string, unknown>>,
  key: string
): { readonly url?: string | undefined; readonly id?: number | undefined } | undefined {
  const value = settings[key];
  if (typeof value === "string" && value.trim() !== "") {
    return { url: value.trim() };
  }
  if (!isUnknownRecord(value)) {
    return undefined;
  }

  const url = stringAttribute(value, "url");
  const id = numberAttribute(value, "id");
  return url === undefined && id === undefined ? undefined : { url, id };
}

function mediaKindForNode(node: MigrationNode): MediaReferenceKind {
  if (node.source === "gutenberg" && node.sourceType === "core/gallery") {
    return "gutenberg-gallery";
  }
  if (node.source === "gutenberg" && node.sourceType === "core/image") {
    return "gutenberg-image";
  }
  if (node.source === "elementor" && node.kind === "image") {
    return "elementor-image";
  }
  return "html-image";
}

function scanHtmlImages(html: string): Array<{ readonly url: string; readonly altText?: string | undefined }> {
  const images: Array<{ readonly url: string; readonly altText?: string | undefined }> = [];
  const pattern = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0];
    const url = readHtmlAttribute(tag, "src");
    if (url === undefined) {
      continue;
    }
    images.push({ url, altText: readHtmlAttribute(tag, "alt") });
  }

  return images;
}

/**
 * Anchor targets that point at a file under the uploads directory. The check
 * is deliberately narrow — a link is only a candidate when its path sits in
 * `/wp-content/uploads/` — so navigation and page links are never mistaken
 * for deliverable files.
 */
function scanHtmlFileLinks(html: string): readonly string[] {
  const links: string[] = [];
  const pattern = /<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const href = readHtmlAttribute(match[0], "href");
    if (href === undefined || isIgnoredMediaUrl(href)) {
      continue;
    }
    const path = mediaPath(href);
    if (path === undefined || !path.toLowerCase().startsWith("/wp-content/uploads/")) {
      continue;
    }
    links.push(href);
  }

  return links;
}

export function readHtmlAttribute(tag: string, name: string): string | undefined {
  const pattern = /(?:^|\s)([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    if (match[1]?.toLowerCase() === name.toLowerCase()) {
      const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      return value === "" ? undefined : decodeXmlEntities(value);
    }
  }
  return undefined;
}

function stringAttribute(values: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberAttribute(values: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = values[key];
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  return typeof value === "string" ? parseWordPressId(value.trim()) : undefined;
}

function isIgnoredMediaUrl(url: string): boolean {
  return /^(?:data|blob|javascript|vbscript|mailto|tel):/i.test(url) || url.startsWith("#");
}

function firstFilled(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

/** Path of a source media reference, without query or fragment. */
export function mediaPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  const pathname = sourcePath(trimmed) ?? (
    /^[a-z][a-z0-9+.-]*:|^[\/\\]{2}/i.test(trimmed) ? "" : trimmed.split(/[?#]/, 1)[0] ?? ""
  );

  const normalized = safeDecodeUri(pathname).replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (normalized === "") {
    return undefined;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/**
 * Exact lookup key. Keep filename case and known hosts distinct; variant
 * matching is a fallback only when it identifies one attachment.
 */
function mediaKey(value: string | undefined): string | undefined {
  const path = mediaPath(value);
  if (path === undefined) {
    return undefined;
  }

  const sanitized = sanitizeSourceUrl(value);
  try {
    return `${new URL(sanitized ?? "").host}${path}`;
  } catch {
    return path;
  }
}

export function stripMediaVariants(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "")
      .replace(/-(?:scaled|rotated|cropped)(?=\.[a-z0-9]+$)/i, "")
      .replace(/-e\d{9,}(?=\.[a-z0-9]+$)/i, "");
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withMediaIssues(record: ContentRecord, references: readonly MediaReference[]): ContentRecord {
  const issues = createMediaIssues(record, references);
  return issues.length === 0 ? record : { ...record, issues: [...record.issues, ...issues] };
}

/**
 * Media findings stay aggregated per content record: one entry per problem
 * kind, while `migration/media.json` carries the per-asset detail. That keeps
 * the repair queue readable on sites with thousands of uploads.
 */
function createMediaIssues(record: ContentRecord, references: readonly MediaReference[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const missingAltText = references.filter((reference) => reference.status === "missing-alt-text").length;
  const notInExport = references.filter((reference) => reference.status === "not-in-export").length;

  if (missingAltText > 0) {
    const message = `${missingAltText} referenced media ${missingAltText === 1 ? "item has" : "items have"} no alternative text.`;
    issues.push({
      id: `${record.sourceId}:MEDIA_MISSING_ALT_TEXT:${record.issues.length + issues.length + 1}`,
      severity: "warning",
      code: "MEDIA_MISSING_ALT_TEXT",
      sourceId: record.sourceId,
      ...optionalProperty("route", record.route),
      title: message,
      message,
      requiredAction: "Write alternative text for each referenced media item; the media inventory in this handoff lists them."
    });
  }

  if (notInExport > 0) {
    const message = `${notInExport} referenced media ${notInExport === 1 ? "item is" : "items are"} not present as attachment items in this export.`;
    issues.push({
      id: `${record.sourceId}:MEDIA_MISSING_FROM_EXPORT:${record.issues.length + issues.length + 1}`,
      severity: "warning",
      code: "MEDIA_MISSING_FROM_EXPORT",
      sourceId: record.sourceId,
      ...optionalProperty("route", record.route),
      title: message,
      message,
      requiredAction: "Import these assets from the source site or remove the references; the media inventory lists each source URL."
    });
  }

  return issues;
}

function finalizeMedia(
  assets: readonly MediaAssetDraft[],
  references: readonly MediaReference[]
): MigrationMedia {
  const referencedBy = new Map<string, Set<string>>();
  for (const reference of references) {
    if (reference.assetId === undefined) {
      continue;
    }
    const records = referencedBy.get(reference.assetId) ?? new Set<string>();
    records.add(reference.sourceId);
    referencedBy.set(reference.assetId, records);
  }

  const finalAssets: MediaAsset[] = assets.map((asset) => {
    const sourceIds = [...(referencedBy.get(asset.id) ?? [])].sort();
    return { ...asset, referenceCount: sourceIds.length, referencedBy: sourceIds };
  });

  const summary: MediaSummary = {
    assets: finalAssets.length,
    referenced: finalAssets.filter((asset) => asset.referenceCount > 0).length,
    references: references.length,
    matched: references.filter((reference) => reference.status === "matched").length,
    missingAltText: references.filter((reference) => reference.status === "missing-alt-text").length,
    notInExport: references.filter((reference) => reference.status === "not-in-export").length,
    unusedAssets: finalAssets.filter((asset) => asset.referenceCount === 0).length
  };

  return { assets: finalAssets, references, summary };
}

function finalizeRoutes(pending: readonly PendingRoute[]): MigrationRoutes {
  const targets = pending.map((entry) =>
    entry.override !== undefined
      ? entry.raw === true
        ? entry.override
        : normalizeRoute(entry.override)
      : entry.record === undefined
        ? undefined
        : targetRouteFor(entry.record)
  );
  const targetCounts = new Map<string, number>();
  pending.forEach((entry, index) => {
    const target = entry.redirectOnly === true ? undefined : targets[index];
    if (target !== undefined) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    }
  });

  const entries: RouteEntry[] = [];
  const redirects: RedirectEntry[] = [];

  pending.forEach((pendingRoute, index) => {
    const targetRoute = targets[index];
    const exportedPath = sourcePath(pendingRoute.sourceUrl);

    // An attachment page needs a rule, not a route: the file it points at is
    // already part of the generated site.
    if (pendingRoute.redirectOnly === true) {
      if (
        exportedPath !== undefined &&
        targetRoute !== undefined &&
        exportedPath !== targetRoute &&
        !urlHasQuery(pendingRoute.sourceUrl)
      ) {
        redirects.push({
          id: `redirect:${redirects.length + 1}`,
          ...optionalProperty("sourceId", pendingRoute.sourceId),
          sourcePath: exportedPath,
          targetRoute,
          reason: pendingRoute.reason
        });
      }
      return;
    }

    const collides = targetRoute !== undefined && (targetCounts.get(targetRoute) ?? 0) > 1;
    // A configuration decision answers the permalink question, so a query URL
    // it decided is no longer waiting on a human.
    const ambiguous =
      pendingRoute.override === undefined && statusIsAmbiguousUrl(pendingRoute.status, pendingRoute.sourceUrl);
    const status: RouteStatus = collides ? "duplicate-route" : ambiguous ? "ambiguous-url" : pendingRoute.status;
    const reason = collides
      ? `Another content item also maps to ${targetRoute ?? "this route"}, and the generated site can serve only one page per route.`
      : ambiguous
        ? "The exported URL uses a query string, so it needs a permalink decision instead of a path rule."
        : pendingRoute.reason;

    entries.push({
      id: pendingRoute.id,
      ...optionalProperty("sourceId", pendingRoute.sourceId),
      ...optionalProperty("sourceUrl", sanitizeSourceUrl(pendingRoute.sourceUrl)),
      ...optionalProperty("sourcePath", exportedPath),
      ...optionalProperty("targetRoute", targetRoute),
      status,
      reason
    });

    // A path rule cannot match a query string, so a decided query permalink
    // gets its route without a redirect this tool could publish.
    if (
      status === "generated" &&
      exportedPath !== undefined &&
      targetRoute !== undefined &&
      exportedPath !== targetRoute &&
      !urlHasQuery(pendingRoute.sourceUrl)
    ) {
      redirects.push({
        id: `redirect:${redirects.length + 1}`,
        ...optionalProperty("sourceId", pendingRoute.sourceId),
        sourcePath: exportedPath,
        targetRoute,
        reason: sameRouteIgnoringTrailingSlash(exportedPath, targetRoute)
          ? "The generated route adds the trailing slash used by the handoff."
          : "The generated route differs from the exported URL."
      });
    }
  });

  const summary: RouteSummary = {
    sourceUrls: entries.filter((entry) => entry.sourcePath !== undefined || entry.sourceUrl !== undefined).length,
    generated: entries.filter((entry) => entry.status === "generated").length,
    redirects: redirects.length,
    withoutTarget: entries.filter((entry) => entry.sourceUrl !== undefined && entry.status !== "generated").length,
    duplicateRoutes: entries.filter((entry) => entry.status === "duplicate-route").length
  };

  return { entries, redirects, summary };
}

function statusIsAmbiguousUrl(status: RouteStatus, sourceUrl: string | undefined): boolean {
  return status === "generated" && urlHasQuery(sourceUrl);
}

function urlHasQuery(sourceUrl: string | undefined): boolean {
  return sourceUrl !== undefined && sourceUrl.includes("?");
}

function sameRouteIgnoringTrailingSlash(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function targetRouteFor(record: ContentRecord): string {
  return normalizeRoute(record.route ?? `/${record.slug}/`);
}

interface LiveUrlIndexes {
  /** Generated route targets, keyed by the exact path they serve. */
  readonly routeTargets: ReadonlyMap<string, string>;
  /** Generated route targets, keyed by path without a trailing slash. */
  readonly routeVariants: ReadonlyMap<string, string>;
  /** Proposed redirect rules, keyed by the path they match. */
  readonly redirects: ReadonlyMap<string, RedirectEntry>;
  /** Exported URLs the map left without a confirmed route. */
  readonly unresolved: ReadonlyMap<string, RouteEntry>;
  /** Hosts that belong to the site being migrated. */
  readonly siteHosts: ReadonlySet<string>;
  /** Terms the export carries, keyed by slug and name. */
  readonly terms: ReadonlyMap<string, WordPressTerm>;
  /** Upload paths the export carries attachment records for. */
  readonly mediaPaths: ReadonlySet<string>;
  /** What this run generates, so an explanation can say what is missing. */
  readonly archives: {
    readonly taxonomies: boolean;
    readonly authors: boolean;
    readonly dates: boolean;
    readonly feeds: boolean;
    readonly paginated: boolean;
  };
}

interface ParsedLiveUrl {
  readonly key?: string | undefined;
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly path?: string | undefined;
  readonly hasQuery: boolean;
  readonly invalidReason?: string | undefined;
}

/**
 * Compare the live URLs a caller supplied with the routes and redirect rules
 * this plan proposes. The check is a path comparison against files the caller
 * already has: it requests nothing, so it cannot tell whether a live URL still
 * returns a page, what it redirects to today, or what a URL serves that is not
 * in the supplied source.
 */
function buildLiveUrlCoverage(
  source: LiveUrlSource | undefined,
  routes: MigrationRoutes,
  records: readonly ContentRecord[],
  assets: readonly MediaAsset[],
  siteUrl: string | undefined,
  config: MigrationConfig | undefined
): { readonly coverage: LiveUrlCoverage; readonly issues: readonly MigrationIssue[] } {
  if (source === undefined) {
    return { coverage: emptyLiveUrlCoverage(), issues: [] };
  }

  const indexes = createLiveUrlIndexes(routes, records, assets, siteUrl, config);
  const entries: LiveUrlEntry[] = [];
  const seen = new Set<string>();

  source.urls.forEach((value) => {
    const parsed = parseLiveUrl(value);
    if (parsed.key !== undefined) {
      // One URL can appear in several sitemaps and over both schemes. The host
      // and the exact path decide, so a scheme difference does not create a
      // second check, and a trailing slash still does.
      if (seen.has(parsed.key)) {
        return;
      }
      seen.add(parsed.key);
    }

    entries.push({
      id: `live-url:${entries.length + 1}`,
      ...classifyLiveUrl(parsed, indexes)
    });
  });

  return {
    coverage: { entries, summary: summarizeLiveUrlCoverage(entries, source) },
    issues: createLiveUrlIssues(source, entries)
  };
}

function emptyLiveUrlCoverage(): LiveUrlCoverage {
  return {
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
  };
}

function createLiveUrlIndexes(
  routes: MigrationRoutes,
  records: readonly ContentRecord[],
  assets: readonly MediaAsset[],
  siteUrl: string | undefined,
  config: MigrationConfig | undefined
): LiveUrlIndexes {
  const routeTargets = new Map<string, string>();
  const routeVariants = new Map<string, string>();
  const redirects = new Map<string, RedirectEntry>();
  const unresolved = new Map<string, RouteEntry>();

  // Source permalink ambiguity does not prevent conversion from writing the
  // record's generated route. Only colliding generated routes lack a page.
  const targetCounts = new Map<string, number>();
  for (const record of records) {
    const target = targetRouteFor(record);
    targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }
  for (const [target, count] of targetCounts) {
    if (count === 1) {
      routeTargets.set(target, target);
      routeVariants.set(livePathKey(target), target);
    }
  }

  // Archive and feed routes have no record of their own, and they serve live
  // URLs all the same, so coverage has to see them too.
  for (const entry of routes.entries) {
    if (entry.status !== "generated" || entry.targetRoute === undefined) {
      continue;
    }
    if (!routeTargets.has(entry.targetRoute)) {
      routeTargets.set(entry.targetRoute, entry.targetRoute);
    }
    if (!routeVariants.has(livePathKey(entry.targetRoute))) {
      routeVariants.set(livePathKey(entry.targetRoute), entry.targetRoute);
    }
  }

  for (const entry of routes.entries) {
    if (entry.status === "generated" || entry.status === "ambiguous-url") {
      continue;
    }

    // Several items can share one path. The first explanation is kept so the
    // report stays stable between runs.
    if (entry.sourcePath !== undefined && !unresolved.has(entry.sourcePath)) {
      unresolved.set(entry.sourcePath, entry);
    }
  }

  for (const redirect of routes.redirects) {
    redirects.set(redirect.sourcePath, redirect);
  }

  const siteHosts = new Set<string>();
  const addHost = (value: string | undefined): void => {
    try {
      siteHosts.add(new URL(sanitizeSourceUrl(value) ?? "").host);
    } catch {
      // Relative or malformed source URLs cannot establish a site host.
    }
  };
  addHost(siteUrl);
  if (siteHosts.size === 0) {
    for (const entry of routes.entries) addHost(entry.sourceUrl);
  }

  const terms = new Map<string, WordPressTerm>();
  for (const term of records.flatMap((record) => record.terms)) {
    for (const key of [term.nicename, term.name]) {
      const normalized = key.trim().toLowerCase();
      if (normalized !== "" && !terms.has(normalized)) {
        terms.set(normalized, term);
      }
    }
  }

  const mediaPaths = new Set<string>();
  for (const asset of assets) {
    if (asset.path !== undefined) {
      mediaPaths.add(livePathKey(asset.path));
    }
  }

  const archives = config?.archives;
  return {
    routeTargets,
    routeVariants,
    redirects,
    unresolved,
    siteHosts,
    terms,
    mediaPaths,
    archives: {
      taxonomies: archives?.taxonomies !== false,
      authors: archives?.authors !== false,
      dates: archives?.dates === true,
      feeds: (archives?.feeds?.length ?? 0) > 0,
      paginated: archives?.perPage !== undefined
    }
  };
}

/**
 * Read one entry as a URL. Reported values never carry credentials, a query
 * string or a fragment, and an entry that cannot be read is never echoed.
 */
function parseLiveUrl(value: string): ParsedLiveUrl {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { hasQuery: false, invalidReason: "The entry is empty." };
  }

  const relative = trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\");
  let url: URL;
  try {
    url = relative ? new URL(trimmed, "https://live-url.invalid") : new URL(trimmed);
  } catch {
    return { hasQuery: false, invalidReason: "The entry is not an absolute URL or a site-relative path." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      hasQuery: false,
      invalidReason: "The entry uses a scheme other than HTTP or HTTPS, which this check does not compare."
    };
  }

  const hasQuery = url.search !== "";
  const path = url.pathname === "" ? "/" : url.pathname;
  return {
    // Retain query identity for counting without exposing its contents in artifacts.
    key: `${relative ? "path:" : url.host}|${path}|${url.search}`,
    // Built from parts: this cannot carry credentials, a query or a fragment.
    url: relative ? path : `${url.protocol}//${url.host}${path}`,
    ...(relative ? {} : { host: url.host }),
    path,
    hasQuery
  };
}

function classifyLiveUrl(
  parsed: ParsedLiveUrl,
  indexes: LiveUrlIndexes
): Omit<LiveUrlEntry, "id"> {
  const shared = {
    ...optionalProperty("url", parsed.url),
    ...optionalProperty("host", parsed.host),
    ...optionalProperty("path", parsed.path),
    hasQuery: parsed.hasQuery
  };

  if (parsed.invalidReason !== undefined) {
    return { ...shared, status: "invalid-url", reason: parsed.invalidReason };
  }

  if (parsed.host !== undefined && indexes.siteHosts.size > 0 && !indexes.siteHosts.has(parsed.host)) {
    return {
      ...shared,
      status: "external-host",
      reason: `${parsed.host} is a different host from the site this export describes, so this plan cannot account for it.`
    };
  }

  if (parsed.hasQuery) {
    return {
      ...shared,
      status: "excluded-shape",
      shape: "query-url",
      reason: "The URL carries a query string, and a path rule cannot match a query. This permalink needs its own decision."
    };
  }

  const key = parsed.path ?? "/";

  // A trailing slash is part of the URL on a static host, so both the route
  // and the rule are matched exactly before anything is called covered.
  const targetRoute = indexes.routeTargets.get(key);
  if (targetRoute !== undefined) {
    return {
      ...shared,
      status: "routed",
      targetRoute,
      reason: "A generated page serves this path."
    };
  }

  const redirect = indexes.redirects.get(key);
  if (redirect !== undefined) {
    return {
      ...shared,
      status: "redirected",
      targetRoute: redirect.targetRoute,
      reason: `The redirect map already proposes a rule for this path: ${redirect.reason} Publish that rule on whatever hosts the new site.`
    };
  }

  const unresolved = indexes.unresolved.get(key);
  if (unresolved !== undefined) {
    return {
      ...shared,
      status: "unresolved",
      ...optionalProperty("targetRoute", unresolved.targetRoute),
      sourceStatus: unresolved.status,
      reason: `The export declares this URL, and the URL map left it without a confirmed route. ${unresolved.reason}`
    };
  }

  const shape = recognizeWordPressShape(parsed.path ?? "/", indexes);
  if (shape !== undefined) {
    return { ...shared, status: "excluded-shape", shape: shape.shape, reason: shape.reason };
  }

  const variant = indexes.routeVariants.get(livePathKey(key));
  if (variant !== undefined) {
    return {
      ...shared,
      status: "uncovered",
      targetRoute: variant,
      reason: `A generated route serves this path as ${variant}, and nothing serves the URL as it is written here. Add a trailing-slash rule, or confirm that the host resolves both spellings.`
    };
  }

  return {
    ...shared,
    status: "uncovered",
    reason: "Nothing in this plan serves this path: there is no generated route and no redirect rule."
  };
}

/**
 * Recognize the WordPress URLs that never become a static route, so they are
 * listed as a decision instead of being reported as a missing page.
 */
function recognizeWordPressShape(
  path: string,
  indexes: LiveUrlIndexes
): { readonly shape: LiveUrlShape; readonly reason: string } | undefined {
  const key = livePathKey(path);
  const segments = key === "/" ? [] : key.slice(1).split("/");
  if (segments.length === 0) {
    return undefined;
  }

  const lower = segments.map((segment) => segment.toLowerCase());
  const lowerPath = key.toLowerCase();
  const base = lower[0] ?? "";

  if (lower[lower.length - 1] === "feed") {
    return {
      shape: "feed",
      reason: indexes.archives.feeds
        ? "This feed path is not one of the feeds this run writes; check the feeds list in the migration config."
        : "This run writes no feed, so the address WordPress served has nothing behind it. Add the path to archives.feeds in the migration config to serve one."
    };
  }

  if (lowerPath.startsWith("/wp-content/uploads/") || indexes.mediaPaths.has(key)) {
    return {
      shape: "media-file",
      reason: indexes.mediaPaths.has(key)
        ? "This is an upload the export carries, and it is listed in the media inventory."
        : "This looks like an upload file, and the export carries no attachment record for this path."
    };
  }

  if (isWordPressEndpoint(lowerPath, lower)) {
    return {
      shape: "wordpress-endpoint",
      reason: "WordPress serves this path and a static handoff has no equivalent, so retire it or redirect it deliberately."
    };
  }

  if ((base === "category" || base === "tag" || base === "post_tag") && segments.length >= 2) {
    const term = indexes.terms.get((lower[1] ?? "").toLowerCase());
    return {
      shape: "taxonomy-archive",
      reason: term === undefined
        ? "No term in this export matches this path, so there is nothing to list here."
        : indexes.archives.taxonomies
          ? `The export carries the "${term.name}" ${termKindLabel(term.domain)} term, and nothing in this run serves its archive at this path.`
          : `The export carries the "${term.name}" ${termKindLabel(term.domain)} term, and this run was configured not to generate taxonomy archives.`
    };
  }

  if (base === "author" && segments.length >= 2) {
    return {
      shape: "author-archive",
      reason: indexes.archives.authors
        ? "No content in this export is by that author, so there is nothing to list here."
        : "This run was configured not to generate author archives."
    };
  }

  if (isPagedArchive(lower)) {
    return {
      shape: "paged",
      reason: indexes.archives.paginated
        ? "This export does not carry enough content for that page of the listing, or the path belongs to an archive this run does not generate."
        : "This run generates no paginated listings, so one static route serves one page. Set archives.perPage in the migration config to generate them."
    };
  }

  if (
    lower.length <= 3 &&
    /^\d{4}$/.test(lower[0] ?? "") &&
    lower.slice(1).every((segment) => /^\d{1,2}$/.test(segment))
  ) {
    return {
      shape: "date-archive",
      reason: indexes.archives.dates
        ? "No content in this export falls in that month."
        : "This run does not generate date archives. Set archives.dates in the migration config to generate them."
    };
  }

  return undefined;
}

function isWordPressEndpoint(lowerPath: string, segments: readonly string[]): boolean {
  if (/\.php$/.test(lowerPath)) {
    return true;
  }

  return ["wp-admin", "wp-json", "wp-includes", "wp-content"].includes(segments[0] ?? "");
}

function isPagedArchive(segments: readonly string[]): boolean {
  if (segments.length < 2) {
    return false;
  }

  return segments[segments.length - 2] === "page" && /^\d+$/.test(segments[segments.length - 1] ?? "");
}

function termKindLabel(domain: string): string {
  if (domain === "category") return "category";
  if (domain === "post_tag" || domain === "tag") return "tag";
  return domain;
}

function createLiveUrlIssues(source: LiveUrlSource, entries: readonly LiveUrlEntry[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];

  if (!entries.some((entry) => entry.status !== "invalid-url")) {
    const sitemapRefs = source.sitemapRefs.length;
    issues.push({
      id: "coverage:LIVE_URL_SOURCE_EMPTY:1",
      severity: "warning",
      code: "LIVE_URL_SOURCE_EMPTY",
      sourceId: "coverage",
      title: "The live URL source declared no page URLs",
      message: source.urls.length > 0
        ? "The supplied live URL source contains no readable URLs, so no live URL was compared against this plan."
        : sitemapRefs === 0
          ? "The supplied live URL source lists no URLs, so no live URL was compared against this plan."
        : `The supplied live URL source is a sitemap index with ${sitemapRefs} child ${pluralizeCount(sitemapRefs, "sitemap")}, and this tool does not fetch them. No live URL was compared against this plan.`,
      requiredAction:
        "Pass each sitemap that lists page URLs with --live-urls, or supply a plain list with one URL per line."
    });
  }

  entries
    .filter((entry) => entry.status === "uncovered")
    .forEach((entry, index) => {
      const label = entry.url ?? entry.path ?? "A live URL";
      issues.push({
        id: `coverage:LIVE_URL_UNCOVERED:${index + 1}`,
        severity: "warning",
        code: "LIVE_URL_UNCOVERED",
        sourceId: "coverage",
        ...optionalProperty("route", entry.path),
        title: "Live URL has no route or redirect",
        message: `${label} is served by no generated route and no redirect rule covers it.`,
        requiredAction:
          "Add a route or a redirect rule for this URL, or confirm that retiring the page is intentional."
      });
    });

  return issues;
}

function summarizeLiveUrlCoverage(
  entries: readonly LiveUrlEntry[],
  source: LiveUrlSource
): LiveUrlSummary {
  const withStatus = (status: LiveUrlStatus): number =>
    entries.filter((entry) => entry.status === status).length;

  return {
    checked: true,
    liveUrls: entries.length - withStatus("invalid-url"),
    routed: withStatus("routed"),
    redirected: withStatus("redirected"),
    unresolved: withStatus("unresolved"),
    excluded: withStatus("excluded-shape"),
    externalHosts: withStatus("external-host"),
    invalid: withStatus("invalid-url"),
    uncovered: withStatus("uncovered"),
    sitemapRefs: source.sitemapRefs.length
  };
}

/**
 * Allow a trailing slash difference but keep case and encoded separators:
 * `/Guides/` and `/guides/` are different paths on most static hosts.
 */
function livePathKey(path: string): string {
  return path.replace(/\/$/, "") || "/";
}

function pluralizeCount(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

interface LinkTargetIndex {
  /** Source paths the export declares, keyed by a normalized path. */
  readonly byPath: ReadonlyMap<string, readonly RouteEntry[]>;
  /** Hosts that belong to the site being migrated. */
  readonly siteHosts: ReadonlySet<string>;
  readonly siteUrl?: string | undefined;
}

interface LinkCandidate {
  readonly kind: LinkReferenceKind;
  readonly href: string;
  readonly nodeId?: string | undefined;
}

interface LinkClassification {
  readonly status: LinkReferenceStatus;
  readonly reason: string;
  readonly path?: string | undefined;
  readonly fragment?: string | undefined;
  readonly host?: string | undefined;
  readonly targetRoute?: string | undefined;
  readonly rewritten?: string | undefined;
}

/** WordPress ID permalinks need a permalink decision, not a path rewrite. */
const WORDPRESS_ID_QUERY_PATTERN = /(?:^|[?&])(?:p|page_id|attachment_id|cat)=\d+/i;

/**
 * Keep reporting artifacts free of credentials and query strings while
 * preserving the fragment, which is part of what a link points at.
 */
export function sanitizeLinkHref(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
  const fragment = trimmed.includes("#") ? `#${trimmed.slice(trimmed.indexOf("#") + 1)}` : "";

  const sanitized = sanitizeSourceUrl(trimmed);
  if (sanitized !== undefined) {
    return `${sanitized}${fragment}`;
  }
  // Do not expose authority text from malformed or unsupported absolute URLs.
  return /^[a-z][a-z0-9+.-]*:|^[\/\\]{2}/i.test(trimmed) ? "" : `${withoutQuery}${fragment}`;
}

/**
 * Proposed rewrites, with reporting-safe hrefs. The
 * manifest, the plan and the link inventory all read from this.
 */
export function linkRewrites(links: MigrationLinks): LinkRewrite[] {
  return links.references
    .filter((reference) => reference.status === "needs-rewrite" && reference.rewritten !== undefined)
    .map((reference) => ({
      id: reference.id,
      sourceId: reference.sourceId,
      href: sanitizeLinkHref(reference.href),
      rewritten: sanitizeLinkHref(reference.rewritten ?? ""),
      reason: reference.reason
    }));
}

function createLinkTargetIndex(entries: readonly RouteEntry[], siteUrl: string | undefined): LinkTargetIndex {
  const byPath = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const paths = new Set([
      entry.sourcePath,
      ...(entry.status === "generated" ? [entry.targetRoute] : [])
    ].map(linkPathKey));
    for (const key of paths) {
      if (key !== undefined) {
        const matches = byPath.get(key) ?? [];
        matches.push(entry);
        byPath.set(key, matches);
      }
    }
  }

  const siteHosts = new Set<string>();
  const addHost = (value: string | undefined): void => {
    try {
      siteHosts.add(new URL(sanitizeSourceUrl(value) ?? "").host);
    } catch {
      // Relative or malformed source URLs cannot establish a site host.
    }
  };
  addHost(siteUrl);
  if (siteHosts.size === 0) {
    for (const entry of entries) addHost(entry.sourceUrl);
  }

  return { byPath, siteHosts, siteUrl };
}

/**
 * Allow a trailing slash difference, but preserve case, encoded separators
 * and repeated slashes: those can identify different source pages.
 */
function linkPathKey(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return path.replace(/\/$/, "") || "/";
}

function collectLinkReferences(record: ContentRecord, index: LinkTargetIndex): LinkReference[] {
  const candidates = new Map<string, LinkCandidate>();

  const add = (candidate: LinkCandidate): void => {
    const href = candidate.href.trim();
    if (href === "" || href.startsWith("#") || isIgnoredLinkHref(href)) {
      return;
    }
    if (candidates.has(href)) {
      return;
    }
    candidates.set(href, { ...candidate, href });
  };

  const visit = (node: MigrationNode): void => {
    addNodeLinkSettings(node, add);
    for (const child of node.children) {
      visit(child);
    }
    // Elementor text and HTML widgets keep their markup in settings rather
    // than in rendered HTML, so those links are read from the same place the
    // media inventory reads its images from.
    const widgetHtml =
      node.source === "elementor"
        ? stringAttribute(node.attributes, node.sourceType === "text-editor" ? "editor" : "html")
        : undefined;
    for (const html of [node.rawHtml, widgetHtml]) {
      if (html === undefined) {
        continue;
      }
      for (const href of scanHtmlAnchors(html)) {
        add({ kind: "html-anchor", href, nodeId: node.id });
      }
    }
  };

  for (const node of record.nodes) {
    visit(node);
  }
  // Raw content can also contain HTML outside Gutenberg block boundaries.
  for (const href of scanHtmlAnchors(record.rawContent)) {
    add({ kind: "html-anchor", href });
  }

  const references: LinkReference[] = [];
  for (const candidate of candidates.values()) {
    const classification = classifyLink(candidate.href, record, index);
    if (classification === undefined) {
      continue;
    }

    references.push({
      id: `${record.sourceId}:link:${references.length + 1}`,
      sourceId: record.sourceId,
      ...optionalProperty("route", sanitizeSourceUrl(record.route)),
      ...optionalProperty("nodeId", candidate.nodeId),
      kind: candidate.kind,
      href: candidate.href,
      ...optionalProperty("path", classification.path),
      ...optionalProperty("fragment", classification.fragment),
      ...optionalProperty("host", classification.host),
      ...optionalProperty("targetRoute", classification.targetRoute),
      ...optionalProperty("rewritten", classification.rewritten),
      status: classification.status,
      reason: classification.reason
    });
  }

  return references;
}

function addNodeLinkSettings(node: MigrationNode, add: (candidate: LinkCandidate) => void): void {
  if (node.source === "gutenberg" && node.sourceType === "core/button") {
    const href = stringAttribute(node.attributes, "url");
    if (href !== undefined) {
      add({ kind: "gutenberg-button", href, nodeId: node.id });
    }
    return;
  }

  if (node.source !== "elementor") {
    return;
  }

  if (node.sourceType === "button") {
    const href = getNestedString(node.attributes, "link", "url");
    if (href !== undefined) {
      add({ kind: "elementor-button", href, nodeId: node.id });
    }
  }
}

function classifyLink(
  href: string,
  record: ContentRecord,
  index: LinkTargetIndex
): LinkClassification | undefined {
  const absolute = /^[a-z][a-z0-9+.-]*:|^[\/\\]{2}/i.test(href);
  const url = resolveLinkUrl(href, record, index);
  if (url === undefined) {
    return {
      status: "outside-export",
      reason: "This link could not be resolved against the source site, so it cannot be verified."
    };
  }

  const fragment = url.hash === "" ? undefined : url.hash;
  const path = url.pathname === "" ? "/" : url.pathname;
  const key = linkPathKey(path);
  const entries = key === undefined ? [] : index.byPath.get(key) ?? [];
  const entry = entries[0];
  const sameHost = index.siteHosts.has(url.host);

  if (!sameHost && (absolute || index.siteHosts.size > 0)) {
    return {
      status: "external",
      reason: "This link leaves the migrated site, so it is kept as written.",
      path,
      fragment,
      host: url.host
    };
  }

  if (WORDPRESS_ID_QUERY_PATTERN.test(url.search)) {
    return {
      status: "no-target",
      reason: "This link uses a WordPress ID permalink, which needs a permalink decision before it can be rewritten.",
      path,
      fragment
    };
  }

  if (entry === undefined) {
    return {
      status: "outside-export",
      reason: "No page or post in this export declares this URL, so the link cannot be verified.",
      path,
      fragment
    };
  }

  if (entries.length > 1 || entry.targetRoute === undefined || entry.status !== "generated") {
    return {
      status: "no-target",
      reason: entries.length > 1 ? "More than one exported item declares this path, so its target needs review." : entry.reason,
      path,
      fragment,
      targetRoute: entry.targetRoute
    };
  }

  const rewritten = `${entry.targetRoute}${url.search}${url.hash}`;
  if (rewritten === href) {
    return {
      status: "resolves",
      reason: "The generated route already matches this link.",
      path,
      fragment,
      targetRoute: entry.targetRoute
    };
  }

  return {
    status: "needs-rewrite",
    reason: absolute
      ? "The link points at the source site, so the generated content links to the local route instead."
      : "The generated route differs from this link, so the generated content links to the route directly.",
    path,
    fragment,
    targetRoute: entry.targetRoute,
    rewritten
  };
}

function resolveLinkUrl(href: string, record: ContentRecord, index: LinkTargetIndex): URL | undefined {
  const bases: string[] = [];
  if (record.route !== undefined) {
    bases.push(record.route);
  }
  bases.push(`/${record.slug}/`);

  for (const base of bases) {
    try {
      return new URL(href, base);
    } catch {
      if (index.siteUrl !== undefined) {
        try {
          return new URL(href, new URL(base, index.siteUrl));
        } catch {
          continue;
        }
      }
    }
  }

  if (index.siteUrl !== undefined) {
    try {
      return new URL(href, index.siteUrl);
    } catch {
      // Fall through to the sentinel base below.
    }
  }

  try {
    const fallbackHost = index.siteHosts.values().next().value ?? "link.invalid";
    return new URL(href, new URL(record.route ?? `/${record.slug}/`, `https://${fallbackHost}/`));
  } catch {
    return undefined;
  }
}

function isIgnoredLinkHref(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return false;
  }
  return scheme !== "http" && scheme !== "https";
}

function scanHtmlAnchors(html: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const href = readHtmlAttribute(match[0], "href");
    if (href !== undefined) {
      hrefs.push(href);
    }
  }

  return hrefs;
}

function withLinkIssues(record: ContentRecord, references: readonly LinkReference[]): ContentRecord {
  const issues = createLinkIssues(record, references);
  return issues.length === 0 ? record : { ...record, issues: [...record.issues, ...issues] };
}

/**
 * Link findings stay aggregated per content record for the same reason media
 * findings do: one repaired page can contain dozens of links, and the repair
 * queue has to stay readable.
 */
function createLinkIssues(record: ContentRecord, references: readonly LinkReference[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const withoutTarget = references.filter((reference) => reference.status === "no-target").length;
  const outsideExport = references.filter((reference) => reference.status === "outside-export").length;

  if (withoutTarget > 0) {
    const message = `${withoutTarget} link${withoutTarget === 1 ? "" : "s"} point${withoutTarget === 1 ? "s" : ""} at a URL this export generates no page for.`;
    issues.push({
      id: `${record.sourceId}:LINK_TARGET_MISSING:${record.issues.length + issues.length + 1}`,
      severity: "warning",
      code: "LINK_TARGET_MISSING",
      sourceId: record.sourceId,
      ...optionalProperty("route", record.route),
      title: message,
      message,
      requiredAction: "Decide where each of these links should go; the link map in this handoff lists them."
    });
  }

  if (outsideExport > 0) {
    const message = `${outsideExport} link${outsideExport === 1 ? "" : "s"} point${outsideExport === 1 ? "s" : ""} outside anything this export contains.`;
    issues.push({
      id: `${record.sourceId}:LINK_TARGET_OUTSIDE_EXPORT:${record.issues.length + issues.length + 1}`,
      severity: "warning",
      code: "LINK_TARGET_OUTSIDE_EXPORT",
      sourceId: record.sourceId,
      ...optionalProperty("route", record.route),
      title: message,
      message,
      requiredAction: "Confirm whether each target still exists on the live site, then update or remove the link."
    });
  }

  return issues;
}

function finalizeLinks(references: readonly LinkReference[]): MigrationLinks {
  const count = (status: LinkReferenceStatus): number =>
    references.filter((reference) => reference.status === status).length;
  const external = count("external");

  return {
    references,
    summary: {
      references: references.length,
      internal: references.length - external,
      resolves: count("resolves"),
      needsRewrite: count("needs-rewrite"),
      noTarget: count("no-target"),
      outsideExport: count("outside-export"),
      external
    }
  };
}

function createIssueCollector(sourceId: string, route: string | undefined): IssueCollector {
  const issues: MigrationIssue[] = [];
  return {
    issues,
    add(severity, code, message, requiredAction, details = {}): void {
      issues.push({
        id: `${sourceId}:${code}:${issues.length + 1}`,
        severity,
        code,
        sourceId,
        ...(route === undefined ? {} : { route }),
        ...(details.nodeId === undefined ? {} : { nodeId: details.nodeId }),
        title: message,
        message,
        ...(details.evidence === undefined ? {} : { evidence: details.evidence }),
        requiredAction
      });
    }
  };
}

function createMutableNode(
  id: string,
  source: MigrationNode["source"],
  sourceType: string,
  kind: MigrationNodeKind,
  conversion: ConversionDisposition,
  attributes: Record<string, unknown>,
  children: MutableNode[]
): MutableNode {
  return { id, source, sourceType, kind, conversion, attributes, children };
}

function createClassicNode(rawHtml: string, id: string): MigrationNode {
  const text = htmlToText(rawHtml);
  return {
    id,
    source: "classic",
    sourceType: "classic/html",
    kind: "html",
    conversion: "legacy-html",
    attributes: {},
    children: [],
    ...(text === "" ? {} : { text }),
    rawHtml
  };
}

function appendLooseHtml(
  rawHtml: string,
  destination: MutableNode[],
  sourceId: string,
  nextOrdinal: () => number
): void {
  if (rawHtml.trim() === "") {
    return;
  }
  const node = createClassicNode(rawHtml, `${sourceId}:gutenberg-loose:${nextOrdinal()}`);
  destination.push({ ...node, attributes: {}, children: [] });
}

/** Term domains that never become a public archive of their own. */
const NON_ARCHIVE_TERM_DOMAINS = new Set(["nav_menu", "post_format", "translation"]);

interface ArchiveInput {
  readonly records: readonly ContentRecord[];
  readonly liveUrlSource: LiveUrlSource | undefined;
  readonly config: MigrationConfig | undefined;
  readonly siteTitle: string | undefined;
  readonly siteUrl: string | undefined;
}

/**
 * The listing pages this handoff generates, and why each route is where it is.
 *
 * Term and author archives default on: leaving a URL WordPress served with no
 * replacement is the failure this tool exists to prevent. Date archives, a
 * posts index and feeds are opt-in, because each one needs a setting a WXR
 * file does not carry, and inventing those would be guessing.
 */
function buildArchives(input: ArchiveInput): MigrationArchives {
  const settings = input.config?.archives;
  const pages: ArchivePage[] = [];
  const feeds: FeedFile[] = [];
  const livePaths = liveArchivePaths(input);
  const posts = input.records.filter((record) => record.type === "post");
  const perPage = settings?.perPage;

  const addListing = (listing: {
    readonly id: string;
    readonly kind: ArchiveKind;
    readonly title: string;
    readonly route: string;
    readonly routeSource: ArchiveRouteSource;
    readonly subject: string;
    readonly sourceUrl?: string | undefined;
    readonly sourceIds: readonly string[];
  }): void => {
    const chunks =
      perPage === undefined || listing.sourceIds.length === 0
        ? [listing.sourceIds]
        : chunkSourceIds(listing.sourceIds, perPage);

    chunks.forEach((sourceIds, index) => {
      if (sourceIds.length === 0) {
        return;
      }
      pages.push({
        id: index === 0 ? listing.id : `${listing.id}:page-${index + 1}`,
        kind: listing.kind,
        title: index === 0 ? listing.title : `${listing.title} (page ${index + 1})`,
        route: index === 0 ? normalizeRoute(listing.route) : paginatedRoute(listing.route, index + 1),
        ...(listing.sourceUrl === undefined ? {} : {
          sourceUrl: index === 0 ? listing.sourceUrl : `${listing.sourceUrl.replace(/\/+$/, "")}/page/${index + 1}/`
        }),
        sourceIds,
        subject: listing.subject,
        routeSource: listing.routeSource,
        paginated: index > 0
      });
    });
  };

  if (settings?.taxonomies !== false) {
    const termRecords = new Map<
      string,
      { readonly domain: string; readonly slug: string; readonly name: string; readonly sourceIds: string[] }
    >();

    for (const record of input.records) {
      for (const term of record.terms) {
        if (
          term.nicename === "" ||
          NON_ARCHIVE_TERM_DOMAINS.has(term.domain) ||
          term.domain.startsWith("wp_")
        ) {
          continue;
        }
        const key = `${term.domain}:${term.nicename}`;
        const entry = termRecords.get(key) ?? {
          domain: term.domain,
          slug: term.nicename,
          name: term.name === "" ? term.nicename : term.name,
          sourceIds: []
        };
        if (!entry.sourceIds.includes(record.sourceId)) {
          entry.sourceIds.push(record.sourceId);
        }
        termRecords.set(key, entry);
      }
    }

    for (const [key, entry] of [...termRecords].sort(([left], [right]) => left.localeCompare(right))) {
      const base = defaultArchiveBase(entry.domain);
      const match = matchLiveArchive(livePaths, entry.slug, [base, entry.domain]);
      addListing({
        id: `archive:${key}`,
        kind: "taxonomy",
        title: entry.name,
        route: match?.path ?? `/${base}/${entry.slug}/`,
        routeSource:
          match !== undefined
            ? "live-url"
            : entry.domain === "category" || entry.domain === "post_tag"
              ? "wordpress-default"
              : "derived",
        subject: key,
        sourceUrl: match?.url,
        sourceIds: entry.sourceIds
      });
    }
  }

  if (settings?.authors !== false) {
    const byAuthor = new Map<string, string[]>();
    for (const record of input.records) {
      const author = record.author?.trim();
      // A WordPress author archive lists the blog's posts, not the site's
      // pages, so pages stay out of the listing even when they share an author.
      if (author === undefined || author === "" || record.type === "page") {
        continue;
      }
      byAuthor.set(author, [...(byAuthor.get(author) ?? []), record.sourceId]);
    }

    for (const [author, sourceIds] of [...byAuthor].sort(([left], [right]) => left.localeCompare(right))) {
      const slug = slugify(author);
      const match = matchLiveArchive(livePaths, slug, ["author"]);
      addListing({
        id: `archive:author:${slug}`,
        kind: "author",
        title: author,
        route: match?.path ?? `/author/${slug}/`,
        routeSource: match === undefined ? "wordpress-default" : "live-url",
        subject: `author:${slug}`,
        sourceUrl: match?.url,
        sourceIds
      });
    }
  }

  if (settings?.dates === true) {
    const byMonth = new Map<string, string[]>();
    for (const record of posts) {
      const month = /^(\d{4}-\d{2})/.exec(record.publishedAt ?? "")?.[1];
      if (month === undefined) {
        continue;
      }
      byMonth.set(month, [...(byMonth.get(month) ?? []), record.sourceId]);
    }

    for (const [month, sourceIds] of [...byMonth].sort(([left], [right]) => left.localeCompare(right))) {
      addListing({
        id: `archive:date:${month}`,
        kind: "date",
        title: `Posts from ${monthLabel(month)}`,
        route: `/${month.replace("-", "/")}/`,
        routeSource: "derived",
        subject: `date:${month}`,
        sourceIds
      });
    }
  }

  if (settings?.postsIndex !== undefined) {
    addListing({
      id: "archive:posts",
      kind: "posts-index",
      title: "Posts",
      route: settings.postsIndex,
      routeSource: "config",
      subject: "posts",
      sourceIds: posts.map((record) => record.sourceId)
    });
  }

  for (const configured of settings?.feeds ?? []) {
    const normalized = normalizeRoute(configured).replace(/\/$/, "");
    const asFile = /\.xml$/i.test(normalized);
    const path = asFile ? normalized : `${normalized}.xml`;
    feeds.push({
      id: `feed:${path}`,
      path,
      ...(asFile ? {} : { sourcePath: normalizeRoute(configured) }),
      title: input.siteTitle ?? "WordPress migration",
      sourceIds: posts.map((record) => record.sourceId)
    });
  }

  const assumedBases = new Set(
    pages
      .filter((page) => !page.paginated && page.routeSource !== "live-url" && page.routeSource !== "config")
      .map((page) => archiveBaseOf(page.route))
  );

  return {
    pages,
    feeds,
    summary: {
      taxonomies: pages.filter((page) => page.kind === "taxonomy" && !page.paginated).length,
      authors: pages.filter((page) => page.kind === "author" && !page.paginated).length,
      dates: pages.filter((page) => page.kind === "date" && !page.paginated).length,
      postsIndex: pages.filter((page) => page.kind === "posts-index" && !page.paginated).length,
      fromLiveUrls: pages.filter((page) => !page.paginated && page.routeSource === "live-url").length,
      assumed: assumedBases.size,
      feeds: feeds.length
    }
  };
}

/** Every live URL path the caller supplied, mapped to the URL as it was given. */
function liveArchivePaths(input: ArchiveInput): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const contentPaths = new Set(input.records.map((record) => targetRouteFor(record)));
  const siteHost = parseLiveUrl(input.siteUrl ?? "")?.host;
  for (const url of input.liveUrlSource?.urls ?? []) {
    const host = parseLiveUrl(url)?.host;
    if (urlHasQuery(url) || (host !== undefined && host !== siteHost)) continue;
    const path = sourcePath(url);
    if (path !== undefined && !contentPaths.has(normalizeRoute(path)) && !paths.has(path)) {
      paths.set(path, sanitizeSourceUrl(url) ?? path);
    }
  }
  return paths;
}

/**
 * The live URL that already serves an archive for this slug.
 *
 * A term archive is a path whose last segment is the term and whose first
 * segment is a base WordPress uses for it. A two-segment path with a different
 * first segment still counts: that is how a site with a renamed base (say
 * `/topics/`) tells this tool what it actually serves.
 */
function matchLiveArchive(
  livePaths: ReadonlyMap<string, string>,
  slug: string,
  bases: readonly string[]
): { readonly path: string; readonly url: string } | undefined {
  const candidates: Array<{ readonly path: string; readonly url: string; readonly known: boolean }> = [];

  for (const [path, url] of livePaths) {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length < 2) {
      continue;
    }
    const last = segments[segments.length - 1] ?? "";
    const first = segments[0] ?? "";
    const otherBase = ["category", "tag", "post_tag", "author"].includes(first) && !bases.includes(first);
    if (last !== slug || otherBase || (segments.length > 2 && !bases.includes(first))) {
      continue;
    }
    candidates.push({ path, url, known: bases.includes(first) });
  }

  const known = candidates.filter((candidate) => candidate.known);
  const choices = known.length > 0 ? known : candidates;
  const chosen = choices.length === 1 ? choices[0] : undefined;
  return chosen === undefined ? undefined : { path: chosen.path, url: chosen.url };
}

function defaultArchiveBase(domain: string): string {
  if (domain === "post_tag" || domain === "tag") return "tag";
  return domain === "category" ? "category" : slugify(domain);
}

function chunkSourceIds(sourceIds: readonly string[], perPage: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < sourceIds.length; index += perPage) {
    chunks.push(sourceIds.slice(index, index + perPage));
  }
  return chunks;
}

function paginatedRoute(route: string, page: number): string {
  return normalizeRoute(`${route.replace(/\/+$/, "")}/page/${page}/`);
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-");
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const name = names[Number.parseInt(monthNumber ?? "", 10) - 1];
  return name === undefined ? month : `${name} ${year}`;
}

/** The first path segment of a route, which is the base an archive lives under. */
function archiveBaseOf(route: string): string {
  const first = route.split("/").filter((segment) => segment !== "")[0] ?? "";
  return `/${first}/`;
}

function archiveRouteReason(page: ArchivePage): string {
  const origin =
    page.routeSource === "live-url"
      ? "A live URL you supplied serves this archive here."
      : page.routeSource === "config"
        ? "The migration config places this listing here."
        : page.routeSource === "wordpress-default"
          ? "WordPress serves this archive under its default base, which this export does not confirm."
          : "This archive route is derived from the content it lists.";
  return `${origin} Generated from ${page.sourceIds.length} listed ${
    page.sourceIds.length === 1 ? "record" : "records"
  }.`;
}

/**
 * Archive routes that rest on an assumption are reported once per base rather
 * than once per term, so a site with fifty categories gets one decision to
 * make instead of fifty.
 */
function createArchiveIssues(archives: MigrationArchives): MigrationIssue[] {
  const assumed = new Map<string, number>();
  for (const page of archives.pages) {
    if (page.paginated || page.routeSource === "live-url" || page.routeSource === "config") {
      continue;
    }
    const base = archiveBaseOf(page.route);
    assumed.set(base, (assumed.get(base) ?? 0) + 1);
  }

  return [...assumed]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([base, count], index) => {
      const message = `${count} archive ${count === 1 ? "route uses" : "routes use"} the base "${base}", because no live URL you supplied identifies the real one.`;
      return {
        id: `project:ARCHIVE_ROUTE_ASSUMED:${index + 1}`,
        severity: "warning" as const,
        code: "ARCHIVE_ROUTE_ASSUMED" as const,
        sourceId: "project",
        title: "An archive route rests on a WordPress default",
        message,
        requiredAction:
          "Save the live sitemap and run again with --live-urls so the archive routes come from the site itself, or confirm the base in a migration config."
      };
    });
}

function emptyMenus(): MigrationMenus {
  return { trees: [], summary: { menus: 0, items: 0, unresolved: 0 } };
}

interface MenuTarget {
  readonly kind: MenuItemKind;
  readonly url?: string | undefined;
  readonly href?: string | undefined;
  readonly targetRoute?: string | undefined;
  readonly reason?: string | undefined;
}

interface MenuDraft {
  readonly id: string;
  readonly wordpressId: number;
  readonly label: string;
  readonly menuSlug: string;
  readonly menuName: string;
  readonly order: number;
  readonly target: MenuTarget;
  readonly parentWordpressId?: number | undefined;
}

interface MenuInput {
  readonly items: readonly WxrItem[];
  readonly records: readonly ContentRecord[];
  readonly archives: MigrationArchives;
  readonly termRegistry: ReadonlyMap<number, TermRegistryEntry>;
  readonly linkIndex: LinkTargetIndex;
}

/**
 * The navigation WordPress served, rebuilt from its `nav_menu_item` items.
 * Menu items are not content, but dropping them silently is how a migrated
 * site ends up with no navigation at all.
 */
function buildMenus(input: MenuInput): MigrationMenus {
  const menuItems = input.items.filter((item) => item.postType === "nav_menu_item");
  if (menuItems.length === 0) {
    return emptyMenus();
  }

  const recordsByKey = new Map(
    input.records.map((record) => [`${record.type}:${record.wordpressId}`, record] as const)
  );
  const archivesBySubject = new Map(
    input.archives.pages.filter((page) => !page.paginated).map((page) => [page.subject, page] as const)
  );
  const drafts: MenuDraft[] = [];

  for (const item of menuItems) {
    const wordpressId = parseWordPressId(cleanField(readTag(item.xml, "wp:post_id")));
    if (wordpressId === undefined) {
      continue;
    }
    if (normalizeStatus(cleanField(readTag(item.xml, "wp:status"))) === "trash") {
      continue;
    }

    const meta = parsePostMeta(item.xml);
    const menuTerm = parseTerms(item.xml).find((term) => term.domain === "nav_menu");
    const order = Number.parseInt(cleanField(readTag(item.xml, "wp:menu_order")), 10);
    const objectId = parseWordPressId(cleanField(meta._menu_item_object_id?.[0] ?? ""));
    const objectType = cleanField(meta._menu_item_object?.[0] ?? "");

    drafts.push({
      id: `menu:${wordpressId}`,
      wordpressId,
      label: cleanField(readTag(item.xml, "title")) ||
        (objectId === undefined ? undefined : recordsByKey.get(`${objectType}:${objectId}`)?.title) ||
        (objectId === undefined ? undefined : input.termRegistry.get(objectId)?.name) || `Menu item ${wordpressId}`,
      menuSlug: menuTerm?.nicename ?? "menu",
      menuName: menuTerm === undefined || menuTerm.name === "" ? "Menu" : menuTerm.name,
      order: Number.isSafeInteger(order) ? order : 0,
      target: resolveMenuTarget({
        itemType: cleanField(meta._menu_item_type?.[0] ?? ""),
        objectType,
        objectId,
        customUrl: cleanOptionalField(meta._menu_item_url?.[0] ?? ""),
        recordsByKey,
        termRegistry: input.termRegistry,
        archivesBySubject,
        linkIndex: input.linkIndex
      }),
      parentWordpressId: parseWordPressId(cleanField(meta._menu_item_menu_item_parent?.[0] ?? ""))
    });
  }

  return assembleMenus(drafts);
}

function resolveMenuTarget(input: {
  readonly itemType: string;
  readonly objectType: string;
  readonly objectId: number | undefined;
  readonly customUrl: string | undefined;
  readonly recordsByKey: ReadonlyMap<string, ContentRecord>;
  readonly termRegistry: ReadonlyMap<number, TermRegistryEntry>;
  readonly archivesBySubject: ReadonlyMap<string, ArchivePage>;
  readonly linkIndex: LinkTargetIndex;
}): MenuTarget {
  if (input.itemType === "post_type") {
    const record =
      input.objectId === undefined ? undefined : input.recordsByKey.get(`${input.objectType}:${input.objectId}`);
    if (record === undefined) {
      return {
        kind: "post",
        reason: `No ${input.objectType || "content"} item in this export matches the menu target.`
      };
    }
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    return { kind: "post", url: route, targetRoute: route };
  }

  if (input.itemType === "taxonomy") {
    const term = input.objectId === undefined ? undefined : input.termRegistry.get(input.objectId);
    const archive =
      term === undefined ? undefined : input.archivesBySubject.get(`${term.taxonomy}:${term.slug}`);
    if (archive === undefined) {
      return {
        kind: "taxonomy",
        reason: `This export carries no archive for the ${input.objectType || "taxonomy"} this menu item points at.`
      };
    }
    return {
      kind: "taxonomy",
      url: archive.sourceUrl ?? archive.route,
      targetRoute: archive.route
    };
  }

  if (input.itemType === "custom") {
    const url = input.customUrl?.trim();
    if (url === undefined || url === "") {
      return { kind: "custom", reason: "The menu item carries no URL." };
    }
    let parsed: URL;
    try {
      parsed = new URL(url, input.linkIndex.siteUrl ?? "https://menu.invalid/");
    } catch {
      return { kind: "custom", reason: "The menu item carries an invalid URL." };
    }
    if (!["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol)) {
      return { kind: "custom", reason: "The menu URL uses an unsupported scheme." };
    }
    const reportingUrl = sanitizeLinkHref(url);
    const target: MenuTarget = { kind: "custom", ...(reportingUrl === "" ? {} : { url: reportingUrl }) };
    if (url.startsWith("#") || parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
      return { ...target, href: url };
    }
    parsed.username = "";
    parsed.password = "";
    const absolute = /^[a-z][a-z0-9+.-]*:|^[\/\\]{2}/i.test(url);
    if (absolute && !input.linkIndex.siteHosts.has(parsed.host)) {
      return { ...target, href: parsed.href };
    }
    const entries = input.linkIndex.byPath.get(linkPathKey(parsed.pathname) ?? "/") ?? [];
    const entry = entries[0];
    if (!WORDPRESS_ID_QUERY_PATTERN.test(parsed.search) && entries.length === 1 &&
      entry?.status === "generated" && entry.targetRoute !== undefined) {
      return { ...target, targetRoute: entry.targetRoute, href: `${entry.targetRoute}${parsed.search}${parsed.hash}` };
    }
    return { ...target, href: url, reason: "No unambiguous generated route serves this menu URL." };
  }

  if (input.itemType === "post_type_archive") {
    return {
      kind: "post-type-archive",
      reason: `The ${input.objectType || "content"} archive is not generated by this handoff.`
    };
  }

  return {
    kind: "unknown",
    reason: `Menu item type "${input.itemType || "unknown"}" is not supported.`
  };
}

function assembleMenus(drafts: readonly MenuDraft[]): MigrationMenus {
  const byMenu = new Map<string, MenuDraft[]>();
  for (const draft of drafts) {
    byMenu.set(draft.menuSlug, [...(byMenu.get(draft.menuSlug) ?? []), draft]);
  }

  const trees: MenuTree[] = [];
  let items = 0;
  let unresolved = 0;

  for (const [slug, menuDrafts] of [...byMenu].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...menuDrafts].sort(
      (left, right) => left.order - right.order || left.wordpressId - right.wordpressId
    );
    const ids = new Set(ordered.map((draft) => draft.wordpressId));

    const build = (draft: MenuDraft): MenuItem => {
      const children = ordered
        .filter((candidate) => candidate.parentWordpressId === draft.wordpressId)
        .map(build);
      items += 1;
      if (draft.target.reason !== undefined) {
        unresolved += 1;
      }

      return {
        id: draft.id,
        label: draft.label,
        kind: draft.target.kind,
        ...(draft.target.url === undefined ? {} : { url: draft.target.url }),
        ...(draft.target.href === undefined ? {} : { href: draft.target.href }),
        ...(draft.target.targetRoute === undefined ? {} : { targetRoute: draft.target.targetRoute }),
        ...(draft.parentWordpressId === undefined || !ids.has(draft.parentWordpressId)
          ? {}
          : { parentId: `menu:${draft.parentWordpressId}` }),
        children,
        ...(draft.target.reason === undefined ? {} : { reason: draft.target.reason })
      };
    };

    const roots = ordered.filter(
      (draft) => draft.parentWordpressId === undefined || !ids.has(draft.parentWordpressId)
    );
    trees.push({
      id: `menu:${slug}`,
      name: ordered[0]?.menuName ?? "Menu",
      slug,
      items: roots.map(build)
    });
  }

  return { trees, summary: { menus: trees.length, items, unresolved } };
}

/** One finding per menu entry nothing in this plan serves. */
function createMenuIssues(menus: MigrationMenus): MigrationIssue[] {
  const issues: MigrationIssue[] = [];

  const visit = (menu: MenuTree, item: MenuItem): void => {
    if (item.reason !== undefined) {
      issues.push({
        id: `menu:${menu.slug}:${item.id}:MENU_TARGET_UNRESOLVED`,
        severity: "warning",
        code: "MENU_TARGET_UNRESOLVED",
        sourceId: item.id,
        title: `Menu entry "${item.label}" has no target in this handoff`,
        message: `${item.reason} The entry stays in the migration menu inventory so the decision is visible.`,
        requiredAction:
          "Point the entry at a generated route in the migration config, or rebuild it deliberately in the new theme."
      });
    }
    item.children.forEach((child) => visit(menu, child));
  };

  for (const menu of menus.trees) {
    menu.items.forEach((item) => visit(menu, item));
  }

  return issues;
}

function summarize(
  records: readonly ContentRecord[],
  issues: readonly MigrationIssue[],
  media: MediaSummary,
  routes: RouteSummary,
  links: LinkSummary,
  types: readonly ContentTypeEntry[],
  archives: ArchiveSummary,
  menus: MenuSummary
): MigrationSummary {
  const nodes = records.flatMap((record) => flattenNodes(record.nodes));
  return {
    records: records.length,
    pages: records.filter((record) => record.type === "page").length,
    posts: records.filter((record) => record.type === "post").length,
    types: Object.fromEntries(
      types.filter((entry) => entry.records > 0).map((entry) => [entry.name, entry.records])
    ),
    nodes: nodes.length,
    nativeNodes: nodes.filter((node) => node.conversion === "native").length,
    manualNodes: nodes.filter((node) => node.conversion === "manual" || node.conversion === "legacy-html").length,
    blockedNodes: nodes.filter((node) => node.conversion === "blocked").length,
    reviewItems: nodes.filter(
      (node) => node.conversion === "manual" || node.conversion === "legacy-html" || node.conversion === "blocked"
    ).length,
    // Waived findings stay in the plan but not in the counts a gate reads.
    warnings: issues.filter((issue) => issue.severity === "warning" && issue.ignored !== true).length,
    blockers: issues.filter((issue) => issue.severity === "blocker" && issue.ignored !== true).length,
    media,
    routes,
    links,
    archives,
    menus
  };
}

function flattenNodes(nodes: readonly MigrationNode[]): MigrationNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function readTag(xml: string, tagName: string): string {
  const escaped = escapeRegExp(tagName);
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(xml);
  return match?.[1] ?? "";
}

function readAttribute(attributes: string, attributeName: string): string | undefined {
  const escaped = escapeRegExp(attributeName);
  const match = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
  return match?.[1] ?? match?.[2];
}

function unwrapXmlValue(value: string): string {
  const trimmed = value.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(trimmed);
  return cdata?.[1] ?? decodeXmlEntities(trimmed);
}

function cleanField(value: string): string {
  return decodeXmlEntities(unwrapXmlValue(value)).trim();
}

function cleanOptionalField(value: string): string | undefined {
  const cleaned = cleanField(value);
  return cleaned === "" ? undefined : cleaned;
}

function parseWordPressId(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }

  const wordpressId = Number(value);
  return Number.isSafeInteger(wordpressId) && wordpressId > 0 ? wordpressId : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (entity: string, decimal: string) => decodeNumericXmlEntity(entity, decimal, 10))
    .replace(/&#x([0-9a-f]+);/gi, (entity: string, hexadecimal: string) =>
      decodeNumericXmlEntity(entity, hexadecimal, 16)
    )
    .replace(/&amp;/g, "&");
}

function decodeNumericXmlEntity(entity: string, value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return isValidXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
}

function isValidXmlCodePoint(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value === 0x9 ||
      value === 0xa ||
      value === 0xd ||
      (value >= 0x20 && value <= 0xd7ff) ||
      (value >= 0xe000 && value <= 0xfffd) ||
      (value >= 0x10000 && value <= 0x10ffff))
  );
}

function htmlToText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeBlockName(value: string): string {
  return value.includes("/") ? value.toLowerCase() : `core/${value.toLowerCase()}`;
}

function normalizeStatus(value: string): WordPressStatus {
  switch (value) {
    case "publish":
    case "draft":
    case "future":
    case "pending":
    case "private":
    case "trash":
    case "inherit":
      return value;
    default:
      return "unknown";
  }
}

function elementorWidgetText(widgetType: string, settings: Readonly<Record<string, unknown>>): string | undefined {
  const candidate = widgetType === "heading" ? settings.title : widgetType === "text-editor" ? settings.editor : settings.text;
  return typeof candidate === "string" && candidate.trim() !== "" ? htmlToText(candidate) : undefined;
}

function getNestedString(
  values: Readonly<Record<string, unknown>>,
  key: string,
  nestedKey: string
): string | undefined {
  const value = values[key];
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const nested = value[nestedKey];
  return typeof nested === "string" && nested.trim() !== "" ? nested : undefined;
}

function isSafeElementorHref(value: string): boolean {
  const href = value.trim();
  if (href === "" || /[\u0000-\u001f\u007f-\u009f]/.test(href)) {
    return false;
  }

  const decodedHref = decodeElementorHrefEntities(href).trim();
  if (decodedHref === "" || /[\u0000-\u001f\u007f-\u009f]/.test(decodedHref)) {
    return false;
  }
  const normalized = decodedHref.replace(/\s+/g, "");
  if (normalized.startsWith("//") || normalized.startsWith("\\")) {
    return false;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return scheme === undefined || SAFE_ELEMENTOR_HREF_SCHEMES.has(scheme);
}

function decodeElementorHrefEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decodeXmlEntities(decoded)
      .replace(/&colon;/gi, ":")
      .replace(/&newline;/gi, "\n")
      .replace(/&tab;/gi, "\t");
    if (next === decoded) {
      return next;
    }
    decoded = next;
  }
  return decoded;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalProperty<Key extends string, Value>(key: Key, value: Value | undefined): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function compactOptionalObject(values: {
  readonly title: string | undefined;
  readonly url: string | undefined;
}): MigrationProject["source"] {
  return {
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.url === undefined ? {} : { url: values.url })
  };
}
