/**
 * A destination this tool can write. `astro` and `payload` are implemented;
 * `next`, `nuxt` and `svelte` are declared so the manifest, the report and the
 * CLI can say a target is planned rather than pretend it does not exist.
 */
export type OutputTarget = "astro" | "payload" | "next" | "nuxt" | "svelte";

/**
 * What kind of destination a target is. A static-site target writes pages; a
 * CMS target writes collections, a content and media drop, and an importer
 * that the caller runs inside the destination project.
 */
export type DestinationKind = "static-site" | "cms";

/**
 * `page` and `post` are the types this tool has always handled; any other slug
 * an export carries becomes a content type of its own rather than a silent
 * omission.
 */
export type WordPressContentType = "page" | "post" | (string & {});

export type WordPressStatus =
  | "publish"
  | "draft"
  | "future"
  | "pending"
  | "private"
  | "trash"
  | "inherit"
  | "unknown";

export type SourceEditor = "classic" | "gutenberg" | "elementor" | "mixed";

export type ConversionDisposition = "native" | "legacy-html" | "manual" | "blocked";

export type MigrationNodeKind =
  | "root"
  | "section"
  | "group"
  | "columns"
  | "column"
  | "paragraph"
  | "heading"
  | "list"
  | "quote"
  | "code"
  | "html"
  | "image"
  | "gallery"
  | "button"
  | "separator"
  | "spacer"
  | "embed"
  | "shortcode"
  | "form"
  | "query"
  | "unknown";

export interface MigrationNode {
  readonly id: string;
  readonly source: "classic" | "gutenberg" | "elementor" | "shortcode";
  readonly sourceType: string;
  readonly kind: MigrationNodeKind;
  readonly conversion: ConversionDisposition;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly children: readonly MigrationNode[];
  readonly text?: string;
  readonly rawHtml?: string;
}

export type MigrationIssueSeverity = "warning" | "blocker";

/**
 * Every finding this tool can report. A migration config can waive a code, so
 * the list is a value as well as a type: validation and the union stay in step.
 */
export const MIGRATION_ISSUE_CODES = [
  "WXR_NO_ITEMS",
  "WXR_ITEM_MISSING_ID",
  "WXR_ITEM_INVALID_ID",
  "WXR_ITEM_DUPLICATE_ID",
  "GUTENBERG_UNCLOSED_BLOCK",
  "GUTENBERG_UNMATCHED_CLOSE",
  "GUTENBERG_INVALID_ATTRIBUTES",
  "GUTENBERG_DYNAMIC_BLOCK",
  "GUTENBERG_MEDIA_UNSUPPORTED",
  "GUTENBERG_UNKNOWN_BLOCK",
  "SHORTCODE_UNSUPPORTED",
  "ELEMENTOR_INVALID_DATA",
  "ELEMENTOR_FORM_UNSUPPORTED",
  "ELEMENTOR_QUERY_UNSUPPORTED",
  "ELEMENTOR_IMAGE_REMOTE_MEDIA",
  "ELEMENTOR_BUTTON_UNSAFE_URL",
  "ELEMENTOR_WIDGET_UNKNOWN",
  "MEDIA_MISSING_ALT_TEXT",
  "MEDIA_MISSING_FROM_EXPORT",
  "MEDIA_NOT_LOCAL",
  "LINK_TARGET_MISSING",
  "LINK_TARGET_OUTSIDE_EXPORT",
  "LIVE_URL_UNCOVERED",
  "LIVE_URL_SOURCE_EMPTY",
  "CONFIG_ENTRY_UNMATCHED",
  "WXR_POST_TYPE_SKIPPED",
  "MENU_TARGET_UNRESOLVED",
  "ARCHIVE_ROUTE_ASSUMED",
  "SITE_URL_MISSING"
] as const;

export type MigrationIssueCode = (typeof MIGRATION_ISSUE_CODES)[number];

export interface MigrationIssue {
  readonly id: string;
  readonly severity: MigrationIssueSeverity;
  readonly code: MigrationIssueCode;
  readonly sourceId: string;
  readonly route?: string;
  readonly nodeId?: string;
  readonly title: string;
  readonly message: string;
  readonly evidence?: string;
  readonly requiredAction: string;
  /**
   * True when the migration config asked for this code to be ignored. The
   * finding stays visible so a reviewer can see what was waived, but it does
   * not count towards the summary or trip `--fail-on`.
   */
  readonly ignored?: boolean;
}

export interface WordPressTerm {
  readonly domain: string;
  readonly nicename: string;
  readonly name: string;
}

export type WordPressPostMeta = Readonly<Record<string, readonly string[]>>;

