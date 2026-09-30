import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareAudits, parseAuditReportText } from "ssrwire";
import type {
  AuditResult,
  AuditTarget,
  ComparisonChange,
  Finding,
  ProbeResult,
  TargetComparison
} from "ssrwire";
import { normalizeRoute, sanitizeSourceUrl } from "./core.js";
import type {
  DeliveryChange,
  DeliveryComparison,
  DeliveryEvidence,
  DeliveryFinding,
  DeliverySeverity,
  DeliveryStatus,
  IndexingEvidence,
  IndexingSource,
  IndexingStatus,
  LaunchFinding,
  LaunchFindingCode,
  LaunchEvidenceSource,
  MigrationProject,
  MigrationIssueSeverity,
  RouteComparison,
  RouteDelivery
} from "./types.js";
import { packageVersion } from "./version.js";

/**
 * Delivery evidence comes from SSRWire, which makes the request this tool will
 * not make: it records the response status, the streaming order of the SEO and
 * social metadata, and what a crawler-shaped user agent is served.
 *
 * wp-migrate-core writes the check files, reads the saved audits, and turns
 * them into migration work. Nothing in this module opens a socket; every
 * function reads or writes a local file.
 */

/**
 * Every SSRWire run costs targets × agents × repeat requests, so the generated
 * check stays deliberately short. The report itself may cover more routes than
 * the check file lists: a caller can extend the file by hand.
 */
export const deliveryCheckTargetLimit = 50;

/** Astro's `preview` server default, so the generated preview check runs as written. */
const previewOrigin = "http://localhost:4321";
/** Used only when the export carries no site URL of its own. */
const sourceOriginFallback = "https://wordpress.example";

/** Audiences whose `noindex` removes the page from a search result. */
const indexingAudiences = new Set(["robots", "googlebot", "bingbot"]);

/**
 * The social properties SSRWire captures. Losing one is a user-visible
 * regression, because a shared link stops showing the preview the site used to
 * render, so these are treated as their own kind of finding.
 */
const socialProperties = new Set([
  "og:title",
  "og:type",
  "og:url",
  "og:image",
  "og:description",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image"
]);

/**
 * SSRWire renders an absent metadata value as this sentinel, so the direction
 * of a change can be read without copying the value itself. If that ever
 * changes, presence detection simply stops reporting: it never invents one.
 */
const missingValueSentinel = "<missing>";

const indexingSourceOrder: Readonly<Record<IndexingSource, number>> = { meta: 0, header: 1 };

export interface DeliveryCheckFile {
  readonly path: string;
  readonly contents: string;
}

export interface DeliveryTarget {
  /** Stable handle shared by the source and preview check files. */
  readonly id: string;
  readonly route: string;
  /** The URL the WordPress site answers on. */
  readonly sourceUrl: string;
  /** The URL the generated site answers on. */
  readonly previewUrl: string;
}

export interface DeliveryRouteIndex {
  /** Sanitized paths this plan answers on, mapped to the planned route. */
  readonly byPath: ReadonlyMap<string, string>;
  /** Generated SSRWire target ids, mapped to the planned route. */
  readonly byId: ReadonlyMap<string, string>;
}

export interface DeliveryReadOptions {
  /** A saved SSRWire JSON audit of the site being checked. */
  readonly reportPath: string;
  /** A saved audit of the same routes taken before the migration. */
  readonly baselinePath?: string;
}

/**
 * One page a content source saw, and what it said about indexing. Verification
 * collects these so the publishing gate can group them the same way it groups
 * the delivery evidence.
 */
export interface ContentIndexing {
  readonly route: string;
  readonly source: "html-directory" | "routelint-report";
  readonly evidence: IndexingEvidence;
}

/**
 * Every finding that gates publishing, from whichever evidence the caller has.
 * A problem the whole template causes is reported once, naming the routes it
 * affects, instead of once per page.
 */
export function launchFindings(options: {
  readonly indexing?: readonly ContentIndexing[];
  readonly delivery?: DeliveryEvidence;
}): readonly LaunchFinding[] {
  const indexing = options.indexing ?? [];
  const drafts = indexingDrafts(indexing);
  if (options.delivery !== undefined) {
    drafts.push(...deliveryLaunchDrafts(options.delivery, blockedByContent(indexing)));
  }
  return groupLaunchDrafts(drafts);
}

/**
 * Blocks a local build or crawl already reported. The served response saying
 * the same thing about the same route is not new information; a response that
 * adds a header is, because no file can show that.
 */
function blockedByContent(indexing: readonly ContentIndexing[]): ReadonlySet<string> {
  return new Set(
    indexing.flatMap((entry) =>
      entry.evidence.status === "blocked"
        ? [`${entry.route}\u0000${entry.evidence.sources.join(", ")}`]
        : []
    )
  );
}

/**
 * The two check files a handoff pairs: one for the site being left, one for the
 * site being built. They list the same target ids so SSRWire and this tool can
 * line the two audits up even though the origins differ.
 */
export function deliveryCheckFiles(project: MigrationProject): readonly DeliveryCheckFile[] {
  const targets = deliveryCheckTargets(project);
  if (targets.length === 0) return [];

  const listed = targets.slice(0, deliveryCheckTargetLimit);
  return [
    {
      path: "migration/checks/ssrwire-source.yml",
      contents: renderCheckFile("source", project, listed, targets.length)
    },
    {
      path: "migration/checks/ssrwire-preview.yml",
      contents: renderCheckFile("preview", project, listed, targets.length)
    }
  ];
}

/**
 * One target per planned route, in plan order. The source URL comes from the
 * export, because that is what the WordPress site answers on; the preview URL
 * is the generated route.
 */
export function deliveryCheckTargets(project: MigrationProject): readonly DeliveryTarget[] {
  const origin = sourceOriginFor(project);
  const takenIds = new Set<string>();
  const takenUrls = new Set<string>();
  const seenRoutes = new Set<string>();
  const targets: DeliveryTarget[] = [];

  for (const record of project.records) {
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);

    const exported = project.routes.entries.find((entry) => entry.sourceId === record.sourceId)?.sourceUrl
      ?? record.route;
    const sourceUrl = sourceUrlFor(exported, origin, route);
    const previewUrl = absoluteOnOrigin(previewOrigin, route);
    if (takenUrls.has(sourceUrl) || takenUrls.has(previewUrl)) continue;
    takenUrls.add(sourceUrl);
    takenUrls.add(previewUrl);

    targets.push({
      id: uniqueCheckId(route, takenIds),
      route,
      sourceUrl,
      previewUrl
    });
  }

  return targets;
}

