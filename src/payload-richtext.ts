/**
 * HTML -> Payload (Lexical) rich text.
 *
 * A page that looks correct after importing raw HTML can still be unpleasant
 * to edit. This module converts the documented subset — headings, paragraphs,
 * lists, quotes, code, horizontal rules and the inline formatting below — into
 * native editor nodes, and turns everything else into a `contentReview` entry
 * rather than a guess. The caller always keeps the original HTML alongside the
 * converted body, so nothing is lost when a construct does not convert.
 */

export type LexicalNode = Record<string, unknown>;

export interface ContentReviewItem {
  readonly kind: string;
  readonly label: string;
  readonly reason: string;
  readonly html?: string;
}

export interface RichTextConversion {
  readonly body: LexicalNode;
  readonly review: readonly ContentReviewItem[];
}

const FORMAT_BITS: Readonly<Record<string, number>> = {
  strong: 1,
  b: 1,
  em: 2,
  i: 2,
  s: 4,
  strike: 4,
  del: 4,
  u: 8,
  code: 16
};

/** Inline tags that carry no text and cannot become a rich-text node. */
const UNSUPPORTED_INLINE = new Set([
  "img",
  "picture",
  "source",
  "iframe",
  "embed",
  "object",
  "video",
  "audio",
  "svg",
  "canvas",
  "input",
  "select",
  "textarea",
  "button",
  "form",
  "script",
  "style"
]);

/** Containers whose contents convert transparently. */
const TRANSPARENT_CONTAINERS = new Set([
  "div",
  "section",
  "article",
  "main",
  "aside",
  "header",
  "footer",
  "nav",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd"
]);

/** Containers that never convert: they become one review item each. */
const REVIEW_CONTAINERS = new Set([
  "table",
  "form",
  "iframe",
  "video",
  "audio",
  "svg",
  "picture",
  "script",
  "style",
  "noscript"
]);

const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "embed", "meta", "link"]);

export function htmlToPayloadRichText(
  html: string,
  hrefRewrites: ReadonlyMap<string, string> = new Map()
): RichTextConversion {
  const review: ContentReviewItem[] = [];
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n");
  const children: LexicalNode[] = [];

  for (const token of tokenizeBlocks(cleaned)) {
    appendBlock(token, children, review, hrefRewrites);
  }

  return {
    body: {
      root: { type: "root", children, direction: "ltr", format: "", indent: 0, version: 1 }
    },
    review
  };
}

/** The plain-text length a converted body carries, for a quick sanity count. */
export function lexicalTextLength(node: LexicalNode): number {
  let total = typeof node.text === "string" ? node.text.length : 0;
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child !== null && typeof child === "object") total += lexicalTextLength(child as LexicalNode);
    }
  }
  return total;
}

