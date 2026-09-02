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
  | "ELEMENTOR_WIDGET_UNKNOWN";

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
  readonly summary: MigrationSummary;
}

export interface InspectOptions {
  readonly includeDrafts?: boolean;
}