/**
 * Match a saved report back to the plan. Paths come first because a caller's
 * own config may not use these ids; ids catch the source audit, whose paths are
 * the WordPress permalinks rather than the generated routes.
 */
export function deliveryRouteIndex(project: MigrationProject): DeliveryRouteIndex {
  const byPath = new Map<string, string>();
  const routes = plannedRoutes(project);

  for (const planned of routes) {
    claim(byPath, planned.route, planned.route);
    claim(byPath, withoutTrailingSlash(planned.route), planned.route);
  }

  for (const record of project.records) {
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    const exported = exportedPath(
      project.routes.entries.find((entry) => entry.sourceId === record.sourceId)?.sourceUrl ?? record.route
    );
    if (exported === undefined) continue;
    claim(byPath, exported, route);
    claim(byPath, withoutTrailingSlash(exported), route);
  }

  const byId = new Map<string, string>();
  for (const target of deliveryCheckTargets(project)) {
    byId.set(target.id, target.route);
  }

  return { byPath, byId };
}

/**
 * Read a saved SSRWire audit and describe what it says about every planned
 * route, along with what changed since a baseline audit when one is supplied.
 */
export async function readDeliveryEvidence(
  project: MigrationProject,
  options: DeliveryReadOptions
): Promise<DeliveryEvidence> {
  const reportPath = resolve(options.reportPath);
  const report = await readAuditReport("--ssrwire-report", reportPath);
  const index = deliveryRouteIndex(project);

  const buckets = new Map<string, DeliveryBucket>();
  let unmatchedTargets = 0;

  for (const result of report.results) {
    const route = matchTarget(result.target, index);
    if (route === undefined) {
      unmatchedTargets += 1;
      continue;
    }

    const bucket = buckets.get(route) ?? { route, targetIds: [], probes: [], findings: [] };
    if (result.target.id !== undefined) bucket.targetIds.push(result.target.id);
    bucket.probes.push(...result.probes);
    bucket.findings.push(...result.findings);
    buckets.set(route, bucket);
  }

  const routes: RouteDelivery[] = [];
  for (const planned of plannedRoutes(project)) {
    const bucket = buckets.get(planned.route);
    routes.push(
      bucket === undefined
        ? unobservedDelivery(planned, routes.length + 1)
        : observedDelivery(bucket, planned, routes.length + 1)
    );
  }

  const findings = routes.flatMap((route) => route.findings);
  const comparison =
    options.baselinePath === undefined
      ? undefined
      : await readDeliveryComparison(resolve(options.baselinePath), reportPath, report, index);

  return {
    observed: "ssrwire-report",
    source: reportPath,
    version: report.version,
    generatedAt: report.generatedAt,
    routes,
    summary: {
      checked: true,
      covered: routes.filter((route) => route.status !== "unobserved").length,
      delivered: routes.filter((route) => route.status === "delivered").length,
      failed: routes.filter((route) => route.status === "failed").length,
      incomplete: routes.filter((route) => route.status === "incomplete").length,
      unobserved: routes.filter((route) => route.status === "unobserved").length,
      blockedIndexing: routes.filter((route) => route.indexing === "blocked").length,
      unmatchedTargets,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length
    },
    ...(comparison === undefined ? {} : { comparison })
  };
}

/**
 * What a saved delivery report adds to the publishing gate. A blocking robots
 * directive is reported once per route here, so the underlying
 * `robots-header-noindex` finding is not repeated as a contract problem.
 *
 * A problem the whole template causes is one thing to fix, so findings collapse
 * twice: once per user-agent profile, and again across the routes they share.
 * "Forty pages have no description" is a layout task; the per-route evidence
 * stays in the delivery section of the verification artefact.
 */
export function deliveryLaunchFindings(evidence: DeliveryEvidence): readonly LaunchFinding[] {
  return groupLaunchDrafts(deliveryLaunchDrafts(evidence, new Set()));
}

/** Blocks a content source saw, before they are grouped with anything else. */
function indexingDrafts(indexing: readonly ContentIndexing[]): LaunchDraft[] {
  const drafts: LaunchDraft[] = [];

  for (const entry of indexing) {
    if (entry.evidence.status !== "blocked") continue;
    const sources = entry.evidence.sources.join(", ");

    drafts.push({
      severity: "blocker",
      code: "INDEXING_BLOCKED",
      route: entry.route,
      source: entry.source,
      title: "Indexing is blocked",
      group: `content\u0000${sources}`,
      agents: [],
      single: `${entry.route} was built with robots directives that block indexing (${sources}).`,
      many: `The built pages carry robots directives that block indexing (${sources}).`,
      requiredAction:
        "Remove the meta robots noindex and the robots.txt disallow before publishing. The handoff ships both so a preview is not indexed; run this check without --fail-on blocker while that is deliberate."
    });
  }

  return drafts;
}