export interface ContentRecord {
  readonly sourceId: string;
  readonly wordpressId: number;
  readonly type: WordPressContentType;
  readonly status: WordPressStatus;
  readonly title: string;
  readonly slug: string;
  readonly route?: string;
  readonly publishedAt?: string;
  /**
   * The same publication time from `wp:post_date_gmt`, kept separately because
   * only this one is known to be UTC and can therefore date a feed item.
   */
  readonly publishedAtGmt?: string;
  readonly modifiedAt?: string;
  readonly author?: string;
  readonly editor: SourceEditor;
  readonly rawContent: string;
  readonly meta: WordPressPostMeta;
  readonly terms: readonly WordPressTerm[];
  readonly nodes: readonly MigrationNode[];
  readonly issues: readonly MigrationIssue[];
}

/**
 * How a media reference was found. The kind records where the reference came
 * from so a reviewer can tell widget settings apart from rendered HTML.
 */
export type MediaReferenceKind =
  | "gutenberg-image"
  | "gutenberg-gallery"
  | "elementor-image"
  | "elementor-background"
  | "html-image"
  | "featured-image";

/**
 * `matched` means the export carries a matching attachment item.
 * `missing-alt-text` means it carries one, but nothing in the export or the
 * content describes the image. `not-in-export` means no attachment item
 * matched, so the asset has to come from somewhere else.
 */
export type MediaReferenceStatus = "matched" | "missing-alt-text" | "not-in-export";

/**
 * One attachment item from the export. This is an inventory entry only: no
 * media is downloaded, copied, re-encoded, or rewritten.
 */
export interface MediaAsset {
  readonly id: string;
  readonly wordpressId: number;
  readonly parentId?: number;
  readonly title: string;
  /** Path of the asset on the source site, without query or fragment. */
  readonly path?: string;
  /**
   * Path of the attachment page WordPress served for this upload, when the
   * export carries the permalink. Attachment pages usually redirect to the
   * file itself.
   */
  readonly pagePath?: string;
  /** Sanitized absolute source URL, when the export provides one. */
  readonly url?: string;
  /** `_wp_attached_file`, such as `2026/05/repair.jpg`. */
  readonly file?: string;
  readonly mimeType?: string;
  readonly altText?: string;
  readonly width?: number;
  readonly height?: number;
  /** Number of included content records that reference this asset. */
  readonly referenceCount: number;
  /** Source record identifiers that reference this asset. */
  readonly referencedBy: readonly string[];
  /**
   * How the generated site serves this asset, once a delivery plan exists.
   * Absent when the caller planned no media delivery, which leaves the
   * handoff exactly as 0.6 wrote it.
   */
  readonly delivery?: MediaAssetDelivery;
}

/** One place a content record refers to media, deduplicated per record. */
export interface MediaReference {
  readonly id: string;
  readonly sourceId: string;
  readonly route?: string;
  readonly nodeId?: string;
  readonly kind: MediaReferenceKind;
  readonly path?: string;
  readonly url?: string;
  readonly altText?: string;
  /** Set when a matching attachment item was found in the export. */
  readonly assetId?: string;
  readonly status: MediaReferenceStatus;
}

export interface MediaSummary {
  /** Attachment items found in the export. */
  readonly assets: number;
  /** Assets referenced by at least one included content record. */
  readonly referenced: number;
  readonly references: number;
  readonly matched: number;
  readonly missingAltText: number;
  readonly notInExport: number;
  /** Attachments no included content record refers to. */
  readonly unusedAssets: number;
  /** Counts from the delivery plan, when the caller planned one. */
  readonly delivery?: MediaDeliverySummary;
}

/**
 * How one media file is served by the generated site.
 *
 * `copied` means a local file was supplied and the copy is written into the
 * output. `linked` means the file stays on a media host the caller named, and
 * the generated markup points there. `remote` means the source URL is left
 * exactly as the export wrote it, which is what happens for media this export
 * cannot vouch for. `missing` means the export carries the attachment but no
 * local file and no media host were supplied, so nothing can be served.
 */
export type MediaDeliveryStatus = "copied" | "linked" | "remote" | "missing";

/** Delivery state rolled up from the paths that point at one attachment. */
export interface MediaAssetDelivery {
  readonly status: MediaDeliveryStatus;
  /** Path the generated site serves, when it serves the file itself. */
  readonly outputPath?: string;
}

/**
 * One file the plan will deliver, keyed by the path the source used. A resized
 * variant the uploads directory does not carry can still be delivered by its
 * original file: `sourcePath` is what the export referenced and `outputPath`
 * is what the generated site serves in its place.
 */
export interface MediaDeliveryEntry {
  readonly id: string;
  /** Source path, such as /wp-content/uploads/2026/05/tap-768x512.jpg. */
  readonly sourcePath: string;
  /** Attachment the path resolved to, when the export carries one. */
  readonly assetId?: string;
  readonly status: MediaDeliveryStatus;
  /** Site-relative path the generated site serves, when it serves it. */
  readonly outputPath?: string;
  /** Absolute URL the generated markup should use, when the file is not local. */
  readonly url?: string;
  /** Measured size of the local file, when one was supplied. */
  readonly byteSize?: number;
  readonly reason: string;
}

