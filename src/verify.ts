import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  extractContentEvidence,
  normalizeUrl,
  parseHtml,
  readRouteLintReport,
  simhashDistance
} from "routelint";
import type { PageContentEvidence } from "routelint";
import { normalizeRoute, sanitizeSourceUrl } from "./core.js";
import type {
  ContentRecord,
  MigrationNode,
  MigrationProject,
  SiteVerification,
  VerificationStatus,
  VerificationSummary,
  VerifiedRoute
} from "./types.js";

/**
 * Verification compares a page someone actually built or crawled with the
 * record the export carries, so a migration can be checked without this tool
 * making a network request of its own.
 *
 * RouteLint measures both sides without retaining source text. Verification
 * outputs contain word counts and SimHash distances, never page text.
 *
 * The thresholds are deliberately conservative in one direction: a page has to
 * lose almost everything before this check calls it a blocker, because a
 * WordPress export quotes block attributes and widget settings that never
 * render on the page.
 */

/** Below this share of the record's word count, missing text is a blocker. */
const MISSING_TEXT_RATIO = 0.1;
/** Below this share of the record's words the page is reported as smaller. */
const DIVERGED_TEXT_RATIO = 0.6;
/** Hamming distance above which two documents count as unrelated. */
const DIVERGED_SIMHASH_DISTANCE = 12;
/** Records carrying less text than this are left unjudged. */
const MINIMUM_SOURCE_WORDS = 12;
/** Origin used to resolve routes when the export carries no site URL. */
const FALLBACK_ORIGIN = "https://wp-migrate-core.invalid/";

export interface VerifyOptions {
  /**
   * A built site directory, such as the `dist` folder `astro build` writes.
   * HTML files are read from disk.
   */
  readonly htmlDirectory?: string;
  /**
   * A saved RouteLint JSON report, as written by
   * `routelint check --format json`. The report carries the content evidence
   * this comparison needs, so a site that is already crawled does not have to
   * be crawled again.
   */
  readonly routelintReportPath?: string;
  /** Origin used to resolve routes. Defaults to the report's base URL, or the export's site URL for HTML. */
  readonly siteUrl?: string;
}

interface ObservedPage {
  /** Sanitized absolute URL the plan resolves against. */
  readonly href: string;
  readonly evidence?: PageContentEvidence;
  readonly titles: number;
  readonly headings: number;
  readonly unavailableReason?: string;
}

interface PlannedRoute {
  readonly record: ContentRecord;
  readonly route: string;
}

/**
 * Compare every route the plan generates with the page that was built or
 * crawled for it. Exactly one observed source has to be supplied.
 */
export async function verifySite(
  project: MigrationProject,
  options: VerifyOptions = {}
): Promise<SiteVerification> {
  const hasHtmlDirectory = options.htmlDirectory !== undefined;
  const hasReport = options.routelintReportPath !== undefined;

  if (hasHtmlDirectory === hasReport) {
    throw new Error(
      "Verification reads one observed source at a time: pass --html-dir for a built site, or --routelint-report for a saved report."
    );
  }

  let base = resolveBaseUrl(options.siteUrl ?? project.site.url);
  const planned = plannedRoutes(project);

  let observed: readonly ObservedPage[];
  let source: string;
  let kind: SiteVerification["observed"];

  if (options.htmlDirectory !== undefined) {
    const directory = resolve(options.htmlDirectory);
    observed = await readHtmlDirectory(directory, base);
    source = directory;
    kind = "html-directory";
  } else {
    const reportPath = resolve(options.routelintReportPath ?? "");
    const report = await readRouteLintPages(reportPath, options.siteUrl);
    observed = report.pages;
    base = report.base;
    source = reportPath;
    kind = "routelint-report";
  }

  // Do not silently choose between conflicting local build outputs.
  const byHref = new Map<string, ObservedPage>();
  for (const page of observed) {
    if (byHref.has(page.href) && kind === "html-directory") {
      throw new Error(`Multiple built HTML files map to the same route: ${new URL(page.href).pathname}`);
    }
    if (!byHref.has(page.href)) byHref.set(page.href, page);
  }

  const routes: VerifiedRoute[] = [];
  for (const entry of planned) {
    const href = normalizeUrl(entry.route, base);
    const page = href === undefined ? undefined : byHref.get(href);
    routes.push(classifyRoute(entry, page, routes.length + 1));
  }

  return {
    observed: kind,
    source,
    routes,
    summary: summarizeVerification(routes, [...byHref.values()])
  };
}