function deliveryLaunchDrafts(
  evidence: DeliveryEvidence,
  alreadyBlocked: ReadonlySet<string>
): LaunchDraft[] {
  const drafts: LaunchDraft[] = [];
  // A route that did not answer is one problem. Its missing metadata and empty
  // main text are symptoms of that, not separate work.
  const unusable = new Set(
    evidence.routes
      .filter((route) => route.status === "failed" || route.status === "incomplete")
      .map((route) => route.route)
  );
  // A regression already names the contract it broke, so the candidate-side
  // finding behind it is not repeated as a separate contract problem.
  const regressed = new Set(
    (evidence.comparison?.routes ?? []).filter((comparison) => comparison.baselineComplete).flatMap((comparison) =>
      comparison.changes
        .filter((change) => change.kind === "regression")
        .map((change) => `${comparison.route}\u0000${change.code}`)
    )
  );

  for (const route of evidence.routes) {
    if (route.indexing === "blocked") {
      const introduced = regressed.has(`${route.route}\u0000robots-header-noindex`);
      const sources = route.indexingSources.join(", ");
      const note = introduced ? " The source audit did not report that block." : "";
      if (!alreadyBlocked.has(`${route.route}\u0000${sources}`)) {
        drafts.push({
          severity: "blocker",
          code: "INDEXING_BLOCKED",
          route: route.route,
          source: "ssrwire-report",
          title: "Indexing is blocked",
          group: `${sources}\u0000${introduced ? "introduced" : "already-blocked"}`,
          agents: [],
          single: `${route.route} was served with robots directives that block indexing (${sources}).${note}`,
          many: `The audited pages were served with robots directives that block indexing (${sources}).${note}`,
          requiredAction:
            "Remove the meta robots noindex and the robots.txt disallow before publishing, or run this check without --fail-on blocker while the site is meant to stay private."
        });
      }
    }

    if (route.status === "failed") {
      drafts.push({
        severity: "blocker",
        code: "DELIVERY_FAILED",
        route: route.route,
        source: "ssrwire-report",
        title: "Routes that did not answer successfully",
        group: String(route.httpStatus ?? "no-status"),
        agents: [],
        single: route.reason,
        many: `These routes answered with HTTP ${route.httpStatus ?? "no status"}.`,
        requiredAction: "Check what the route answers now, then fix the response or the route mapping."
      });
    }

    if (route.status === "incomplete") {
      drafts.push({
        severity: "blocker",
        code: "DELIVERY_INCOMPLETE",
        route: route.route,
        source: "ssrwire-report",
        title: "Routes that did not deliver a complete response",
        group: route.reason,
        agents: [],
        single: route.reason,
        many: "These routes did not deliver a complete response.",
        requiredAction: "Check why the response did not complete, then run the audit again."
      });
    }

    const delivered = route.status === "delivered";
    for (const problem of delivered ? contractProblems(route.findings, route.route, regressed) : []) {
      const agents = describeAgents(problem.agents);
      drafts.push({
        severity: problem.severity === "error" ? "blocker" : "warning",
        code: "DELIVERY_CONTRACT",
        route: route.route,
        source: "ssrwire-report",
        sourceCode: problem.code,
        group: `${problem.code}\u0000${problem.agents.join(",")}`,
        agents: problem.agents,
        title: "SSRWire contract problems on delivered pages",
        single: `${route.route} was served with ${problem.code}.${agents}`,
        many: `These routes were served with ${problem.code}.${agents}`,
        requiredAction:
          "Read the SSRWire report for the observed evidence, then fix the delivery or narrow the contract in migration/checks/."
      });
    }

    const lostSocial = delivered ? lostSocialMetadata(evidence, route.route) : [];
    if (lostSocial.length > 0) {
      const names = lostSocial.map((entry) => entry.field);
      const agents = [...new Set(lostSocial.flatMap((entry) => entry.agents))].sort();
      drafts.push({
        severity: "warning",
        code: "DELIVERY_REGRESSION",
        route: route.route,
        source: "ssrwire-report",
        sourceCode: "metadata-value-changed",
        ...(names.length === 1 ? { field: names[0]! } : { fields: names }),
        group: `social\u0000${names.join(",")}\u0000${agents.join(",")}`,
        agents,
        title: "Social preview metadata was lost",
        single:
          `The rebuilt page lost ${listOf(names)}, which the source site was serving.` +
          describeAgents(agents),
        many:
          `The rebuilt pages lost ${listOf(names)}, which the source site was serving.` +
          describeAgents(agents),
        requiredAction:
          "Write those Open Graph and Twitter Card tags in the layout or component that renders the head, then compare the audits again: they are what a shared link shows."
      });
    }

    if (route.status === "unobserved") {
      const covered = evidence.summary.covered;
      drafts.push({
        severity: covered === 0 ? "blocker" : "warning",
        code: "DELIVERY_UNOBSERVED",
        route: route.route,
        source: "ssrwire-report",
        group: covered === 0 ? "no-coverage" : "partial-coverage",
        agents: [],
        title: "Routes with no delivery evidence",
        single: "The supplied report carries no target for this route.",
        many: "The supplied report carries no target for these routes.",
        requiredAction:
          covered === 0
            ? "The audit covers none of the planned routes. Check that the target ids or origins in migration/checks/ match the site you audited."
            : "Add the routes you care about to both files in migration/checks/, or accept partial coverage knowingly: an unobserved route is not a verified one."
      });
    }
  }

  // A baseline that never answered cannot tell anyone what the rebuilt site
  // lost, and reading its incomplete probes as regressions would invert the
  // story. Say that instead.
  for (const comparison of evidence.comparison?.routes ?? []) {
    if (comparison.baselineComplete) continue;
    drafts.push({
      severity: "warning",
      code: "DELIVERY_UNOBSERVED",
      route: comparison.route,
      source: "ssrwire-report",
      group: "baseline-incomplete",
      agents: [],
      title: "No usable source audit to compare against",
      single: "This route has no complete, successful source audit to compare against.",
      many: "These routes have no complete, successful source audits to compare against.",
      requiredAction:
        "Run npm run check:source against the site you are leaving while it still answers, then compare again. A baseline captured from a domain that does not resolve, a site that is down or an unfinished deployment proves nothing."
    });
  }

  for (const regression of regressions(evidence)) {
    const comparison = evidence.comparison?.routes.find((entry) => entry.route === regression.route);
    if (comparison !== undefined && !comparison.baselineComplete) continue;
    // Keep outcome changes; omit metadata symptoms of an unsuccessful response.
    if (unusable.has(regression.route) && !outcomeCodes.has(regression.code)) continue;
    const agents = describeAgents(regression.agents);
    drafts.push({
      severity: regression.severity,
      code: "DELIVERY_REGRESSION",
      route: regression.route,
      source: "ssrwire-report",
      sourceCode: regression.code,
      group: `${regression.code}\u0000${regression.field ?? ""}\u0000${regression.agents.join(",")}`,
      agents: regression.agents,
      ...(regression.field === undefined ? {} : { field: regression.field }),
      title: "Delivery regressions against the source site",
      single: `${regression.message}${agents}`,
      many: `${regression.message}${agents}`,
      requiredAction:
        "Compare the two SSRWire reports, then fix the difference or decide deliberately that the new behaviour is correct."
    });
  }

  return drafts;
}

interface LaunchDraft {
  readonly severity: MigrationIssueSeverity;
  readonly code: LaunchFindingCode;
  readonly route: string;
  readonly source: LaunchEvidenceSource;
  readonly title: string;
  readonly requiredAction: string;
  /** Detail that has to match before two routes share one finding. */
  readonly group: string;
  readonly agents: readonly string[];
  readonly field?: string;
  readonly fields?: readonly string[];
  readonly sourceCode?: string;
  /** The message when the finding covers one route. */
  readonly single: string;
  /** The message when it covers several, before the affected routes are named. */
  readonly many: string;
}