function appendBlock(
  token: BlockToken,
  children: LexicalNode[],
  review: ContentReviewItem[],
  rewrites: ReadonlyMap<string, string>
): void {
  switch (token.kind) {
    case "element": {
      const tag = token.tag;
      if (/^h[1-6]$/.test(tag)) {
        children.push(element("heading", { tag }, convertInline(token.inner, review, rewrites)));
        return;
      }
      if (tag === "p") {
        const inline = convertInline(token.inner, review, rewrites);
        if (inline.length > 0) children.push(element("paragraph", {}, inline));
        return;
      }
      if (tag === "ul" || tag === "ol") {
        children.push(convertList(token, review, rewrites));
        return;
      }
      if (tag === "blockquote") {
        children.push(element("quote", {}, convertInline(token.inner, review, rewrites)));
        return;
      }
      if (tag === "pre") {
        children.push(element("code", { language: "text" }, [textNode(stripTags(token.inner))]));
        return;
      }
      if (REVIEW_CONTAINERS.has(tag)) {
        review.push(reviewItem(tag, `The ${tag} element was not converted.`, token.raw));
        return;
      }
      if (TRANSPARENT_CONTAINERS.has(tag)) {
        if (hasLayoutHint(token.attrs)) {
          review.push(reviewItem(`${tag}-layout`, `A ${tag} container with layout styling needs rebuilding.`, token.raw));
        }
        for (const child of tokenizeBlocks(token.inner)) appendBlock(child, children, review, rewrites);
        return;
      }
      // Any other element at the top level: keep its text rather than drop it.
      const inline = convertInline(token.raw, review, rewrites);
      if (inline.length > 0) children.push(element("paragraph", {}, inline));
      return;
    }
    case "void": {
      if (token.tag === "br") return;
      if (token.tag === "hr") {
        children.push({ type: "horizontalrule", version: 1 });
        return;
      }
      if (token.tag === "img" || UNSUPPORTED_INLINE.has(token.tag)) {
        review.push(reviewItem(token.tag, `<${token.tag}> was not converted.`, token.raw));
        return;
      }
      const inline = convertInline(token.raw, review, rewrites);
      if (inline.length > 0) children.push(element("paragraph", {}, inline));
      return;
    }
    case "shortcode":
      review.push(reviewItem("shortcode", "A shortcode was not converted.", token.raw));
      return;
    case "text": {
      if (token.text.trim() === "") return;
      const inline = convertInline(token.text, review, rewrites);
      if (inline.length > 0) children.push(element("paragraph", {}, inline));
      return;
    }
  }
}

function convertList(
  token: { readonly tag: string; readonly inner: string },
  review: ContentReviewItem[],
  rewrites: ReadonlyMap<string, string>
): LexicalNode {
  const items = [...token.inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  const children = items.map((match, index) =>
    element("listitem", { value: index + 1, checked: false }, convertInline(match[1] ?? "", review, rewrites))
  );
  return element("list", { listType: token.tag === "ol" ? "number" : "bullet", tag: token.tag, start: 1 }, children);
}

function convertInline(
  html: string,
  review: ContentReviewItem[],
  rewrites: ReadonlyMap<string, string>
): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const stack: { tag: string; format: number; link?: string }[] = [];
  let format = 0;
  let link: string | undefined;
  let cursor = 0;
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;

  const emit = (value: string): void => {
    const text = decodeEntities(value);
    if (text === "") return;
    const node = textNode(text, format);
    nodes.push(link === undefined ? node : linkNode(link, [node]));
    if (/\[[a-z][a-z0-9_-]*[^\]]*\]/i.test(text)) {
      review.push(reviewItem("shortcode", "A shortcode was not converted.", text));
    }
  };

  while ((match = tagPattern.exec(html)) !== null) {
    if (match.index > cursor) emit(html.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;
    const closing = match[0].startsWith("</");
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";

    if (tag === "br") {
      nodes.push({ type: "linebreak", version: 1 });
      continue;
    }

    if (closing) {
      const index = lastIndexWhere(stack, (frame) => frame.tag === tag);
      if (index >= 0) {
        const frame = stack[index]!;
        stack.length = index;
        format = frame.format;
        link = frame.link;
      }
      continue;
    }

    if (UNSUPPORTED_INLINE.has(tag) || tag === "img") {
      review.push(reviewItem(tag, `<${tag}> was not converted.`, match[0]));
      continue;
    }

    if (tag === "a") {
      const href = readAttribute(attrs, "href");
      stack.push({ tag, format, ...(link === undefined ? {} : { link }) });
      if (href !== undefined && /^(?:https?:|mailto:|tel:|\/|#)/i.test(href)) {
        link = rewrites.get(href) ?? href;
      }
      continue;
    }

    const bit = FORMAT_BITS[tag];
    if (bit !== undefined) {
      stack.push({ tag, format, ...(link === undefined ? {} : { link }) });
      format |= bit;
      continue;
    }
    // An unhandled inline tag such as <span class="...">: keep its text.
  }

  if (cursor < html.length) emit(html.slice(cursor));
  return nodes;
}

function element(type: string, extra: Readonly<Record<string, unknown>>, children: readonly LexicalNode[]): LexicalNode {
  return { type, children: [...children], direction: "ltr", format: "", indent: 0, version: 1, ...extra };
}

function textNode(value: string, format = 0): LexicalNode {
  return { type: "text", text: value, format, detail: 0, mode: "normal", style: "", version: 1 };
}

function linkNode(url: string, children: readonly LexicalNode[]): LexicalNode {
  return { type: "link", url, children: [...children], direction: "ltr", format: "", indent: 0, version: 3 };
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function readAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = pattern.exec(attrs);
  if (match === null) return undefined;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined ? undefined : decodeEntities(value);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => codePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => codePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""));
}