export interface MediaDeliverySummary {
  /** True when the caller supplied a place for media to come from. */
  readonly planned: boolean;
  /** Distinct source paths the plan looked at. */
  readonly files: number;
  readonly copied: number;
  readonly linked: number;
  readonly remote: number;
  readonly missing: number;
  /** Bytes the copy step writes, measured from the files it found. */
  readonly bytes: number;
}

/**
 * What the generated site will do with each referenced media file. The plan is
 * built from local files only: it reads an uploads directory, and it never
 * requests the URLs it rewrites.
 */
export interface MediaDeliveryPlan {
  /** Where the files come from, for a reader of the artifacts. */
  readonly source: "uploads-directory" | "base-url" | "none";
  /** The uploads directory root the plan read, when one was supplied. */
  readonly uploadsDirectory?: string;
  /** The media host the plan points at, when one was supplied. */
  readonly baseUrl?: string;
  readonly entries: readonly MediaDeliveryEntry[];
  readonly summary: MediaDeliverySummary;
  /**
   * Local files to copy, keyed by the site-relative path they are written to.
   * Kept separate from the entries so an artifact can describe the delivery
   * without recording where the machine keeps its files.
   */
  readonly copies: readonly MediaCopy[];
}

/** One local file to write into the generated site. */
export interface MediaCopy {
  /** Absolute path of the local file that was found. */
  readonly localPath: string;
  /** Site-relative path, always under /wp-content/uploads/. */
  readonly outputPath: string;
  readonly byteSize: number;
}

export interface MediaDeliveryOptions {
  /**
   * A local copy of the source uploads directory. Files are matched by the
   * path the export recorded, and nothing is ever fetched.
   */
  readonly uploadsDirectory?: string;
  /** A media host that already serves the uploads, such as a CDN origin. */
  readonly baseUrl?: string;
  /** Also deliver attachments no included content record references. */
  readonly copyUnusedAssets?: boolean;
}

export interface MigrationMedia {
  readonly assets: readonly MediaAsset[];
  readonly references: readonly MediaReference[];
  readonly summary: MediaSummary;
  /** The delivery plan, present only when the caller planned one. */
  readonly delivery?: MediaDeliveryPlan;
}

export type RouteStatus =
  | "generated"
  | "duplicate-route"
  | "excluded"
  | "skipped"
  | "ambiguous-url";

/**
 * One exported page/post permalink and its mapping in the handoff. For an
 * ambiguous URL or duplicate route, `targetRoute` is only a proposed path;
 * the source URL still needs a decision before publishing.
 */
export interface RouteEntry {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourceUrl?: string;
  readonly sourcePath?: string;
  readonly targetRoute?: string;
  readonly status: RouteStatus;
  readonly reason: string;
}

/** A source path that needs a redirect rule on whatever hosts the new site. */
export interface RedirectEntry {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourcePath: string;
  readonly targetRoute: string;
  readonly reason: string;
}

export interface RouteSummary {
  readonly sourceUrls: number;
  /** Unique, unambiguous page/post route mappings. */
  readonly generated: number;
  readonly redirects: number;
  /** Source URLs without a confirmed mapping, including unresolved ones. */
  readonly withoutTarget: number;
  readonly duplicateRoutes: number;
}

export interface MigrationRoutes {
  readonly entries: readonly RouteEntry[];
  readonly redirects: readonly RedirectEntry[];
  readonly summary: RouteSummary;
}

/**
 * One WordPress post type the export carried, and what this run did with it.
 * `sourceItems` counts what the file contains; `records` counts what became
 * content in the handoff, so a type the scan left out is visible rather than
 * absent.
 */
export interface ContentTypeEntry {
  readonly name: string;
  /** Human label for reports, derived from the slug. */
  readonly label: string;
  /** Directory under `src/content/` this type generates into. */
  readonly collection: string;
  readonly sourceItems: number;
  readonly records: number;
  readonly included: boolean;
  /** Why the type was left out, when it was. */
  readonly reason?: string;
}

/** How a navigation entry resolves against the rest of this plan. */
export type MenuItemKind = "post" | "taxonomy" | "custom" | "post-type-archive" | "unknown";

/** One menu entry, with its children in export order. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly kind: MenuItemKind;
  /** The target as the export recorded it, sanitized. */
  readonly url?: string;
  /** Rendering destination, including query and fragment; omitted from review artifacts. */
  readonly href?: string;
  /** The generated route this plan serves the target at, when it serves one. */
  readonly targetRoute?: string;
  readonly parentId?: string;
  readonly children: readonly MenuItem[];
  /** Set when nothing in this plan serves the entry. */
  readonly reason?: string;
}