const launchSeverityOrder: Readonly<Record<MigrationIssueSeverity, number>> = { blocker: 0, warning: 1 };

/** Findings that describe what a route answered, which is worth keeping on its own. */
const outcomeCodes = new Set(["status-mismatch", "probe-completion-changed"]);

/** One finding per shared problem, naming the routes it affects. */
function groupLaunchDrafts(drafts: readonly LaunchDraft[]): readonly LaunchFinding[] {
  const groups = new Map<string, LaunchDraft[]>();

  for (const draft of drafts) {
    const key = [
      draft.code,
      draft.source,
      draft.severity,
      draft.sourceCode ?? "",
      draft.field ?? "",
      draft.group
    ].join("\u0000");
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [draft]);
    else bucket.push(draft);
  }

  const taken = new Set<string>();
  const findings: LaunchFinding[] = [];

  for (const bucket of groups.values()) {
    const first = bucket[0];
    const route = [...new Set(bucket.map((draft) => draft.route))].sort()[0];
    if (first === undefined || route === undefined) continue;

    const routes = [...new Set(bucket.map((draft) => draft.route))].sort();
    const agents = [...new Set(bucket.flatMap((draft) => draft.agents))].sort();
    const shared = routes.length > 1;

    findings.push(createLaunchFinding({
      severity: first.severity,
      code: first.code,
      ...(shared ? { routes } : { route }),
      source: first.source,
      ...(agents.length === 1 ? { agent: agents[0] } : {}),
      ...(first.field === undefined ? {} : { field: first.field }),
      ...(first.fields === undefined ? {} : { fields: first.fields }),
      ...(first.sourceCode === undefined ? {} : { sourceCode: first.sourceCode }),
      title: first.title,
      message: shared ? `${first.many} Affected: ${describeRoutes(routes)}.` : first.single,
      requiredAction: first.requiredAction
    }, taken));
  }

  return findings.sort((left, right) => {
    const severity = launchSeverityOrder[left.severity] - launchSeverityOrder[right.severity];
    if (severity !== 0) return severity;
    return left.id.localeCompare(right.id);
  });
}

/** Name a bounded sample of the routes a grouped finding affects. */
function describeRoutes(routes: readonly string[]): string {
  const shown = routes.slice(0, 3);
  const rest = routes.length - shown.length;
  return `${shown.join(", ")}${rest === 0 ? "" : ` and ${rest} more`}`;
}

/** Name the things a finding is about, however many of them there are. */
function listOf(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Social tags the source site served and the rebuilt site does not. SSRWire
 * reports a metadata difference without saying which way it went once the
 * values are dropped, so the direction is read from whether each side had a
 * value at all.
 */
function lostSocialMetadata(
  evidence: DeliveryEvidence,
  route: string
): readonly { readonly field: string; readonly agents: readonly string[] }[] {
  const comparison = evidence.comparison?.routes.find((entry) => entry.route === route);
  if (comparison === undefined || !comparison.baselineComplete) return [];

  const lost = new Map<string, Set<string>>();

  for (const change of comparison.changes) {
    if (change.code !== "metadata-value-changed") continue;
    if (change.field === undefined || !socialProperties.has(change.field)) continue;
    if (change.baselinePresent !== true || change.candidatePresent !== false) continue;

    const agents = lost.get(change.field) ?? new Set<string>();
    for (const agent of change.agents) agents.add(agent);
    lost.set(change.field, agents);
  }

  return [...lost.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, agents]) => ({ field, agents: [...agents].sort() }));
}

interface CollapsedProblem {
  readonly code: string;
  /** The worst severity any profile saw. */
  severity: DeliverySeverity;
  readonly agents: readonly string[];
}

/** One problem per route and code, with the profiles that saw it. */
function contractProblems(
  findings: readonly DeliveryFinding[],
  route: string,
  regressed: ReadonlySet<string>
): readonly CollapsedProblem[] {
  const problems = new Map<string, { code: string; severity: DeliverySeverity; agents: Set<string> }>();

  for (const finding of findings) {
    if (finding.severity === "info" || finding.code === "robots-header-noindex") continue;
    if (regressed.has(`${route}\u0000${finding.code}`)) continue;

    const problem = problems.get(finding.code) ?? {
      code: finding.code,
      severity: finding.severity,
      agents: new Set<string>()
    };
    if (finding.severity === "error") problem.severity = "error";
    if (finding.agent !== undefined) problem.agents.add(finding.agent);
    problems.set(finding.code, problem);
  }

  return [...problems.values()].map((problem) => ({
    code: problem.code,
    severity: problem.severity,
    agents: [...problem.agents].sort()
  }));
}

interface CollapsedRegression {
  readonly route: string;
  readonly code: string;
  readonly field?: string;
  readonly severity: "warning" | "blocker";
  readonly agents: readonly string[];
  readonly message: string;
}

/** One regression per route, code and field, keeping the worst severity seen. */
function regressions(evidence: DeliveryEvidence): readonly CollapsedRegression[] {
  const collapsed = new Map<
    string,
    {
      route: string;
      code: string;
      field?: string;
      severity: "warning" | "blocker";
      agents: Set<string>;
      message: string;
    }
  >();

  for (const comparison of evidence.comparison?.routes ?? []) {
    if (!comparison.baselineComplete) continue;
    const lostSocial = lostSocialMetadata(evidence, comparison.route);
    for (const change of comparison.changes) {
      if (change.kind !== "regression") continue;
      // Already reported once as the indexing block for this route, which is
      // the finding a reviewer acts on.
      if (change.code === "robots-header-noindex") continue;
      // A lost social tag is reported as the property the page stopped
      // serving, which is more useful than the contract that noticed it.
      const socialPrefix = change.code === "missing-open-graph-metadata" ? "og:"
        : change.code === "missing-twitter-card-metadata" ? "twitter:" : undefined;
      if (socialPrefix !== undefined && change.candidateSeverity !== "error" &&
          lostSocial.some((entry) => entry.field.startsWith(socialPrefix))) continue;

      const key = `${comparison.route}\u0000${change.code}\u0000${change.field ?? ""}`;
      const severity = change.scope === "timing" || change.candidateSeverity === "warning" ? "warning" : "blocker";
      const existing = collapsed.get(key);

      if (existing === undefined) {
        collapsed.set(key, {
          route: comparison.route,
          code: change.code,
          ...(change.field === undefined ? {} : { field: change.field }),
          severity,
          agents: new Set(change.agents),
          message: change.message
        });
        continue;
      }

      for (const agent of change.agents) existing.agents.add(agent);
      if (severity === "blocker") existing.severity = "blocker";
    }
  }

  return [...collapsed.values()].map((regression) => ({
    route: regression.route,
    code: regression.code,
    ...(regression.field === undefined ? {} : { field: regression.field }),
    severity: regression.severity,
    agents: [...regression.agents].sort(),
    message: regression.message
  }));
}