function hasLayoutHint(attrs: string): boolean {
  return (
    /class\s*=\s*["'][^"']*(?:wp-block-columns|wp-block-group|elementor|grid|flex|background|hero|layout)[^"']*["']/i.test(attrs) ||
    /style\s*=\s*["'][^"']*(?:display|grid|flex|background)[^"']*["']/i.test(attrs)
  );
}

function reviewItem(kind: string, reason: string, html?: string): ContentReviewItem {
  return { kind, label: kind, reason, ...(html === undefined ? {} : { html }) };
}

interface ElementToken {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: string;
  readonly inner: string;
  readonly raw: string;
}

interface VoidToken {
  readonly kind: "void";
  readonly tag: string;
  readonly attrs: string;
  readonly raw: string;
}

type BlockToken =
  | ElementToken
  | VoidToken
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "shortcode"; readonly raw: string };

function tokenizeBlocks(html: string): BlockToken[] {
  const tokens: BlockToken[] = [];
  let index = 0;

  while (index < html.length) {
    if (html[index] === "<") {
      const element = matchElementAt(html, index);
      if (element !== undefined) {
        tokens.push(element.token);
        index = element.end;
        continue;
      }

      const close = html.indexOf(">", index);
      if (close === -1) {
        tokens.push({ kind: "text", text: html.slice(index) });
        break;
      }
      const raw = html.slice(index, close + 1);
      const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)?.[1]?.toLowerCase() ?? "";
      tokens.push({ kind: "void", tag: name, attrs: "", raw });
      index = close + 1;
      continue;
    }

    const next = html.indexOf("<", index);
    const end = next === -1 ? html.length : next;
    pushTextToken(tokens, html.slice(index, end));
    index = end;
  }

  return tokens;
}

function pushTextToken(tokens: BlockToken[], text: string): void {
  const parts = text.split(/(\[[a-z][a-z0-9_-]*[^\]]*\])/i);
  for (const part of parts) {
    if (part === "") continue;
    if (/^\[[a-z][a-z0-9_-]*[^\]]*\]$/i.test(part)) {
      tokens.push({ kind: "shortcode", raw: part });
    } else {
      tokens.push({ kind: "text", text: part });
    }
  }
}

function matchElementAt(html: string, start: number): { readonly token: ElementToken | VoidToken; readonly end: number } | undefined {
  const open = /^<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/.exec(html.slice(start));
  if (open === null) return undefined;

  const tag = (open[1] ?? "").toLowerCase();
  const attrs = open[2] ?? "";
  const selfClosing = open[3] === "/";
  const openEnd = start + open[0].length;

  if (selfClosing || VOID_TAGS.has(tag)) {
    return { token: { kind: "void", tag, attrs, raw: open[0] }, end: openEnd };
  }

  const closeIndex = findMatchingClose(html, openEnd, tag);
  if (closeIndex === undefined) return undefined;

  const end = closeIndex + `</${tag}>`.length;
  return {
    token: { kind: "element", tag, attrs, inner: html.slice(openEnd, closeIndex), raw: html.slice(start, end) },
    end
  };
}

/** Index of the `</tag>` that closes the element opened before `from`. */
function findMatchingClose(html: string, from: number, tag: string): number | undefined {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }
  return undefined;
}