/** One WordPress menu, as the export's `nav_menu_item` items describe it. */
export interface MenuTree {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly items: readonly MenuItem[];
}

export interface MenuSummary {
  readonly menus: number;
  readonly items: number;
  /** Entries no generated route serves, which need a decision. */
  readonly unresolved: number;
}

export interface MigrationMenus {
  readonly trees: readonly MenuTree[];
  readonly summary: MenuSummary;
}

/** The WordPress views a static site has to reproduce deliberately. */
export type ArchiveKind = "taxonomy" | "author" | "date" | "posts-index";

/**
 * How an archive route was chosen. A route taken from a live URL the caller
 * supplied is evidence; a route built from a WordPress default is an
 * assumption, and the report says which is which.
 */
export type ArchiveRouteSource = "live-url" | "wordpress-default" | "derived" | "config";

/** One generated listing page: a term, an author, a month, or the posts index. */
export interface ArchivePage {
  readonly id: string;
  readonly kind: ArchiveKind;
  readonly title: string;
  readonly route: string;
  /**
   * What this listing is about, as `category:guides`, `author:niko`,
   * `date:2026-06` or `posts`. Menus and other planners line archives up by
   * subject rather than by guessing from a URL.
   */
  readonly subject: string;
  /** The URL WordPress answered this archive on, when the caller supplied it. */
  readonly sourceUrl?: string;
  /** Records this page lists, in plan order. */
  readonly sourceIds: readonly string[];
  readonly routeSource: ArchiveRouteSource;
  /** True for `/page/2/` and later, which serve the tail of a listing. */
  readonly paginated: boolean;
}

/** One feed the plan writes as a static file. */
export interface FeedFile {
  readonly id: string;
  /** Site-relative path the file is served at, such as `/feed.xml`. */
  readonly path: string;
  /** The path WordPress served a feed on, when the live URLs named one. */
  readonly sourcePath?: string;
  readonly title: string;
  readonly sourceIds: readonly string[];
}

export interface ArchiveSummary {
  readonly taxonomies: number;
  readonly authors: number;
  readonly dates: number;
  readonly postsIndex: number;
  /** Routes taken from a live URL rather than assumed. */
  readonly fromLiveUrls: number;
  /** Routes that use a base this export does not confirm. */
  readonly assumed: number;
  readonly feeds: number;
}

export interface MigrationArchives {
  readonly pages: readonly ArchivePage[];
  readonly feeds: readonly FeedFile[];
  readonly summary: ArchiveSummary;
}

export type LinkReferenceKind = "html-anchor" | "gutenberg-button" | "elementor-button";

/**
 * `resolves` means the generated route already matches the link as written.
 * `needs-rewrite` means a route exists but the href has to change to reach it.
 * `no-target` means the export knows the URL but generates no page for it.
 * `outside-export` means a same-site link no item in this export declares.
 * `external` means a different host, which stays untouched.
 */
export type LinkReferenceStatus =
  | "resolves"
  | "needs-rewrite"
  | "no-target"
  | "outside-export"
  | "external";

/** One link found in a content record, deduplicated per record. */
export interface LinkReference {
  readonly id: string;
  readonly sourceId: string;
  readonly route?: string;
  readonly nodeId?: string;
  readonly kind: LinkReferenceKind;
  /** The link target exactly as written; reporting sanitizes it. */
  readonly href: string;
  readonly path?: string;
  readonly fragment?: string;
  readonly host?: string;
  /** The generated route this link resolves to, when one exists. */
  readonly targetRoute?: string;
  /** The href the generated content should use, when it has to differ. */
  readonly rewritten?: string;
  readonly status: LinkReferenceStatus;
  readonly reason: string;
}

export interface LinkSummary {
  readonly references: number;
  /** Same-site links: the ones this handoff can reason about. */
  readonly internal: number;
  readonly resolves: number;
  readonly needsRewrite: number;
  readonly noTarget: number;
  readonly outsideExport: number;
  readonly external: number;
}

/** One proposed rewrite, applied during conversion unless disabled. */
export interface LinkRewrite {
  readonly id: string;
  readonly sourceId: string;
  readonly href: string;
  readonly rewritten: string;
  readonly reason: string;
}

export interface MigrationLinks {
  readonly references: readonly LinkReference[];
  readonly summary: LinkSummary;
}

/**
 * Live URLs the caller supplied for checking: a sitemap they downloaded, a
 * sitemap index, or a plain list of URLs. Nothing here is fetched.
 */
export interface LiveUrlSource {
  /** Page and asset URLs read from the supplied files. */
  readonly urls: readonly string[];
  /** Sitemap files a sitemap index points at. This tool never fetches them. */
  readonly sitemapRefs: readonly string[];
}