/** Name the user-agent profiles behind a collapsed finding, briefly. */
function describeAgents(agents: readonly string[]): string {
  if (agents.length === 0) return "";
  if (agents.length === 1) return ` Seen for ${agents[0]}.`;
  if (agents.length <= 4) return ` Seen for ${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}.`;
  const others = agents.length - 3;
  return ` Seen for ${agents.slice(0, 3).join(", ")} and ${others} other ${others === 1 ? "profile" : "profiles"}.`;
}

/** Read robots directives that a document or a response header carries. */
export function indexingFromSignals(
  signals: readonly { readonly audience: string; readonly value: string; readonly source?: string }[]
): IndexingEvidence {
  const sources = new Set<IndexingSource>();
  for (const signal of signals) {
    if (!indexingAudiences.has(signal.audience.toLowerCase())) continue;
    if (!robotsDirectives(signal.value, signal.source === "header").has("noindex")) continue;
    sources.add(signal.source === "header" ? "header" : "meta");
  }

  return summarizeIndexing(sources);
}

interface DeliveryBucket {
  readonly route: string;
  readonly targetIds: string[];
  readonly probes: ProbeResult[];
  readonly findings: Finding[];
}

interface PlannedDeliveryRoute {
  readonly route: string;
  readonly sourceId: string;
}

function observedDelivery(
  bucket: DeliveryBucket,
  planned: PlannedDeliveryRoute,
  ordinal: number
): RouteDelivery {
  const primary = primaryProbe(bucket.probes);
  const status = deliveryStatus(primary);
  const indexing = combineIndexing(bucket.probes.map(probeIndexing));
  const findings = collapseFindings(bucket.findings);
  const requiredAction = requiredActionFor(status, indexing.status);

  return {
    id: `verification:delivery:${ordinal}`,
    sourceId: planned.sourceId,
    route: planned.route,
    ...(bucket.targetIds[0] === undefined ? {} : { targetId: bucket.targetIds[0] }),
    status,
    ...(primary?.status === undefined ? {} : { httpStatus: primary.status }),
    agents: new Set(bucket.probes.map((probe) => probe.agent.key)).size,
    indexing: indexing.status,
    indexingSources: indexing.sources,
    socialMetadata: socialMetadataOf(bucket.probes),
    findings,
    reason: deliveryReason(status, primary),
    ...(requiredAction === undefined ? {} : { requiredAction })
  };
}

function unobservedDelivery(planned: PlannedDeliveryRoute, ordinal: number): RouteDelivery {
  return {
    id: `verification:delivery:${ordinal}`,
    sourceId: planned.sourceId,
    route: planned.route,
    status: "unobserved",
    agents: 0,
    indexing: "unknown",
    indexingSources: [],
    socialMetadata: [],
    findings: [],
    reason: "The supplied report carries no target for this route."
  };
}

/** The social tags the response carried, by property name. */
function socialMetadataOf(probes: readonly ProbeResult[]): readonly string[] {
  const properties = new Set<string>();

  for (const probe of probes) {
    if (probe.completion !== "complete") continue;
    for (const signal of probe.signals.socialMetadata ?? []) {
      if (socialProperties.has(signal.property)) properties.add(signal.property);
    }
  }

  return [...properties].sort();
}

function deliveryReason(status: DeliveryStatus, primary: ProbeResult | undefined): string {
  if (primary === undefined) {
    return "The supplied report carries a target for this route but no probe.";
  }
  if (status === "incomplete") {
    return `The probe did not complete (${primary.completion}).`;
  }
  if (status === "failed") {
    return `The probe answered with HTTP ${primary.status ?? "no status"}.`;
  }
  return `The probe answered with HTTP ${primary.status ?? "an unknown status"} for ${primary.agent.label}.`;
}

function requiredActionFor(status: DeliveryStatus, indexing: IndexingStatus): string | undefined {
  if (status === "failed" || status === "incomplete") {
    return "Check what the route answers now, then fix the response or the route mapping.";
  }
  if (indexing === "blocked") {
    return "Remove the directive that blocks indexing before publishing, or keep the site private deliberately.";
  }
  return undefined;
}

function primaryProbe(probes: readonly ProbeResult[]): ProbeResult | undefined {
  // A successful browser response must not hide a failed crawler or a failed
  // repeat. Report an unsuccessful probe before choosing a healthy one.
  return probes.find((probe) => deliveryStatus(probe) === "incomplete") ??
    probes.find((probe) => deliveryStatus(probe) === "failed") ??
    probes.find((probe) => probe.agent.key === "browser") ?? probes[0];
}

function deliveryStatus(primary: ProbeResult | undefined): DeliveryStatus {
  if (primary === undefined) return "unobserved";
  if (primary.completion !== "complete") return "incomplete";
  if (primary.status === undefined || primary.status < 200 || primary.status >= 300) return "failed";
  return "delivered";
}

function probeIndexing(probe: ProbeResult): IndexingEvidence {
  if (probe.completion !== "complete") {
    return { status: "unknown", sources: [] };
  }

  const sources = new Set<IndexingSource>(indexingFromSignals(probe.signals.robots).sources);
  const header = probe.headers.values["x-robots-tag"];
  if (header !== undefined && robotsDirectives(header, true).has("noindex")) {
    sources.add("header");
  }

  return summarizeIndexing(sources);
}

/** Worst case wins: one profile that may not index the page is enough to flag it. */
function combineIndexing(evidences: readonly IndexingEvidence[]): IndexingEvidence {
  const sources = new Set<IndexingSource>();
  let blocked = false;
  let observed = false;

  for (const evidence of evidences) {
    if (evidence.status === "unknown") continue;
    observed = true;
    if (evidence.status !== "blocked") continue;
    blocked = true;
    for (const source of evidence.sources) sources.add(source);
  }

  if (blocked) return summarizeIndexing(sources);
  return observed ? { status: "indexable", sources: [] } : { status: "unknown", sources: [] };
}