/**
 * The text a record is expected to carry. Records with rendered content are
 * read by the HTML parser; records whose content lives in widget settings
 * instead fall back to the text the node tree collected.
 */
export function sourceContentEvidence(record: ContentRecord): PageContentEvidence {
  if (record.rawContent.trim() !== "") {
    const evidence = extractContentEvidence(record.rawContent);
    if (evidence.words > 0) return evidence;
  }

  return extractContentEvidence(record.nodes.map(sourceNodeHtml).join(" "));
}

function sourceNodeHtml(node: MigrationNode): string {
  if (node.rawHtml?.trim()) return node.rawHtml;
  // node.text is derived from these settings. Using both doubles the record's
  // text, and treating HTML settings as plain text counts tags as words.
  const key = node.sourceType === "heading" ? "title"
    : node.sourceType === "text-editor" ? "editor"
    : node.sourceType === "html" ? "html" : "text";
  const setting = node.attributes[key];
  const own = typeof setting === "string" ? setting
    : (node.text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [own, ...node.children.map(sourceNodeHtml)].join(" ");
}

function classifyRoute(
  entry: PlannedRoute,
  page: ObservedPage | undefined,
  ordinal: number
): VerifiedRoute {
  const sourceEvidence = sourceContentEvidence(entry.record);
  const identified = {
    id: `verification:${ordinal}`,
    sourceId: entry.record.sourceId,
    route: entry.route,
    sourceWords: sourceEvidence.words
  };

  if (page === undefined || page.unavailableReason !== undefined) {
    return {
      ...identified,
      status: "route-missing",
      reason: page?.unavailableReason ?? "The observed source carries no page for this route.",
      requiredAction:
        "Build the site and point the check at its output, or confirm this route is intentionally unpublished."
    };
  }

  if (sourceEvidence.words < MINIMUM_SOURCE_WORDS) {
    return {
      ...identified,
      status: "skipped",
      reason: `The record carries ${sourceEvidence.words} word(s), which is too little text to compare with a page.`
    };
  }

  const observedEvidence = page.evidence;
  if (observedEvidence === undefined) {
    return {
      ...identified,
      status: "skipped",
      reason: "The observed source carries no content evidence for this route."
    };
  }

  const distance = simhashDistance(sourceEvidence.simhash, observedEvidence.simhash);
  const measured = {
    observedWords: observedEvidence.words,
    ...(distance === undefined ? {} : { simhashDistance: distance })
  };
  const ratio = observedEvidence.words / sourceEvidence.words;

  if (observedEvidence.words === 0 || ratio < MISSING_TEXT_RATIO) {
    return {
      ...identified,
      ...measured,
      status: "missing-content",
      reason: `The page carries ${observedEvidence.words} word(s) where the export carries ${sourceEvidence.words}.`,
      requiredAction: "Compare the page with the export and restore the content the layout left out."
    };
  }

  if (ratio < DIVERGED_TEXT_RATIO || (distance !== undefined && distance > DIVERGED_SIMHASH_DISTANCE)) {
    return {
      ...identified,
      ...measured,
      status: "diverged",
      reason:
        `The page carries ${observedEvidence.words} words versus ${sourceEvidence.words} in the export, ` +
        `and the two fingerprints differ by ${distance ?? "an unknown number of"} bits.`,
      requiredAction: "Read the page and confirm the different text is intended, or restore what is missing."
    };
  }

  return {
    ...identified,
    ...measured,
    status: "verified",
    reason:
      `The page carries ${observedEvidence.words} words versus ${sourceEvidence.words} in the export` +
      `${distance === undefined ? "" : `, ${distance} bit(s) from the export's fingerprint`}.`
  };
}

function summarizeVerification(
  routes: readonly VerifiedRoute[],
  observed: readonly ObservedPage[]
): VerificationSummary {
  const count = (status: VerificationStatus): number =>
    routes.filter((route) => route.status === status).length;

  return {
    routes: routes.length,
    verified: count("verified"),
    diverged: count("diverged"),
    missingContent: count("missing-content"),
    routeMissing: count("route-missing"),
    skipped: count("skipped"),
    withoutTitle: observed.filter((page) => page.unavailableReason === undefined && page.titles === 0).length,
    withoutHeading: observed.filter((page) => page.unavailableReason === undefined && page.headings === 0).length
  };
}

function plannedRoutes(project: MigrationProject): readonly PlannedRoute[] {
  const planned: PlannedRoute[] = [];
  const seen = new Set<string>();

  for (const record of project.records) {
    // The generator and the plan share this mapping, so the verification
    // artefact names the same route the manifest does.
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    if (seen.has(route)) {
      throw new Error(`Cannot verify duplicate route: ${route}`);
    }

    seen.add(route);
    planned.push({ record, route });
  }

  if (planned.length === 0) {
    throw new Error("The export has no planned routes to verify. Check the export and --include-drafts setting.");
  }
  return planned;
}

function resolveBaseUrl(candidate: string | undefined): string {
  const sanitized = sanitizeSourceUrl(candidate);
  return sanitized === undefined ? FALLBACK_ORIGIN
    : normalizeUrl(sanitized, FALLBACK_ORIGIN) ?? FALLBACK_ORIGIN;
}

async function readHtmlDirectory(directory: string, base: string): Promise<readonly ObservedPage[]> {
  const files = await collectHtmlFiles(directory);
  const pages: ObservedPage[] = [];

  for (const file of files) {
    const href = normalizeUrl(routeForHtmlFile(directory, file), base);
    if (href === undefined) continue;

    let html: string;
    try {
      html = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`Cannot read the built page ${file}: ${messageOf(error)}`);
    }

    const signals = parseHtml(html, href);
    pages.push({
      href,
      evidence: extractContentEvidence(html),
      titles: signals.titles.length,
      headings: signals.h1s.length
    });
  }

  return pages;
}