/**
 * `routed` means a generated page serves this path. `redirected` means a
 * proposed rule in the redirect map already covers it, so it still has to be
 * published. `unresolved` means the export declares the URL but the scan did
 * not map it, such as an excluded draft. `excluded-shape` means the URL is a
 * WordPress shape this handoff does not serve, such as a feed, an upload, an
 * archive or a query-string permalink. `external-host` means another site.
 * `invalid-url` means the entry could not be read as a URL. `uncovered` is the
 * one that needs a new route or a new rule.
 */
export type LiveUrlStatus =
  | "routed"
  | "redirected"
  | "unresolved"
  | "excluded-shape"
  | "external-host"
  | "invalid-url"
  | "uncovered";

/** The WordPress shapes a coverage check recognizes without inventing a route. */
export type LiveUrlShape =
  | "feed"
  | "media-file"
  | "wordpress-endpoint"
  | "taxonomy-archive"
  | "date-archive"
  | "author-archive"
  | "paged"
  | "query-url";

/** One live URL compared against the routes and rules this plan proposes. */
export interface LiveUrlEntry {
  readonly id: string;
  /** Sanitized live URL without credentials, query string or fragment. */
  readonly url?: string;
  readonly host?: string;
  readonly path?: string;
  /** True when the URL carries a query string, which no path rule can match. */
  readonly hasQuery: boolean;
  readonly status: LiveUrlStatus;
  readonly shape?: LiveUrlShape;
  /** The generated route that serves this URL, or that a rule points it at. */
  readonly targetRoute?: string;
  /** Route status behind an unresolved URL, such as `excluded`. */
  readonly sourceStatus?: RouteStatus;
  readonly reason: string;
}

export interface LiveUrlSummary {
  /** True when the caller supplied live URLs to compare against the plan. */
  readonly checked: boolean;
  /** Distinct live URLs read from the supplied sources. */
  readonly liveUrls: number;
  readonly routed: number;
  readonly redirected: number;
  readonly unresolved: number;
  /** Feeds, uploads, archives and query URLs no static route serves. */
  readonly excluded: number;
  readonly externalHosts: number;
  readonly invalid: number;
  /** Live URLs with no route, no rule and no recognized WordPress shape. */
  readonly uncovered: number;
  /** Sitemap indexes pointing at child sitemaps this tool does not fetch. */
  readonly sitemapRefs: number;
}

export interface LiveUrlCoverage {
  readonly entries: readonly LiveUrlEntry[];
  readonly summary: LiveUrlSummary;
}

export interface MigrationSummary {
  readonly records: number;
  readonly pages: number;
  readonly posts: number;
  /** Content records per WordPress post type, including `page` and `post`. */
  readonly types: Readonly<Record<string, number>>;
  readonly nodes: number;
  readonly nativeNodes: number;
  readonly manualNodes: number;
  readonly blockedNodes: number;
  readonly reviewItems: number;
  readonly warnings: number;
  readonly blockers: number;
  readonly media: MediaSummary;
  readonly routes: RouteSummary;
  readonly links: LinkSummary;
  readonly archives: ArchiveSummary;
  readonly menus: MenuSummary;
}

export interface MigrationProject {
  readonly site: {
    readonly title: string;
    readonly url?: string;
  };
  readonly source: {
    readonly title?: string;
    readonly url?: string;
  };
  readonly records: readonly ContentRecord[];
  readonly issues: readonly MigrationIssue[];
  /** Every WordPress post type the export carried and what this run did with it. */
  readonly types: readonly ContentTypeEntry[];
  readonly media: MigrationMedia;
  readonly routes: MigrationRoutes;
  readonly links: MigrationLinks;
  readonly coverage: LiveUrlCoverage;
  readonly archives: MigrationArchives;
  readonly menus: MigrationMenus;
  readonly summary: MigrationSummary;
  /** The decisions a migration config applied, when the run read one. */
  readonly config?: MigrationConfigRecord;
}

/** The exit-status gate a command was given. */
export type FailureThreshold = "none" | "warning" | "blocker";

/**
 * A migration config lets a caller decide what the export cannot: where an
 * ambiguous permalink should land, which items to leave out, and which
 * findings have been reviewed and waived. Every key is optional, and a key the
 * parser does not know is an error rather than something silently ignored.
 */