function summarizeIndexing(sources: Set<IndexingSource>): IndexingEvidence {
  if (sources.size === 0) {
    return { status: "indexable", sources: [] };
  }
  return {
    status: "blocked",
    sources: [...sources].sort((left, right) => indexingSourceOrder[left] - indexingSourceOrder[right])
  };
}

function robotsDirectives(value: string, header = false): Set<string> {
  const directives = new Set<string>();
  let audience: string | undefined;

  for (const part of value.toLowerCase().split(/[;,]/)) {
    let text = part.trim();
    const scoped = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/.exec(text);
    if (scoped !== null) {
      // These are directive values, not crawler scopes.
      if (["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"].includes(scoped[1]!)) continue;
      if (header) audience = scoped[1];
      text = scoped[2] ?? "";
    }
    if (header && audience !== undefined && !indexingAudiences.has(audience)) continue;
    const directive = text.split(/\s+/, 1)[0] ?? "";
    if (directive === "") continue;
    directives.add(directive);
    if (directive === "none") {
      directives.add("noindex");
      directives.add("nofollow");
    }
  }

  return directives;
}

function collapseFindings(findings: readonly Finding[]): readonly DeliveryFinding[] {
  const collapsed = new Map<string, DeliveryFinding>();

  for (const finding of findings) {
    const key = `${finding.severity}\u0000${finding.code}\u0000${finding.agent ?? ""}`;
    if (collapsed.has(key)) continue;
    collapsed.set(key, {
      code: finding.code,
      severity: finding.severity,
      ...(finding.agent === undefined ? {} : { agent: finding.agent })
    });
  }

  return [...collapsed.values()].sort((left, right) =>
    `${left.code}\u0000${left.agent ?? ""}`.localeCompare(`${right.code}\u0000${right.agent ?? ""}`)
  );
}

async function readDeliveryComparison(
  baselinePath: string,
  reportPath: string,
  candidate: AuditResult,
  index: DeliveryRouteIndex
): Promise<DeliveryComparison> {
  const baseline = await readAuditReport("--ssrwire-baseline", baselinePath);

  let comparison;
  try {
    comparison = compareAudits(baseline, candidate);
  } catch (error) {
    throw new Error(
      `Cannot compare the SSRWire reports ${baselinePath} and ${reportPath}: ${messageOf(error)}`
    );
  }

  const taken = new Set<string>();
  const routes: RouteComparison[] = [];
  let unmatched = 0;
  const baselineProbes = probesByTarget(baseline);

  for (const entry of comparison.results) {
    const route = routeForComparison(entry, index);
    if (route === undefined) {
      unmatched += 1;
      continue;
    }

    const changes = collapseChanges(entry.changes, route, taken);
    routes.push({
      id: `verification:comparison:${route}`,
      route,
      status: entry.status,
      baselineComplete: baselineCompleted(entry, baselineProbes),
      changes,
      regressions: changes.filter((change) => change.kind === "regression").length,
      fixed: changes.filter((change) => change.kind === "fixed").length,
      changed: changes.filter((change) => change.kind === "changed").length
    });
  }

  return {
    source: reportPath,
    baselineSource: baselinePath,
    candidate: { version: candidate.version, generatedAt: candidate.generatedAt },
    baseline: { version: baseline.version, generatedAt: baseline.generatedAt },
    routes,
    unmatched,
    summary: {
      matchedTargets: comparison.summary.matchedTargets,
      addedTargets: comparison.summary.addedTargets,
      removedTargets: comparison.summary.removedTargets,
      unchangedTargets: comparison.summary.unchangedTargets,
      regressions: comparison.summary.regressions,
      fixed: comparison.summary.fixed,
      changed: comparison.summary.changed,
      unusableBaselines: routes.filter((route) => !route.baselineComplete).length
    }
  };
}

/** Baseline probes by target URL, so a comparison can be checked against them. */
function probesByTarget(report: AuditResult): ReadonlyMap<string, readonly ProbeResult[]> {
  return new Map(report.results.map((result) => [result.target.url, result.probes]));
}

/**
 * A comparison against a baseline that never answered says nothing about the
 * rebuilt site, so it must not be reported as the rebuilt site losing ground.
 */
function baselineCompleted(
  entry: TargetComparison,
  probes: ReadonlyMap<string, readonly ProbeResult[]>
): boolean {
  if (entry.baselineUrl === undefined) return false;
  const observed = probes.get(entry.baselineUrl);
  return observed !== undefined && observed.length > 0 &&
    observed.every((probe) => deliveryStatus(probe) === "delivered");
}

/**
 * Translate one SSRWire change into migration terms. Codes, fields, agents,
 * finding severities and numeric comparisons survive; the metadata text SSRWire
 * compared does not.
 */
function collapseChanges(
  changes: readonly ComparisonChange[],
  route: string,
  taken: Set<string>
): readonly DeliveryChange[] {
  // One row per difference. SSRWire reports per user-agent profile, and with
    // the compared text dropped, matching outcomes can share a profile list.
    // Different presence flags or numeric values must remain separate.
  const collapsed = new Map<string, ChangeDraft>();

  for (const change of changes) {
    const baselineSeverity = severityOf(change.baseline);
    const candidateSeverity = severityOf(change.candidate);
    const baselineValue = comparableValue(change.baseline);
    const candidateValue = comparableValue(change.candidate);
    // Only a metadata value change says anything about presence: a status or a
    // timing is always present on both sides when the probe completed.
    const present =
      change.code === "metadata-value-changed"
        ? { baseline: metadataPresent(change.baseline), candidate: metadataPresent(change.candidate) }
        : undefined;
    const key = JSON.stringify([
      change.kind, change.scope, change.code, change.field,
      baselineSeverity, candidateSeverity, baselineValue, candidateValue,
      present?.baseline, present?.candidate
    ]);
    const existing = collapsed.get(key);

    if (existing !== undefined) {
      existing.agents.add(change.agent ?? "");
      existing.baselineSeverity = worseSeverity(existing.baselineSeverity, baselineSeverity);
      existing.candidateSeverity = worseSeverity(existing.candidateSeverity, candidateSeverity);
      existing.baselinePresent ??= present?.baseline;
      existing.candidatePresent ??= present?.candidate;
      continue;
    }

    collapsed.set(key, {
      id: uniqueId(
        `verification:change:${route}:${change.scope}:${change.code}` +
          `${change.field === undefined ? "" : `:${change.field}`}`,
        taken
      ),
      route,
      kind: change.kind,
      scope: change.scope,
      code: change.code,
      ...(change.field === undefined ? {} : { field: change.field }),
      agents: new Set(change.agent === undefined ? [] : [change.agent]),
      baselineSeverity,
      candidateSeverity,
      ...(baselineValue === undefined ? {} : { baselineValue }),
      ...(candidateValue === undefined ? {} : { candidateValue }),
      baselinePresent: present?.baseline,
      candidatePresent: present?.candidate,
      message: describeChange(change, baselineSeverity, candidateSeverity)
    });
  }

  return [...collapsed.values()].map((draft) => ({
    id: draft.id,
    route: draft.route,
    kind: draft.kind,
    scope: draft.scope,
    code: draft.code,
    ...(draft.field === undefined ? {} : { field: draft.field }),
    agents: [...draft.agents].filter((agent) => agent !== "").sort(),
    ...(draft.baselineSeverity === undefined ? {} : { baselineSeverity: draft.baselineSeverity }),
    ...(draft.candidateSeverity === undefined ? {} : { candidateSeverity: draft.candidateSeverity }),
    ...(draft.baselineValue === undefined ? {} : { baselineValue: draft.baselineValue }),
    ...(draft.candidateValue === undefined ? {} : { candidateValue: draft.candidateValue }),
    ...(draft.baselinePresent === undefined ? {} : { baselinePresent: draft.baselinePresent }),
    ...(draft.candidatePresent === undefined ? {} : { candidatePresent: draft.candidatePresent }),
    message: draft.message
  }));
}

