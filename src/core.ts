import type {
  ContentRecord,
  ConversionDisposition,
  InspectOptions,
  MediaAsset,
  MediaReference,
  MediaReferenceKind,
  MediaReferenceStatus,
  MediaSummary,
  MigrationIssue,
  MigrationIssueCode,
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
  const channelHeader = xml.slice(0, xml.search(/<item\b/i) === -1 ? xml.length : xml.search(/<item\b/i));
  const items = readWxrItems(xml);

  // Attachments are collected first so content references can be matched
  // against them regardless of where the export places the attachment items.
  const baseAssets = buildMediaAssets(
    items.filter((item) => item.postType === "attachment").map((item) => item.xml)
  );
  const assetIndex = createMediaAssetIndex(baseAssets);

  for (const item of items) {
    const { xml: itemXml, postType } = item;
    if (postType !== "page" && postType !== "post") {
      continue;
    }

    const sourceUrl = cleanOptionalField(readTag(itemXml, "link"));
    const status = normalizeStatus(cleanField(readTag(itemXml, "wp:status")));
    if (!options.includeDrafts && status !== "publish") {
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

    seenWordPressIds.add(wordpressId);
    const record = parseItem(itemXml, postType, status, wordpressId);
    records.push(record);
    pendingRoutes.push({
      id: `route:${pendingRoutes.length + 1}`,
      sourceId: record.sourceId,
      sourceUrl,
      record,
      status: "generated",
      reason: sourceUrl === undefined ? "Generated from the item slug because no permalink was exported." : "Generated from the exported permalink."
    });
  }

  if (records.length === 0) {
    projectIssues.push({
      id: "project:WXR_NO_ITEMS:1",
      severity: "warning",
      code: "WXR_NO_ITEMS",
      sourceId: "project",
      title: "No eligible WordPress content found",
      message: "The WXR input contains no posts or pages included by the current scan settings.",
      requiredAction: "Confirm that the export includes published posts or pages. Drafts are excluded by default; library users can pass { includeDrafts: true } when appropriate."
    });
  }

  const referencesByRecord = records.map((record) => collectMediaReferences(record, assetIndex));
  const annotatedRecords = records.map((record, index) => withMediaIssues(record, referencesByRecord[index] ?? []));
  const media = finalizeMedia(baseAssets, referencesByRecord.flat());
  const routes = finalizeRoutes(pendingRoutes);
  const recordIssues = annotatedRecords.flatMap((record) => record.issues);
  const issues = [...projectIssues, ...recordIssues];

  const source = compactOptionalObject({
    title: cleanOptionalField(readTag(channelHeader, "title")),
    url: cleanOptionalField(readTag(channelHeader, "link"))
  });

  return {
    site: {
      title: source.title ?? "WordPress migration",
      ...(source.url === undefined ? {} : { url: source.url })
    },
    source,
    records: annotatedRecords,
    issues,
    media,
    routes,
    summary: summarize(annotatedRecords, issues, media.summary, routes.summary)
  };
}

export const inspectWxr = parseWxr;

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
      "Elementor image widgets are withheld until their media is added locally.",
      "Download or import the image into local Astro assets, verify it, and rebuild this widget.",
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
      `Gutenberg ${node.sourceType === "core/image" ? "image" : "gallery"} media is withheld until local assets are added.`,
      "Import approved local media, write appropriate alternative text, and rebuild this content deliberately.",
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
}

interface MediaAssetDraft {
  readonly id: string;
  readonly wordpressId: number;
  readonly parentId?: number;
  readonly title: string;
  readonly path?: string;
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

  return {
    id: `media:${wordpressId}`,
    wordpressId,
    ...optionalProperty("parentId", parseWordPressId(cleanField(readTag(itemXml, "wp:post_parent")))),
    title: cleanField(readTag(itemXml, "title")) || file || `Attachment ${wordpressId}`,
    ...optionalProperty("path", path),
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
    const key = asset?.id ?? mediaKey(url) ?? (candidate.id === undefined ? undefined : `id:${candidate.id}`);
    if (key === undefined) {
      return;
    }

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
    }
  };

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
    const status: MediaReferenceStatus =
      asset === undefined ? "not-in-export" : altText === undefined ? "missing-alt-text" : "matched";

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

function readHtmlAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(tag);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return value === "" ? undefined : decodeXmlEntities(value);
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
function mediaPath(value: string | undefined): string | undefined {
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

function stripMediaVariants(value: string): string {
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
  const targets = pending.map((entry) => (entry.record === undefined ? undefined : targetRouteFor(entry.record)));
  const targetCounts = new Map<string, number>();
  for (const target of targets) {
    if (target !== undefined) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    }
  }

  const entries: RouteEntry[] = [];
  const redirects: RedirectEntry[] = [];

  pending.forEach((pendingRoute, index) => {
    const targetRoute = targets[index];
    const exportedPath = sourcePath(pendingRoute.sourceUrl);
    const collides = targetRoute !== undefined && (targetCounts.get(targetRoute) ?? 0) > 1;
    const ambiguous = statusIsAmbiguousUrl(pendingRoute.status, pendingRoute.sourceUrl);
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

    if (status === "generated" && exportedPath !== undefined && targetRoute !== undefined && exportedPath !== targetRoute) {
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
  return status === "generated" && sourceUrl !== undefined && /[?]/.test(sourceUrl);
}

function sameRouteIgnoringTrailingSlash(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function targetRouteFor(record: ContentRecord): string {
  return normalizeRoute(record.route ?? `/${record.slug}/`);
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

function summarize(
  records: readonly ContentRecord[],
  issues: readonly MigrationIssue[],
  media: MediaSummary,
  routes: RouteSummary
): MigrationSummary {
  const nodes = records.flatMap((record) => flattenNodes(record.nodes));
  return {
    records: records.length,
    pages: records.filter((record) => record.type === "page").length,
    posts: records.filter((record) => record.type === "post").length,
    nodes: nodes.length,
    nativeNodes: nodes.filter((node) => node.conversion === "native").length,
    manualNodes: nodes.filter((node) => node.conversion === "manual" || node.conversion === "legacy-html").length,
    blockedNodes: nodes.filter((node) => node.conversion === "blocked").length,
    reviewItems: nodes.filter(
      (node) => node.conversion === "manual" || node.conversion === "legacy-html" || node.conversion === "blocked"
    ).length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    blockers: issues.filter((issue) => issue.severity === "blocker").length,
    media,
    routes
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
