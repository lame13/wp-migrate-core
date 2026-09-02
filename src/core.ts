import type {
  ContentRecord,
  ConversionDisposition,
  InspectOptions,
  MigrationIssue,
  MigrationIssueCode,
  MigrationNode,
  MigrationNodeKind,
  MigrationProject,
  MigrationSummary,
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
 * is dependency-free so 0.1.0-demo can make the conversion boundary visible.
 */
export function parseWxr(xml: string, options: InspectOptions = {}): MigrationProject {
  const records: ContentRecord[] = [];
  const projectIssues: MigrationIssue[] = [];
  const channelHeader = xml.slice(0, xml.search(/<item\b/i) === -1 ? xml.length : xml.search(/<item\b/i));
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(xml)) !== null) {
    const itemXml = itemMatch[1] ?? "";
    const postType = cleanField(readTag(itemXml, "wp:post_type"));
    if (postType !== "page" && postType !== "post") {
      continue;
    }

    const status = normalizeStatus(cleanField(readTag(itemXml, "wp:status")));
    if (!options.includeDrafts && status !== "publish") {
      continue;
    }

    const rawId = cleanField(readTag(itemXml, "wp:post_id"));
    const wordpressId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(wordpressId)) {
      projectIssues.push({
        id: `project:WXR_ITEM_MISSING_ID:${projectIssues.length + 1}`,
        severity: "warning",
        code: "WXR_ITEM_MISSING_ID",
        sourceId: "wp:unknown",
        title: "WordPress item is missing its ID",
        message: `Skipped a ${postType} without a numeric wp:post_id.`,
        requiredAction: "Inspect the WXR export and restore the missing post identifier."
      });
      continue;
    }

    records.push(parseItem(itemXml, postType, status, wordpressId));
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

  const recordIssues = records.flatMap((record) => record.issues);
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
    records,
    issues,
    summary: summarize(records, issues)
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
    `Elementor widget ${widgetType} has no 0.1.0-demo adapter.`,
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
      `Gutenberg block ${node.sourceType} has no 0.1.0-demo adapter.`,
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

function summarize(records: readonly ContentRecord[], issues: readonly MigrationIssue[]): MigrationSummary {
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
    blockers: issues.filter((issue) => issue.severity === "blocker").length
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

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16))
    )
    .replace(/&amp;/g, "&");
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