interface ChangeDraft {
  readonly id: string;
  readonly route: string;
  readonly kind: "regression" | "fixed" | "changed";
  readonly scope: string;
  readonly code: string;
  readonly field?: string;
  readonly agents: Set<string>;
  baselineSeverity: DeliverySeverity | undefined;
  candidateSeverity: DeliverySeverity | undefined;
  readonly baselineValue?: number | boolean;
  readonly candidateValue?: number | boolean;
  baselinePresent: boolean | undefined;
  candidatePresent: boolean | undefined;
  readonly message: string;
}

const severityRank: Readonly<Record<DeliverySeverity, number>> = { info: 0, warning: 1, error: 2 };

/**
 * Whether one side of a metadata comparison carried a value. SSRWire hands the
 * comparison back as display text, so the sentinel it uses for an absent value
 * is the only thing read from it; the text itself never leaves this function.
 */
function metadataPresent(value: string | number | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() !== missingValueSentinel : true;
}

function worseSeverity(
  left: DeliverySeverity | undefined,
  right: DeliverySeverity | undefined
): DeliverySeverity | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return severityRank[left] >= severityRank[right] ? left : right;
}

/**
 * Wording for one change, derived from its code and its sanitized comparisons.
 * SSRWire's own message is not reused: it can quote the metadata it compared.
 */
function describeChange(
  change: ComparisonChange,
  baselineSeverity: DeliverySeverity | undefined,
  candidateSeverity: DeliverySeverity | undefined
): string {
  const field = change.field ?? "a compared field";
  const finding = change.scope === "finding";

  switch (change.code) {
    case "target-added":
      return "The candidate report has a target the baseline report does not.";
    case "target-removed":
      return "The baseline report has a target the candidate report does not.";
    case "target-policy-changed":
      return "The two reports audit this target under different expectations, so their findings are not comparable.";
    case "agent-added":
      return "The candidate report audits an agent the baseline report did not.";
    case "agent-removed":
      return "The baseline report audited an agent the candidate report does not.";
    case "metadata-value-changed":
      return `The ${field} value differs between the two audits.`;
    case "metadata-location-changed":
      return `The ${field} value moved between the document head and body.`;
    case "http-status-changed":
      return "The response status differs between the two audits.";
    case "final-url-changed":
      return "The response ended at a different URL.";
    case "redirect-chain-changed":
      return "The redirect chain differs between the two audits.";
    case "probe-completion-changed":
      return "The probe no longer completes the same way.";
    case "finding-evidence-changed":
      return `SSRWire reports the same ${field} finding with different evidence.`;
    case "timing-regression":
      return `The median ${field} became slower than the baseline.`;
    case "timing-improvement":
      return `The median ${field} became faster than the baseline.`;
    default:
      break;
  }

  // A finding-scope change carries the finding code itself, which is more
  // specific than the generic wording above can be.
  if (finding) {
    if (change.kind === "fixed") return `SSRWire no longer reports ${change.code}.`;
    if (baselineSeverity === undefined) {
      return `SSRWire reports ${change.code} on the rebuilt site and not on the source site.`;
    }
    if (candidateSeverity === undefined) {
      return `SSRWire reports ${change.code} less severely than it did before.`;
    }
    return `SSRWire reports ${change.code} more severely than it did before.`;
  }

  return `${change.code} changed between the two audits.`;
}