export interface MigrationConfig {
  readonly schemaVersion?: string;
  readonly site?: {
    readonly title?: string;
    readonly url?: string;
  };
  readonly includeDrafts?: boolean;
  readonly keepSourceLinks?: boolean;
  readonly failOn?: FailureThreshold;
  /**
   * Decided routes, keyed by a WordPress content id such as `wp:page:12`, an
   * exported path such as `/old-page/`, a query permalink such as `?p=123`, or
   * the exported URL itself. The value is the route the item should generate.
   */
  readonly routes?: Readonly<Record<string, string>>;
  /** Items to leave out of the handoff, by content id or exported URL. */
  readonly exclude?: readonly string[];
  /** Issue codes a reviewer has already looked at and accepted. */
  readonly ignoreIssues?: readonly MigrationIssueCode[];
  /**
   * Which WordPress post types become content. The default brings across every
   * type the export carries except the ones that are not content.
   */
  readonly postTypes?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
  /**
   * The views WordPress generated from settings a WXR file does not carry.
   * Term and author archives default on, because dropping a URL is the failure
   * this tool exists to prevent. Everything else has to be asked for.
   */
  readonly archives?: {
    readonly taxonomies?: boolean;
    readonly authors?: boolean;
    readonly dates?: boolean;
    /** Where the posts index lives, such as `/blog/`. No default is invented. */
    readonly postsIndex?: string;
    /** Posts per listing page, which decides the `/page/2/` routes. */
    readonly perPage?: number;
    /** Feed paths to write, such as `/feed/`. */
    readonly feeds?: readonly string[];
    /** What to do with WordPress attachment pages. */
    readonly attachmentPages?: "redirect" | "ignore";
  };
  /** Where the files for the media inventory come from. */
  readonly media?: {
    readonly uploadsDir?: string;
    readonly baseUrl?: string;
    readonly copyUnused?: boolean;
  };
}

/**
 * What the config did, so a plan can be traced back to the decisions behind
 * it. The file's own path stays in the caller's artifacts: the generated
 * project records the counts, not where this machine keeps its files.
 */
export interface MigrationConfigRecord {
  readonly decisions: {
    /** Route overrides that matched an item in this export. */
    readonly routes: number;
    /** Items the config left out of the handoff. */
    readonly exclusions: number;
    /** Findings the config waived, counted after the scan. */
    readonly ignoredIssues: number;
    /** The issue codes the config asked to waive, whether or not they occurred. */
    readonly ignoredIssueCodes: readonly MigrationIssueCode[];
  };
}

export interface InspectOptions {
  readonly includeDrafts?: boolean;
  /**
   * Live URLs to compare against the generated routes and redirect rules.
   * Read the file yourself with `parseLiveUrlSource`; the parser never
   * touches the filesystem or the network.
   */
  readonly liveUrlSource?: LiveUrlSource;
  /**
   * Decisions the export cannot make on its own. Read the file yourself with
   * `loadMigrationConfig`; the parser never touches the filesystem.
   */
  readonly config?: MigrationConfig;
}

/**
 * How one planned route compares with the page someone built or crawled.
 * `verified` means the page carries the record's text within tolerance,
 * `diverged` means noticeably less or substantially different text,
 * `missing-content` means almost none of it, `route-missing` means no page
 * was found or successfully fetched at the route, and
 * `skipped` means the record carried too little text, or the observed source
 * carried no evidence, for a judgement to be worth making.
 */
export type VerificationStatus =
  | "verified"
  | "diverged"
  | "missing-content"
  | "route-missing"
  | "skipped";

export interface VerifiedRoute {
  readonly id: string;
  readonly sourceId: string;
  readonly route: string;
  readonly status: VerificationStatus;
  /** Words in the text the export carries for this record. */
  readonly sourceWords: number;
  /** Words in the observed page, when a page was found. */
  readonly observedWords?: number;
  /** Hamming distance between the two SimHashes, when both were available. */
  readonly simhashDistance?: number;
  readonly reason: string;
  readonly requiredAction?: string;
}

export interface VerificationSummary {
  readonly routes: number;
  readonly verified: number;
  readonly diverged: number;
  readonly missingContent: number;
  readonly routeMissing: number;
  readonly skipped: number;
  /** Observed pages that carry no `<title>`. */
  readonly withoutTitle: number;
  /** Observed pages that carry no `<h1>`. */
  readonly withoutHeading: number;
  /** Findings that gate publishing at blocker severity. */
  readonly launchBlockers: number;
  /** Findings that need review before publishing. */
  readonly launchWarnings: number;
  /** Checks this run could not take, which must never read as passed. */
  readonly uncheckedChecks: number;
}

/**
 * `delivered` means all probes returned complete successful responses,
 * `failed` means a probe answered with a status outside the successful range,
 * `incomplete` means a probe did not finish, and `unobserved` means the
 * report carries no target for this route.
 */
export type DeliveryStatus = "delivered" | "failed" | "incomplete" | "unobserved";

/** Whether a delivered page lets a crawler index it. */
export type IndexingStatus = "indexable" | "blocked" | "unknown";

/** The part of a response that carries robots directives. */
export type IndexingSource = "meta" | "header";

/** What one response said about indexing, and which part of it said so. */
export interface IndexingEvidence {
  readonly status: IndexingStatus;
  readonly sources: readonly IndexingSource[];
}