async function collectHtmlFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read the built site directory ${directory}: ${messageOf(error)}`);
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectHtmlFiles(path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
      files.push(path);
    }
  }

  return files;
}

/**
 * Astro writes `/guides/tap/` to `guides/tap/index.html` and `/guides/tap` to
 * `guides/tap.html`, depending on `build.format`. Both represent the same
 * planned content route here; local files cannot prove a host's slash policy.
 */
function routeForHtmlFile(directory: string, file: string): string {
  const relativePath = relative(directory, file).split(sep).join("/")
    .replace(/[?#]/g, encodeURIComponent);
  const withoutExtension = relativePath.replace(/\.html$/i, "");

  if (withoutExtension === "index") {
    return "/";
  }

  if (withoutExtension.endsWith("/index")) {
    return `/${withoutExtension.slice(0, -"index".length)}`;
  }

  return `/${withoutExtension}/`;
}

async function readRouteLintPages(
  path: string,
  siteUrl: string | undefined
): Promise<{ readonly base: string; readonly pages: readonly ObservedPage[] }> {
  const report = await readRouteLintReport(path);
  const base = resolveBaseUrl(siteUrl ?? report.baseUrl);
  const pages: ObservedPage[] = [];

  for (const route of report.routes) {
    const href = normalizeUrl(route.url, base);
    if (href === undefined || new URL(href).origin !== new URL(base).origin) continue;

    // Prefer the browser response, including its failures, rather than
    // cherry-picking a bot snapshot merely because it contains evidence.
    const snapshot =
      route.snapshots.find((candidate) => candidate.agent.key === "browser") ?? route.snapshots[0];
    const unavailableReason = snapshot === undefined
      ? "The report carries no fetched response for this route."
      : snapshot.completion !== "complete"
        ? `The crawl did not complete for this route (${snapshot.completion}).`
        : snapshot.status === undefined || snapshot.status < 200 || snapshot.status >= 300
          ? `The crawl did not receive a successful page for this route (HTTP ${snapshot.status ?? "unknown"}).`
          : normalizeUrl(snapshot.finalUrl, base) !== href
            ? "The crawl ended at a different URL, so its content cannot verify this route."
            : undefined;
    const content = snapshot?.content;

    pages.push({
      href,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(content === undefined ? {} : { evidence: content }),
      titles: snapshot?.signals.titles.length ?? 0,
      headings: snapshot?.signals.h1s.length ?? 0
    });
  }

  return { base, pages };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
