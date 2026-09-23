import type { LiveUrlCoverage, LiveUrlSource } from "./types.js";

/**
 * Read live URLs out of a file the caller already has: an XML sitemap, a
 * sitemap index, or a plain list with one URL or path per line.
 *
 * Nothing here touches the network. A sitemap index names child sitemaps that
 * this tool does not fetch, so those entries are returned separately instead
 * of being mistaken for pages.
 */
export function parseLiveUrlSource(
  contents: string | Uint8Array,
  options: { readonly sourcePath?: string } = {}
): LiveUrlSource {
  const label = options.sourcePath === undefined ? "The live URL source" : `The live URL source ${options.sourcePath}`;
  const text = decodeContents(contents, label);
  const body = text.replace(/^\uFEFF/, "");

  if (/^\s*</.test(body)) {
    return readSitemap(body, label);
  }

  return {
    urls: dedupe(readListLines(body)),
    sitemapRefs: []
  };
}

/** Merge several sources into the one set of URLs the plan is checked against. */
export function mergeLiveUrlSources(sources: readonly LiveUrlSource[]): LiveUrlSource {
  return {
    urls: dedupe(sources.flatMap((source) => source.urls)),
    sitemapRefs: dedupe(sources.flatMap((source) => source.sitemapRefs))
  };
}

/**
 * The shape coverage entries take in a plan, a report or an inventory.
 * Credentials, query strings and fragments never reach those files, so this is
 * the only projection the CLI and the generator use.
 */
export function coverageEntryRecords(coverage: LiveUrlCoverage): Record<string, unknown>[] {
  return coverage.entries.map((entry) => ({
    id: entry.id,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.host === undefined ? {} : { host: entry.host }),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    hasQuery: entry.hasQuery,
    status: entry.status,
    ...(entry.shape === undefined ? {} : { shape: entry.shape }),
    ...(entry.targetRoute === undefined ? {} : { targetRoute: entry.targetRoute }),
    ...(entry.sourceStatus === undefined ? {} : { sourceStatus: entry.sourceStatus }),
    reason: entry.reason
  }));
}

function decodeContents(contents: string | Uint8Array, label: string): string {
  if (typeof contents === "string") {
    return contents;
  }

  if (contents.length >= 2 && contents[0] === 0x1f && contents[1] === 0x8b) {
    throw new Error(
      `${label} is compressed. Decompress it first, for example with \`gzip -d sitemap.xml.gz\`, and pass the extracted file.`
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} is not valid UTF-8. Save it as UTF-8 and try again.`);
  }
}

/**
 * Read direct sitemap loc children, including namespace-prefixed documents.
 * Comments and extension elements never become URLs, and CDATA stays literal.
 */
function readSitemap(xml: string, label: string): LiveUrlSource {
  const stack: string[] = [];
  const urls: string[] = [];
  const sitemapRefs: string[] = [];
  let root: string | undefined;
  let prefix = "";
  let value = "";
  let offset = 0;
  const invalid = (): never => {
    throw new Error(`${label} is not a sitemap this tool recognizes. Expected a complete <urlset> or <sitemapindex> document, or a plain list with one URL per line.`);
  };
  const inLoc = (): boolean => stack.length === 3 && stack[2] === `${prefix}loc` &&
    stack[1] === `${prefix}${root === `${prefix}urlset` ? "url" : "sitemap"}`;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+/g;

  for (const match of xml.matchAll(tokens)) {
    if (match.index !== offset) invalid();
    const token = match[0];
    offset += token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      if (inLoc()) value += token.slice(9, -3);
      else if (stack.length === 0) invalid();
      continue;
    }
    if (!token.startsWith("<")) {
      if (inLoc()) value += decodeXmlEntities(token);
      else if (stack.length === 0 && token.trim() !== "") invalid();
      continue;
    }

    const name = /^<\/?([\w:.-]+)/.exec(token)?.[1] ?? "";
    if (token.startsWith("</")) {
      if (stack.at(-1) !== name) invalid();
      if (inLoc() && value.trim() !== "") {
        (root === `${prefix}urlset` ? urls : sitemapRefs).push(value.trim());
      }
      stack.pop();
    } else {
      if (stack.length === 0) {
        if (root !== undefined) invalid();
        root = name;
        prefix = name.includes(":") ? name.slice(0, name.lastIndexOf(":") + 1) : "";
        if (name === `${prefix}rss` || name === `${prefix}feed`) {
          throw new Error(`${label} is a WordPress export or a feed, not a list of live URLs.`);
        }
        if (name !== `${prefix}urlset` && name !== `${prefix}sitemapindex`) invalid();
      }
      if (inLoc()) invalid();
      stack.push(name);
      if (inLoc()) value = "";
      if (token.endsWith("/>")) stack.pop();
    }
  }
  if (offset !== xml.length || stack.length !== 0 || root === undefined) invalid();
  return { urls: dedupe(urls), sitemapRefs: dedupe(sitemapRefs) };
}

/** One URL or path per line; blank lines and `#` comments are ignored. */
function readListLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|lt|gt|amp);/gi, (entity, name: string) => {
    if (/^#x/i.test(name)) return decodeCodePoint(entity, name.slice(2), 16);
    if (name.startsWith("#")) return decodeCodePoint(entity, name.slice(1), 10);
    return named[name] ?? entity;
  });
}

/** Keep malformed entities as they were written instead of failing the read. */
function decodeCodePoint(entity: string, digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return entity;
  }

  return String.fromCodePoint(codePoint);
}
