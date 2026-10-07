import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  extractContentEvidence,
  normalizeUrl,
  parseHtml,
  readRouteLintReport,
  simhashDistance
} from "routelint";
import type { PageContentEvidence } from "routelint";
import { normalizeRoute, readHtmlAttribute, sanitizeSourceUrl } from "./core.js";
import {
  indexingFromSignals,
  launchFindings,
  readDeliveryEvidence
} from "./delivery.js";
import { importLaunchFindings, readImportEvidence } from "./import-report.js";
import type { ContentIndexing } from "./delivery.js";
import type {
  ContentRecord,
  IndexingEvidence,
  LaunchFinding,
  MigrationNode,
  MigrationProject,
  SiteVerification,
  VerificationCheck,
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
  /**
   * A saved SSRWire JSON audit of the site that was built or deployed, as
   * written by `ssrwire check --format json`. It carries the response status,
   * the metadata a crawler receives, and whether the page may be indexed: none
   * of which a file on disk can show.
   */
  readonly ssrwireReportPath?: string;
  /**
   * A saved SSRWire audit of the same routes taken before the migration. The
   * two reports are compared on their target ids, which is why the check files
   * this tool generates share them.
   */
  readonly ssrwireBaselinePath?: string;
  /** Origin used to resolve routes. Defaults to the report's base URL, or the export's site URL for HTML. */
  readonly siteUrl?: string;
  /**
   * A `migration-import.json` report a generated CMS importer wrote. It is the
   * third kind of evidence: whether the records arrived in the CMS. It can be
   * supplied on its own, or alongside a build or crawl check.
   */
  readonly importReportPath?: string;
}

interface ObservedPage {
  /** Sanitized absolute URL the plan resolves against. */
  readonly href: string;
  /** Site-relative route, for a page read from a built directory. */
  readonly route?: string;
  /** The built markup, for the checks that read the output itself. */
  readonly html?: string;
  readonly evidence?: PageContentEvidence;
  readonly titles: number;
  readonly headings: number;
  /** What this page says about indexing, for the publishing gate. */
  readonly indexing: IndexingEvidence;
  readonly unavailableReason?: string;
}

interface PlannedRoute {
  readonly record?: ContentRecord;
  readonly sourceId: string;
  readonly route: string;
}

/**
 * Compare every route the plan generates with the page that was built or
 * crawled for it. Exactly one content source has to be supplied, and saved
 * delivery evidence can be added to it.
 */