/** One SSRWire finding, reduced to what a migration gate needs. */
export interface DeliveryFinding {
  readonly code: string;
  readonly severity: DeliverySeverity;
  readonly agent?: string;
}

export type DeliverySeverity = "info" | "warning" | "error";

/** One planned route and what a saved delivery audit said about it. */
export interface RouteDelivery {
  readonly id: string;
  readonly sourceId: string;
  readonly route: string;
  /** The SSRWire target id, when the report carried one. */
  readonly targetId?: string;
  readonly status: DeliveryStatus;
  readonly httpStatus?: number;
  /** Distinct user-agent profiles the report observed for this route. */
  readonly agents: number;
  readonly indexing: IndexingStatus;
  /** The parts of the response that block indexing, when any do. */
  readonly indexingSources: readonly IndexingSource[];
  /** Open Graph and Twitter Card properties the response carried, by name. */
  readonly socialMetadata: readonly string[];
  /** Distinct SSRWire findings for this route, ordered by code. */
  readonly findings: readonly DeliveryFinding[];
  readonly reason: string;
  readonly requiredAction?: string;
}

export interface DeliverySummary {
  /** True when a delivery report was supplied to the check. */
  readonly checked: boolean;
  /** Planned routes the supplied report covers. */
  readonly covered: number;
  readonly delivered: number;
  readonly failed: number;
  readonly incomplete: number;
  /** Planned routes the report says nothing about. */
  readonly unobserved: number;
  /** Covered routes whose delivered page blocks indexing. */
  readonly blockedIndexing: number;
  /** Targets in the report that no planned route accounts for. */
  readonly unmatchedTargets: number;
  /** Errors and warnings SSRWire reported across the covered routes. */
  readonly errors: number;
  readonly warnings: number;
}

/**
 * One difference SSRWire found between the site before the migration and the
 * site after it. Codes, fields, agents, finding severities and numeric
 * comparisons are kept; the metadata text itself never is.
 */
export interface DeliveryChange {
  readonly id: string;
  readonly route: string;
  readonly kind: "regression" | "fixed" | "changed";
  readonly scope: string;
  readonly code: string;
  readonly field?: string;
  /** The user-agent profiles that saw this difference, sorted. */
  readonly agents: readonly string[];
  /** Finding severity before and after, when the change compares findings. */
  readonly baselineSeverity?: DeliverySeverity;
  readonly candidateSeverity?: DeliverySeverity;
  /** Numeric and boolean comparisons, such as a status code. */
  readonly baselineValue?: number | boolean;
  readonly candidateValue?: number | boolean;
  /**
   * Whether the compared metadata was present on each side. The values
   * themselves are never stored, but losing or gaining a tag is a different
   * problem from changing it, and only the direction says which.
   */
  readonly baselinePresent?: boolean;
  readonly candidatePresent?: boolean;
  /** Wording this tool derives from the change, never the compared text. */
  readonly message: string;
}

export interface RouteComparison {
  readonly id: string;
  readonly route: string;
  readonly status: "matched" | "added" | "removed";
  /**
   * False when the baseline is absent or any of its probes failed, such as a
   * source capture taken while the site was down or against the wrong host.
   * The changes are kept as evidence, but nothing can be concluded from them.
   */
  readonly baselineComplete: boolean;
  readonly changes: readonly DeliveryChange[];
  readonly regressions: number;
  readonly fixed: number;
  readonly changed: number;
}

export interface DeliveryComparison {
  /** The candidate report file the comparison was based on. */
  readonly source: string;
  /** The baseline report file it was compared with. */
  readonly baselineSource: string;
  readonly candidate: {
    readonly version: string;
    readonly generatedAt: string;
  };
  readonly baseline: {
    readonly version: string;
    readonly generatedAt: string;
  };
  /** Comparisons that map onto a planned route. */
  readonly routes: readonly RouteComparison[];
  /** Compared targets no planned route accounts for. */
  readonly unmatched: number;
  readonly summary: {
    readonly matchedTargets: number;
    readonly addedTargets: number;
    readonly removedTargets: number;
    readonly unchangedTargets: number;
    readonly regressions: number;
    readonly fixed: number;
    readonly changed: number;
    /** Routes whose baseline audit did not complete, so nothing can be concluded. */
    readonly unusableBaselines: number;
  };
}

/**
 * Delivery evidence comes from a saved SSRWire audit, which is the only reason
 * this comparison can see response status, streaming metadata and
 * crawler-specific delivery at all: this tool never requests a URL.
 */
export interface DeliveryEvidence {
  readonly observed: "ssrwire-report";
  /** The local report file this evidence was read from. */
  readonly source: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly routes: readonly RouteDelivery[];
  readonly summary: DeliverySummary;
  readonly comparison?: DeliveryComparison;
}

