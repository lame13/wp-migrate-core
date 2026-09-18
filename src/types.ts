export type OutputTarget = "astro" | "next" | "nuxt";

export type WordPressContentType = "page" | "post";

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

export type MigrationIssueCode =
  | "WXR_NO_ITEMS"
  | "WXR_ITEM_MISSING_ID"
  | "WXR_ITEM_INVALID_ID"
  | "WXR_ITEM_DUPLICATE_ID"
  | "GUTENBERG_UNCLOSED_BLOCK"
  | "GUTENBERG_UNMATCHED_CLOSE"
  | "GUTENBERG_INVALID_ATTRIBUTES"
  | "GUTENBERG_DYNAMIC_BLOCK"
  | "GUTENBERG_MEDIA_UNSUPPORTED"
  | "GUTENBERG_UNKNOWN_BLOCK"
  | "SHORTCODE_UNSUPPORTED"
  | "ELEMENTOR_INVALID_DATA"
  | "ELEMENTOR_FORM_UNSUPPORTED"
  | "ELEMENTOR_QUERY_UNSUPPORTED"
  | "ELEMENTOR_IMAGE_REMOTE_MEDIA"
  | "ELEMENTOR_BUTTON_UNSAFE_URL"
  | "ELEMENTOR_WIDGET_UNKNOWN"
  | "MEDIA_MISSING_ALT_TEXT"
  | "MEDIA_MISSING_FROM_EXPORT"
  | "LINK_TARGET_MISSING"
  | "LINK_TARGET_OUTSIDE_EXPORT";

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
}

export interface MigrationMedia {
  readonly assets: readonly MediaAsset[];
  readonly references: readonly MediaReference[];
  readonly summary: MediaSummary;
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

export interface MigrationSummary {
  readonly records: number;
  readonly pages: number;
  readonly posts: number;
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
  readonly media: MigrationMedia;
  readonly routes: MigrationRoutes;
  readonly links: MigrationLinks;
  readonly summary: MigrationSummary;
}

export interface InspectOptions {
  readonly includeDrafts?: boolean;
}