export async function verifySite(
  project: MigrationProject,
  options: VerifyOptions = {}
): Promise<SiteVerification> {
  const hasHtmlDirectory = options.htmlDirectory !== undefined;
  const hasReport = options.routelintReportPath !== undefined;
  const hasImport = options.importReportPath !== undefined;
  const hasContentSource = hasHtmlDirectory || hasReport;

  if (hasHtmlDirectory && hasReport) {
    throw new Error(
      "Verification reads one content source at a time: pass --html-dir for a built site, or --routelint-report for a saved report."
    );
  }

  if (!hasContentSource && !hasImport) {
    throw new Error(
      "Verification needs something to check: pass --html-dir for a built site, --routelint-report for a saved report, or --import-report for a CMS import."
    );
  }

  if (options.ssrwireBaselinePath !== undefined && options.ssrwireReportPath === undefined) {
    throw new Error(
      "Verification compares a baseline with the site it checks, so --ssrwire-baseline also needs --ssrwire-report."
    );
  }

  let base = resolveBaseUrl(options.siteUrl ?? project.site.url);
  const planned = hasContentSource ? plannedRoutes(project) : [];
  const imports = options.importReportPath === undefined ? undefined : await readImportEvidence(options.importReportPath);

  let observed: readonly ObservedPage[];
  let source: string;
  let kind: SiteVerification["observed"];

  if (options.htmlDirectory !== undefined) {
    const directory = resolve(options.htmlDirectory);
    observed = await readHtmlDirectory(directory, base);
    source = directory;
    kind = "html-directory";
  } else if (options.routelintReportPath !== undefined) {
    const reportPath = resolve(options.routelintReportPath ?? "");
    const report = await readRouteLintPages(reportPath, options.siteUrl);
    observed = report.pages;
    base = report.base;
    source = reportPath;
    kind = "routelint-report";
  } else {
    observed = [];
    source = imports?.source ?? "";
    kind = "import-report";
  }

  // Do not silently choose between conflicting local build outputs.
  const byHref = new Map<string, ObservedPage>();
  for (const page of observed) {
    if (byHref.has(page.href) && kind === "html-directory") {
      throw new Error(`Multiple built HTML files map to the same route: ${new URL(page.href).pathname}`);
    }
    if (!byHref.has(page.href)) byHref.set(page.href, page);
  }

  const delivery =
    options.ssrwireReportPath === undefined
      ? undefined
      : await readDeliveryEvidence(project, {
          reportPath: options.ssrwireReportPath,
          ...(options.ssrwireBaselinePath === undefined
            ? {}
            : { baselinePath: options.ssrwireBaselinePath })
        });

  const routes: VerifiedRoute[] = [];
  const indexing: ContentIndexing[] = [];

  for (const entry of planned) {
    const href = normalizeUrl(entry.route, base);
    const page = href === undefined ? undefined : byHref.get(href);
    routes.push(classifyRoute(entry, page, routes.length + 1));
    if (page !== undefined && kind !== "import-report") {
      indexing.push({ route: entry.route, source: kind, evidence: page.indexing });
    }
  }

  const gate =
    kind === "html-directory" && options.htmlDirectory !== undefined
      ? await readBuildGate(project, resolve(options.htmlDirectory), observed)
      : undefined;

  const launch = sortLaunchFindings([
    ...launchFindings({ indexing, ...(delivery === undefined ? {} : { delivery }) }),
    ...(gate?.findings ?? []),
    ...(imports === undefined ? [] : importLaunchFindings(project, imports))
  ]);

  // A check that could not run is reported as unchecked, never as passed.
  const checks: VerificationCheck[] = [
    ...contentChecks(gate, hasContentSource, delivery !== undefined),
    {
      id: "import",
      label: "Imported records match the plan",
      checked: imports !== undefined,
      ...(imports === undefined ? { reason: "No import report was supplied." } : {})
    }
  ];

  return {
    observed: kind,
    source,
    routes,
    summary: summarizeVerification(
      routes,
      [...byHref.values()],
      launch,
      checks.filter((check) => !check.checked).length
    ),
    ...(delivery === undefined ? {} : { delivery }),
    ...(imports === undefined ? {} : { imports }),
    launch,
    checks
  };
}

/**
 * The content and build checks. A built site on disk can take all of them; a
 * crawl report can only take the content check, and says why for the rest.
 */
function contentChecks(gate: BuildGate | undefined, hasContentSource: boolean, hasDelivery: boolean): readonly VerificationCheck[] {
  if (gate !== undefined) {
    return gate.checks.map((check) =>
      check.id === "delivery"
        ? {
            ...check,
            checked: hasDelivery,
            ...(hasDelivery ? {} : { reason: "No saved SSRWire audit was supplied." })
          }
        : check
    );
  }

  if (hasContentSource) {
    return [
      { id: "content", label: "Built pages carry the content the export records", checked: true },
      ...BUILD_CHECKS.map((check) => ({
        id: check.id,
        label: check.label,
        checked: false,
        reason: "This check reads the built site on disk; a crawl report does not carry it."
      })),
      {
        id: "delivery",
        label: "Delivered responses match the plan",
        checked: hasDelivery,
        ...(hasDelivery ? {} : { reason: "No saved SSRWire audit was supplied." })
      }
    ];
  }

  return [
    {
      id: "content",
      label: "Built pages carry the content the export records",
      checked: false,
      reason: "No build or crawl report was supplied."
    },
    ...BUILD_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      checked: false,
      reason: "This check reads the built site on disk; no build was supplied."
    })),
    {
      id: "delivery",
      label: "Delivered responses match the plan",
      checked: hasDelivery,
      ...(hasDelivery ? {} : { reason: "No saved SSRWire audit was supplied." })
    }
  ];
}