function severityOf(value: string | number | boolean | undefined): DeliverySeverity | undefined {
  return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function comparableValue(value: string | number | boolean | undefined): number | boolean | undefined {
  return typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function routeForComparison(entry: TargetComparison, index: DeliveryRouteIndex): string | undefined {
  return (
    routeForPath(entry.candidateUrl, index) ??
    routeForPath(entry.baselineUrl, index) ??
    (entry.id === undefined ? undefined : index.byId.get(entry.id))
  );
}

function matchTarget(target: AuditTarget, index: DeliveryRouteIndex): string | undefined {
  return (
    routeForPath(target.url, index) ??
    (target.id === undefined ? undefined : index.byId.get(target.id))
  );
}

function routeForPath(value: string | undefined, index: DeliveryRouteIndex): string | undefined {
  const path = sanitizedPath(value);
  return path === undefined ? undefined : index.byPath.get(path);
}

function plannedRoutes(project: MigrationProject): readonly PlannedDeliveryRoute[] {
  const seen = new Set<string>();
  const planned: PlannedDeliveryRoute[] = [];

  for (const record of project.records) {
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);
    if (seen.has(route)) continue;
    seen.add(route);
    planned.push({ route, sourceId: record.sourceId });
  }

  return planned;
}

async function readAuditReport(option: string, path: string): Promise<AuditResult> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the ${option} file ${path}: ${messageOf(error)}`);
  }

  try {
    return parseAuditReportText(contents, `${option} report`);
  } catch (error) {
    throw new Error(`Cannot read the ${option} file ${path}: ${messageOf(error)}`);
  }
}

function renderCheckFile(
  kind: "source" | "preview",
  project: MigrationProject,
  targets: readonly DeliveryTarget[],
  total: number
): string {
  const title = project.site.title.replace(/[\r\n\u2028\u2029]+/g, " ");
  const header = `# Generated by wp-migrate-core ${packageVersion} for ${title}.
#
${kind === "source" ? sourceCheckNotes(targets.length, total) : previewCheckNotes(targets.length, total)}

targets:
`;

  const body = targets
    .map((target) => {
      const url = kind === "source" ? target.sourceUrl : target.previewUrl;
      return (
        `  - id: ${JSON.stringify(target.id)}\n` +
        `    url: ${JSON.stringify(url)}\n` +
        `    require: ${checkContractFlow}`
      );
    })
    .join("\n");

  return `${header}${body}\n`;
}

/**
 * Both checks ask for the same things on purpose. The comparison only reports
 * what differs, so a page that never had a description cannot look like a page
 * that lost one. The social properties are included because a WordPress SEO
 * plugin usually emits them and a hand-written layout usually does not: that
 * gap is the regression most likely to reach a shared link unnoticed.
 */
const checkContract: Readonly<Record<string, boolean>> = {
  title: true,
  description: true,
  canonical: true,
  h1: true,
  mainText: true,
  openGraph: true,
  twitterCard: true
};

const checkContractFlow = `{${Object.entries(checkContract)
  .map(([key, value]) => `${key}: ${value}`)
  .join(", ")}}`;

function sourceCheckNotes(listed: number, total: number): string {
  return `# Capture what the live WordPress site delivers while it still answers, and keep
# the report:
#   npx ssrwire check --config migration/checks/ssrwire-source.yml --format json --output ssrwire-source.json
# migration/checks/ssrwire-preview.yml lists the same target ids on the preview
# origin, so wp-migrate-core can compare the two audits afterwards.
# ${listedOf(listed, total)}`;
}

function previewCheckNotes(listed: number, total: number): string {
  return `# Point this origin at the preview deployment, or run it locally with
# \`npm run preview\`, which serves ${previewOrigin} by default, and then keep the report:
#   npx ssrwire check --config migration/checks/ssrwire-preview.yml --format json --output ssrwire-preview.json
# The target ids and the required metadata match migration/checks/ssrwire-source.yml,
# so the comparison reports what the rebuilt pages lost rather than what they
# never had. The generated layout writes no description, canonical or social
# tags yet and asks crawlers not to index the site, so the first audit of the
# preview reports all of that as work to do.
# ${listedOf(listed, total)}`;
}

function listedOf(listed: number, total: number): string {
  const routes = total === 1 ? "route" : "routes";
  return listed === total
    ? `This audit covers all ${total} planned ${routes}. Every run costs targets x agents requests.`
    : `Listed: ${listed} of ${total} planned ${routes}. Every run costs targets x agents requests, so extend or trim this list deliberately.`;
}

function sourceUrlFor(exported: string | undefined, origin: string, route: string): string {
  const sanitized = exported === undefined ? undefined : sanitizeSourceUrl(exported);
  if (sanitized === undefined) return absoluteOnOrigin(origin, route);
  return /^https?:\/\//i.test(sanitized) ? sanitized : absoluteOnOrigin(origin, sanitized);
}

/** The WordPress path a source URL answers on, for matching a baseline report. */
function exportedPath(exported: string | undefined): string | undefined {
  const sanitized = exported === undefined ? undefined : sanitizeSourceUrl(exported);
  return sanitized === undefined ? undefined : sanitizedPath(sanitized);
}

function sanitizedPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = sanitizeSourceUrl(value);
  if (sanitized === undefined) return undefined;

  try {
    return new URL(sanitized).pathname;
  } catch {
    return sanitized.startsWith("/") ? sanitized : undefined;
  }
}

/** Absolute URL for a path on an origin, with or without a trailing slash. */
export function absoluteOnOrigin(origin: string, path: string): string {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(`./${path.startsWith("/") ? path.slice(1) : path}`, base).toString();
}

/** The origin the plan answers on, when the export names a site URL. */
export function siteOrigin(project: MigrationProject): string | undefined {
  return originOf(project.site.url) ?? originOf(project.source.url);
}

function sourceOriginFor(project: MigrationProject): string {
  return originOf(project.source.url) ?? siteOrigin(project) ?? sourceOriginFallback;
}

function originOf(value: string | undefined): string | undefined {
  const sanitized = value === undefined ? undefined : sanitizeSourceUrl(value);
  if (sanitized === undefined) return undefined;

  try {
    return new URL(sanitized).origin;
  } catch {
    return undefined;
  }
}

function uniqueCheckId(route: string, taken: Set<string>): string {
  const base = checkIdStem(route);
  let candidate = base;
  let suffix = 2;

  while (taken.has(candidate)) {
    const ending = `-${suffix}`;
    candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
    suffix += 1;
  }

  taken.add(candidate);
  return candidate;
}

/** SSRWire accepts `^[a-z0-9][a-z0-9._-]{0,63}$` as a target id. */
function checkIdStem(route: string): string {
  if (route === "/") return "home";

  const stem = route
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 64);

  return stem === "" ? "route" : stem;
}

function uniqueId(candidate: string, taken: Set<string>): string {
  let id = candidate;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${candidate}#${suffix}`;
    suffix += 1;
  }
  taken.add(id);
  return id;
}

/**
 * Give a launch finding the stable id every other artefact uses. Readable ids
 * keep two runs comparable; `taken` guarantees uniqueness when two grouped
 * findings would otherwise share one.
 */
function createLaunchFinding(
  finding: Omit<LaunchFinding, "id">,
  taken: Set<string>
): LaunchFinding {
  const id = uniqueId(
    `launch:${finding.code.toLowerCase().replaceAll("_", "-")}:${finding.source}:${finding.route ?? "site"}` +
      `${finding.sourceCode === undefined ? "" : `:${finding.sourceCode}`}` +
      `${finding.field === undefined ? "" : `:${finding.field}`}` +
      `${finding.agent === undefined ? "" : `:${finding.agent}`}`,
    taken
  );

  return { id, ...finding };
}

function claim(index: Map<string, string>, key: string, route: string): void {
  if (key === "" || index.has(key)) return;
  index.set(key, route);
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