/**
 * A finding that gates publishing rather than content fidelity: the built page
 * blocks indexing, a route answered badly, or the rebuilt site lost something
 * the source site delivered.
 */
export type LaunchFindingCode =
  | "INDEXING_BLOCKED"
  | "DELIVERY_FAILED"
  | "DELIVERY_INCOMPLETE"
  | "DELIVERY_CONTRACT"
  | "DELIVERY_REGRESSION"
  | "DELIVERY_UNOBSERVED"
  | "MEDIA_MISSING_IN_BUILD"
  | "MEDIA_EMPTY_IN_BUILD"
  | "LINK_TARGET_MISSING_IN_BUILD"
  | "CANONICAL_MISSING"
  | "ROBOTS_BLOCKED"
  | "SITEMAP_INCOMPLETE"
  | "IMPORT_RECORD_MISSING"
  | "IMPORT_RECORD_FAILED"
  | "IMPORT_RECORD_SKIPPED"
  | "IMPORT_RECORD_UNKNOWN";

/** Every check the launch gate can take, and whether this run took it. */
export type VerificationCheckId =
  | "content"
  | "media"
  | "links"
  | "canonical"
  | "robots"
  | "sitemap"
  | "delivery"
  | "import";

/**
 * One check in the launch gate. A check that could not run says so: reading
 * "not checked" as "passed" is the failure mode a launch gate exists to avoid.
 */
export interface VerificationCheck {
  readonly id: VerificationCheckId;
  readonly label: string;
  readonly checked: boolean;
  readonly reason?: string;
}

/** The local build or saved report a publishing finding was read from. */
export type LaunchEvidenceSource = "html-directory" | "routelint-report" | "ssrwire-report" | "import-report";

export interface LaunchFinding {
  readonly id: string;
  readonly severity: MigrationIssueSeverity;
  readonly code: LaunchFindingCode;
  /** The route this finding is about, when it is about exactly one. */
  readonly route?: string;
  /**
   * Every route the finding covers. A problem the whole template causes is one
   * thing to fix, so it is reported once with the routes it affects rather than
   * once per page.
   */
  readonly routes?: readonly string[];
  /** The local build or saved report this finding came from. */
  readonly source: LaunchEvidenceSource;
  readonly agent?: string;
  /** The compared field behind this finding, such as a metadata key or a timing metric. */
  readonly field?: string;
  /** The compared fields behind this finding, when several were lost together. */
  readonly fields?: readonly string[];
  /** The underlying tool finding, such as `missing-canonical`. */
  readonly sourceCode?: string;
  readonly title: string;
  readonly message: string;
  readonly requiredAction: string;
}

export interface SiteVerification {
  readonly observed: "html-directory" | "routelint-report" | "import-report";
  /** The local directory or report file the comparison read. */
  readonly source: string;
  readonly routes: readonly VerifiedRoute[];
  readonly summary: VerificationSummary;
  /** What the launch gate checked, and what it could not check. */
  readonly checks: readonly VerificationCheck[];
  /** Delivery evidence from a saved SSRWire report, when one was supplied. */
  readonly delivery?: DeliveryEvidence;
  /** Evidence from a generated CMS importer's report, when one was supplied. */
  readonly imports?: ImportEvidence;
  /** Findings that gate publishing rather than content fidelity. */
  readonly launch: readonly LaunchFinding[];
}

/**
 * What the generated importer did with one record. `unchanged` means the drop
 * and the CMS copy agreed; `skipped` means the CMS copy was edited after the
 * last import, so the importer left it alone and said so.
 */
export type ImportAction = "created" | "updated" | "unchanged" | "skipped" | "failed";

/** One record a CMS importer reported on, keyed by its stable source id. */
export interface ImportRecord {
  readonly id: string;
  /** The stable source id, such as `wp:post:20`. */
  readonly sourceId: string;
  readonly collection: string;
  readonly postType?: string;
  readonly route?: string;
  readonly title?: string;
  readonly action: ImportAction;
  /** Why the importer skipped or failed a record, in its own words. */
  readonly reason?: string;
  /** Reference markers the importer could not resolve against an earlier pass. */
  readonly unresolved: readonly string[];
}

export interface ImportSummary {
  readonly planned: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  /** Reference markers no created record accounted for. */
  readonly unresolved: number;
}

/**
 * Evidence from the importer a CMS bundle generates. It answers the question a
 * content check cannot: did the records arrive in the CMS, and what still
 * needs a human there. The report is keyed by the same stable source ids the
 * manifest uses, so the plan and the import line up without guessing.
 */
export interface ImportEvidence {
  readonly observed: "import-report";
  /** The local import report file this evidence was read from. */
  readonly source: string;
  readonly version: string;
  readonly generatedAt: string;
  /** The destination the report came from, such as `payload`. */
  readonly target: string;
  readonly records: readonly ImportRecord[];
  readonly summary: ImportSummary;
}