/** Blockers first, so a gate reads as a list of what stops a launch. */
function sortLaunchFindings(findings: readonly LaunchFinding[]): readonly LaunchFinding[] {
  const rank: Readonly<Record<LaunchFinding["severity"], number>> = { blocker: 0, warning: 1 };
  return [...findings].sort((left, right) => rank[left.severity] - rank[right.severity]);
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
  const sourceEvidence = entry.record === undefined ? undefined : sourceContentEvidence(entry.record);
  const identified = {
    id: `verification:${ordinal}`,
    sourceId: entry.sourceId,
    route: entry.route,
    sourceWords: sourceEvidence?.words ?? 0
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

  if (sourceEvidence === undefined) {
    return { ...identified, status: "skipped", reason: "The archive page exists; its generated listing has no source text to compare." };
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
  observed: readonly ObservedPage[],
  launch: readonly LaunchFinding[],
  uncheckedChecks: number
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
    withoutHeading: observed.filter((page) => page.unavailableReason === undefined && page.headings === 0).length,
    launchBlockers: launch.filter((finding) => finding.severity === "blocker").length,
    launchWarnings: launch.filter((finding) => finding.severity === "warning").length,
    uncheckedChecks
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
    planned.push({ record, route, sourceId: record.sourceId });
  }

  for (const archive of project.archives.pages) {
    const route = normalizeRoute(archive.route);
    if (seen.has(route)) throw new Error(`Cannot verify duplicate route: ${route}`);
    seen.add(route);
    planned.push({ route, sourceId: archive.id });
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
      route: routeForHtmlFile(directory, file),
      html,
      evidence: extractContentEvidence(html),
      titles: signals.titles.length,
      headings: signals.h1s.length,
      indexing: indexingFromSignals(signals.robots)
    });
  }

  return pages;
}

/** The checks that need the built site on disk, in the order they are reported. */
const BUILD_CHECKS: readonly {
  readonly id: "media" | "links" | "canonical" | "robots" | "sitemap";
  readonly label: string;
}[] = [
  { id: "media", label: "Copied media is present in the build" },
  { id: "links", label: "Internal links resolve to a route, a rule or a file" },
  { id: "canonical", label: "Built pages carry a canonical URL" },
  { id: "robots", label: "robots.txt allows crawling" },
  { id: "sitemap", label: "sitemap.xml lists every generated route" }
];

interface BuildGate {
  readonly findings: readonly LaunchFinding[];
  readonly checks: readonly VerificationCheck[];
}

interface BuiltPage {
  readonly route: string;
  readonly href: string;
  readonly html: string;
}

/**
 * The checks that read the built site rather than the plan: media delivery,
 * internal links, canonical URLs, robots.txt and the sitemap.
 *
 * Everything here reads local files. Nothing is fetched, and a check that
 * cannot run says so rather than reporting a pass it did not earn.
 */
async function readBuildGate(
  project: MigrationProject,
  directory: string,
  pages: readonly ObservedPage[]
): Promise<BuildGate> {
  const buildPages: BuiltPage[] = pages.flatMap((page) =>
    page.route === undefined || page.html === undefined
      ? []
      : [{ route: page.route, href: page.href, html: page.html }]
  );

  const findings: LaunchFinding[] = [
    ...(await checkBuildMedia(project, directory)),
    ...(await checkBuildLinks(project, directory, buildPages)),
    ...checkCanonicalUrls(buildPages),
    ...(await checkRobots(directory)),
    ...(await checkSitemap(project, directory))
  ];

  return {
    findings,
    checks: [
      { id: "content", label: "Built pages carry the content the export records", checked: true },
      ...BUILD_CHECKS.map((check) => check.id === "media" && project.media.delivery === undefined &&
        (project.media.assets.length > 0 || project.media.references.length > 0)
        ? { ...check, checked: false, reason: "No media delivery plan was supplied; reuse the conversion's uploads options or media config." }
        : { ...check, checked: true }),
      { id: "delivery", label: "Delivered responses match the plan", checked: false }
    ]
  };
}

/** Media the plan copied has to be in the build, and has to carry bytes. */
async function checkBuildMedia(project: MigrationProject, directory: string): Promise<readonly LaunchFinding[]> {
  const copies = project.media.delivery?.copies ?? [];
  if (copies.length === 0) {
    return [];
  }

  const missing: string[] = [];
  const empty: string[] = [];
  for (const copy of copies) {
    const file = resolveInside(directory, copy.outputPath);
    const size = file === undefined ? undefined : await fileSize(file);
    if (size === undefined) {
      missing.push(copy.outputPath);
    } else if (size === 0) {
      empty.push(copy.outputPath);
    }
  }

  const findings: LaunchFinding[] = [];
  if (missing.length > 0) {
    findings.push({
      id: "launch:MEDIA_MISSING_IN_BUILD:1",
      severity: "blocker",
      code: "MEDIA_MISSING_IN_BUILD",
      source: "html-directory",
      routes: missing.slice(0, 5),
      title: "Copied media is missing from the build",
      message: `${missing.length} of ${copies.length} copied ${
        copies.length === 1 ? "file is" : "files are"
      } not in the built site: ${listTargets(missing)}.`,
      requiredAction:
        "Check that the build copies public/ into the output, and that media delivery ran before it."
    });
  }
  if (empty.length > 0) {
    findings.push({
      id: "launch:MEDIA_EMPTY_IN_BUILD:1",
      severity: "warning",
      code: "MEDIA_EMPTY_IN_BUILD",
      source: "html-directory",
      routes: empty.slice(0, 5),
      title: "A copied media file is empty in the build",
      message: `${empty.length} copied ${empty.length === 1 ? "file has" : "files have"} no bytes: ${listTargets(empty)}.`,
      requiredAction: "Compare these files with the source uploads directory before publishing."
    });
  }

  return findings;
}

/**
 * Internal links have to lead somewhere: a generated route, a proposed rule,
 * or a file the build actually contains.
 *
 * Findings group by target rather than by page, because a link in a shared
 * layout is one problem even when it appears on every page.
 */
async function checkBuildLinks(
  project: MigrationProject,
  directory: string,
  pages: readonly BuiltPage[]
): Promise<readonly LaunchFinding[]> {
  const routes = new Set(
    project.routes.entries.filter((entry) => entry.status === "generated").flatMap((entry) => entry.targetRoute ?? [])
  );
  const variants = new Map([...routes].map((route) => [withoutTrailingSlash(route), route]));
  const rules = new Set(project.routes.redirects.map((redirect) => redirect.sourcePath));

  const broken = new Map<string, Set<string>>();
  const slashOnly = new Map<string, Set<string>>();
  const fileCache = new Map<string, boolean>();

  for (const page of pages) {
    for (const href of htmlAttributeValues(page.html, "a", "href")) {
      const target = resolveInternalLink(href, page.href);
      if (target === undefined || routes.has(target) || rules.has(target)) {
        continue;
      }
      // A generated route serves the other spelling of this path, which is a
      // different problem from a target nothing serves at all.
      const variant = variants.get(withoutTrailingSlash(target));
      if (variant !== undefined && variant !== target) {
        slashOnly.set(target, (slashOnly.get(target) ?? new Set<string>()).add(page.route));
        continue;
      }
      if (await buildFileExists(directory, target, fileCache)) {
        continue;
      }

      broken.set(target, (broken.get(target) ?? new Set<string>()).add(page.route));
    }
  }

  const findings: LaunchFinding[] = [];
  for (const [target, sources] of [...broken].slice(0, 10)) {
    findings.push({
      id: `launch:LINK_TARGET_MISSING_IN_BUILD:${target}`,
      severity: "warning",
      code: "LINK_TARGET_MISSING_IN_BUILD",
      source: "html-directory",
      routes: [...sources].slice(0, 5),
      field: target,
      title: `A built page links to ${target}, and nothing serves it`,
      message: `No generated route, no redirect rule and no built file answers ${target}. It appears on ${listTargets([...sources])}.`,
      requiredAction:
        "Point the link at a generated route, decide the target in the migration config, or remove the link."
    });
  }
  if (broken.size > 10) {
    findings.push({
      id: "launch:LINK_TARGET_MISSING_IN_BUILD:more",
      severity: "warning",
      code: "LINK_TARGET_MISSING_IN_BUILD",
      source: "html-directory",
      title: "More built links lead nowhere",
      message: `${broken.size - 10} further targets in the built pages resolve to no route, rule or file.`,
      requiredAction: "Work through the link inventory and the migration config together."
    });
  }

  for (const [target, sources] of [...slashOnly].slice(0, 10)) {
    findings.push({
      id: `launch:LINK_TARGET_MISSING_IN_BUILD:slash:${target}`,
      severity: "warning",
      code: "LINK_TARGET_MISSING_IN_BUILD",
      source: "html-directory",
      routes: [...sources].slice(0, 5),
      field: target,
      title: `A built page links to ${target} without the trailing slash`,
      message: `The generated route is ${variants.get(withoutTrailingSlash(target)) ?? target}, and this link does not use it. It appears on ${listTargets([...sources])}.`,
      requiredAction:
        "Rewrite the link, or confirm the host resolves both spellings, as Netlify's Pretty URLs does."
    });
  }

  return findings;
}

/** Canonical URLs, which the publish-ready layout writes and the default does not. */
function checkCanonicalUrls(pages: readonly BuiltPage[]): readonly LaunchFinding[] {
  const missing: string[] = [];
  const findings: LaunchFinding[] = [];

  for (const page of pages) {
    const canonical = canonicalHref(page.html);
    if (canonical === undefined) {
      missing.push(page.route);
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(canonical, page.href);
    } catch {
      missing.push(page.route);
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      missing.push(page.route);
      continue;
    }
    const expected = new URL(page.href);
    if (resolved.origin !== expected.origin ||
      withoutTrailingSlash(resolved.pathname) !== withoutTrailingSlash(expected.pathname)) {
      findings.push({
        id: `launch:CANONICAL_MISSING:${page.route}`,
        severity: "warning",
        code: "CANONICAL_MISSING",
        source: "html-directory",
        route: page.route,
        field: "canonical",
        title: `The canonical URL of ${page.route} points somewhere else`,
        message: `This page declares ${sanitizeSourceUrl(resolved.href)} as its canonical URL.`,
        requiredAction:
          "Check the layout and the site URL, so a page does not ask search engines to prefer another address."
      });
    }
  }

  if (missing.length > 0) {
    findings.push({
      id: "launch:CANONICAL_MISSING:1",
      severity: "warning",
      code: "CANONICAL_MISSING",
      source: "html-directory",
      routes: missing.slice(0, 5),
      title: "Built pages carry no canonical URL",
      message: `${missing.length} built ${missing.length === 1 ? "page has" : "pages have"} no canonical link, including ${listTargets(missing)}.`,
      requiredAction:
        "Run convert with --publish-ready, which writes a canonical URL per page when the site URL is known."
    });
  }

  return findings;
}

/** A build that still disallows crawling is not ready, whatever else it does. */
async function checkRobots(directory: string): Promise<readonly LaunchFinding[]> {
  const file = resolveInside(directory, "/robots.txt");
  const contents = file === undefined ? undefined : await readTextFile(file);
  if (contents === undefined || !robotsDisallowsAll(contents)) {
    return [];
  }

  return [
    {
      id: "launch:ROBOTS_BLOCKED:1",
      severity: "blocker",
      code: "ROBOTS_BLOCKED",
      source: "html-directory",
      route: "/robots.txt",
      title: "robots.txt tells every crawler to stay away",
      message: "The built robots.txt disallows crawling for every user agent.",
      requiredAction: "Run convert with --publish-ready, or edit public/robots.txt, before moving DNS."
    }
  ];
}

/** The sitemap has to list the routes the plan generates. */
async function checkSitemap(project: MigrationProject, directory: string): Promise<readonly LaunchFinding[]> {
  const expected = [
    ...new Set(
      project.routes.entries
        .filter((entry) => entry.status === "generated")
        .flatMap((entry) => entry.targetRoute ?? [])
        .filter((route) => route.endsWith("/"))
    )
  ].sort();
  if (expected.length === 0) {
    return [];
  }

  const file = resolveInside(directory, "/sitemap.xml");
  const contents = file === undefined ? undefined : await readTextFile(file);
  if (contents === undefined) {
    return [
      {
        id: "launch:SITEMAP_INCOMPLETE:1",
        severity: "warning",
        code: "SITEMAP_INCOMPLETE",
        source: "html-directory",
        title: "The build has no sitemap",
        message: `${expected.length} generated ${
          expected.length === 1 ? "route is" : "routes are"
        } listed nowhere, because the build carries no sitemap.xml.`,
        requiredAction:
          "Add the site URL to the export or the migration config so conversion writes public/sitemap.xml."
      }
    ];
  }

  const listed = new Set(
    [...contents.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].flatMap((match) => {
      const value = match[1];
      if (value === undefined) {
        return [];
      }
      const text = decodeXmlText(value);
      try {
        return [new URL(text).pathname];
      } catch {
        return [text];
      }
    })
  );
  const missing = expected.filter((route) => !listed.has(route));
  if (missing.length === 0) {
    return [];
  }

  return [
    {
      id: "launch:SITEMAP_INCOMPLETE:2",
      severity: "warning",
      code: "SITEMAP_INCOMPLETE",
      source: "html-directory",
      routes: missing.slice(0, 5),
      title: "The sitemap does not list every generated route",
      message: `${missing.length} of ${expected.length} generated ${
        expected.length === 1 ? "route is" : "routes are"
      } missing from the build's sitemap, including ${listTargets(missing)}.`,
      requiredAction:
        "Regenerate the sitemap with the same plan that built the pages, and check that nothing edits it afterwards."
    }
  ];
}

/** The href of a page's canonical link, when it has one. */
function canonicalHref(html: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = readHtmlAttribute(tag, "rel");
    if (rel === undefined || rel.trim().toLowerCase() !== "canonical") {
      continue;
    }
    const href = readHtmlAttribute(tag, "href");
    if (href !== undefined && href.trim() !== "") {
      return href.trim();
    }
  }

  return undefined;
}

/** Every value of one attribute on one tag, for scanning built markup. */
function htmlAttributeValues(html: string, tag: string, attribute: string): readonly string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  return [...html.matchAll(pattern)].flatMap((match) => {
    const value = readHtmlAttribute(match[0], attribute);
    return value === undefined ? [] : [value];
  });
}

/**
 * The path an internal link points at, or undefined when the link leaves the
 * site or is not a navigation target at all.
 */
function resolveInternalLink(href: string, pageHref: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^(?:mailto|tel|sms|geo|javascript|data):/i.test(trimmed)) {
    return undefined;
  }

  let url: URL;
  let page: URL;
  try {
    url = new URL(trimmed, pageHref);
    page = new URL(pageHref);
  } catch {
    return undefined;
  }

  if (url.host !== page.host || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }

  return url.pathname === "" ? "/" : url.pathname;
}

/** True when the build serves this path as a file, a directory index or a page. */
async function buildFileExists(
  directory: string,
  path: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  let filePath: string;
  try {
    const segments = path.split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => /[/\\]/.test(segment))) return false;
    filePath = segments.join("/");
  } catch {
    return false;
  }
  const candidates = filePath.endsWith("/")
    ? [filePath, `${filePath}index.html`]
    : [filePath, `${filePath}/index.html`, `${filePath}.html`];
  let found = false;
  for (const candidate of candidates) {
    const file = resolveInside(directory, candidate);
    if (file !== undefined && (await fileSize(file)) !== undefined) {
      found = true;
      break;
    }
  }

  cache.set(path, found);
  return found;
}

/** Resolve a site-relative path inside a directory, refusing to escape it. */
function resolveInside(directory: string, path: string): string | undefined {
  if (!path.startsWith("/")) {
    return undefined;
  }
  const resolved = resolve(directory, `.${path}`);
  return resolved === directory || resolved.startsWith(`${directory}${sep}`) ? resolved : undefined;
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const details = await stat(path);
    return details.isFile() ? details.size : undefined;
  } catch {
    return undefined;
  }
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * True when robots.txt disallows crawling for everyone. Only the `*` group
 * counts, because a rule naming one crawler is not a closed site.
 */
function robotsDisallowsAll(contents: string): boolean {
  let appliesToAll = false;
  let hasRules = false;
  let disallows = false;
  let allows = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (line === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (hasRules) appliesToAll = false;
      appliesToAll ||= value === "*";
      hasRules = false;
      continue;
    }
    if (field === "allow" || field === "disallow") hasRules = true;
    if (field === "disallow" && appliesToAll && value.replace(/\s+/g, "") === "/") {
      disallows = true;
    }
    if (field === "allow" && appliesToAll && value === "/") allows = true;
  }

  return disallows && !allows;
}

function withoutTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/** A short, readable list of paths or routes for a finding message. */
function listTargets(values: readonly string[]): string {
  const shown = values.slice(0, 3).map((value) => `"${value}"`);
  return values.length <= shown.length
    ? shown.join(", ")
    : `${shown.join(", ")} and ${values.length - shown.length} more`;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
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
    const indexing: IndexingEvidence =
      unavailableReason === undefined && snapshot !== undefined
        ? indexingFromSignals(snapshot.signals.robots)
        : { status: "unknown", sources: [] };

    pages.push({
      href,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(content === undefined ? {} : { evidence: content }),
      titles: snapshot?.signals.titles.length ?? 0,
      headings: snapshot?.signals.h1s.length ?? 0,
      indexing
    });
  }

  return { base, pages };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
