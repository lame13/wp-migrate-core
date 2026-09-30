#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTargetEnabled, targetAvailability } from "./adapters.js";
import { defaultMigrationConfigFileName, loadMigrationConfig } from "./config.js";
import type { LoadedMigrationConfig } from "./config.js";
import { linkRewrites, parseWxr, sanitizeLinkHref, sanitizeSourceUrl } from "./core.js";
import { generateAstroProject } from "./generate.js";
import { coverageEntryRecords, mergeLiveUrlSources, parseLiveUrlSource } from "./live-urls.js";
import { applyMediaDelivery, mediaDeliveryRecord, planMediaDelivery } from "./media.js";
import { redirectRuleFiles } from "./redirect-rules.js";
import { writeReport } from "./report.js";
import { verifySite } from "./verify.js";
import { packageVersion } from "./version.js";
import type {
  ContentRecord,
  DeliveryComparison,
  DeliveryEvidence,
  FailureThreshold,
  LaunchFinding,
  LiveUrlSource,
  MigrationConfig,
  MigrationIssue,
  MigrationNode,
  MigrationProject,
  MigrationSummary,
  OutputTarget,
  SiteVerification,
  VerificationStatus,
  VerificationSummary
} from "./types.js";

interface ParsedOptions {
  readonly command: string;
  readonly help: boolean;
  readonly version: boolean;
  readonly input?: string;
  readonly output?: string;
  readonly target: OutputTarget;
  readonly includeDrafts: boolean;
  readonly keepSourceLinks: boolean;
  readonly liveUrlPaths: readonly string[];
  readonly htmlDirectory?: string;
  readonly routelintReport?: string;
  readonly ssrwireReport?: string;
  readonly ssrwireBaseline?: string;
  readonly configPath?: string;
  readonly uploadsDirectory?: string;
  readonly mediaBaseUrl?: string;
  readonly copyUnusedMedia?: boolean;
  readonly json: boolean;
  /** Absent when the caller did not ask for a gate, so config can set one. */
  readonly failOn?: FailureThreshold;
}

interface CliOptions extends Omit<ParsedOptions, "failOn"> {
  readonly failOn: FailureThreshold;
}

function usage(): string {
  return `WP Migrate Core ${packageVersion}

Usage:
  wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro]
  wp-migrate-core convert <export.xml> --out <new-site> [--target astro]
  wp-migrate-core convert <export.xml> --out <new-site> --uploads <uploads-dir>
  wp-migrate-core convert <export.xml> --out <new-site> --media-base <https://cdn.example.com/uploads>
  wp-migrate-core report <export.xml> [--out migration-report.html]
  wp-migrate-core verify <export.xml> --html-dir <built-site> [--out migration-verification.json]
  wp-migrate-core verify <export.xml> --routelint-report <report.json>
  wp-migrate-core verify <export.xml> --html-dir <built-site> --ssrwire-report <audit.json>
  wp-migrate-core verify <export.xml> --html-dir <built-site> --ssrwire-report <audit.json> --ssrwire-baseline <audit.json>
  wp-migrate-core demo [--out wp-migrate-core-demo]

Options:
  --help, -h            show help, including after a command
  --version, -v         show the installed package version
  --include-drafts      also read items that are skipped by default
  --keep-source-links   keep exported link targets instead of rewriting them
  --config <file>       read a migration config that decides routes, excludes
                        items and waives reviewed findings; without this option
                        a ${defaultMigrationConfigFileName} next to the export is used
  --uploads <dir>       copy referenced media from a local uploads directory
                        into the generated site (convert and demo)
  --media-base <url>    point generated markup at a media host instead of
                        copying the files (convert and demo)
  --copy-unused-media   also deliver attachments no included content uses
                        (convert and demo)
  --live-urls <file>     compare a downloaded sitemap or URL list with the plan;
                        repeat the option to check several files at once
  --html-dir <dir>      verify a local build by reading its HTML files
  --routelint-report <file>
                        verify a site that RouteLint already crawled, using its
                        saved JSON report instead of a local build
  --ssrwire-report <file>
                        add SSRWire delivery evidence to the check: response
                        status, metadata and crawler delivery from a saved JSON
                        audit of the site you built
  --ssrwire-baseline <file>
                        compare that audit with one taken before the migration;
                        the two audits pair up on their target ids
  --json                print one JSON document instead of the summary
  --fail-on <severity>  fail on warning or blocker; none disables the gate (default)

Targets:
  astro  implemented
  next   planned, not implemented
  nuxt   planned, not implemented

This is a deliberately incomplete demonstration. It does not modify WordPress.

--live-urls reads a local file. Save the sitemap yourself; this tool makes no
network requests.

--html-dir, --routelint-report, --ssrwire-report and --ssrwire-baseline read
local files only. Build, crawl or audit the site first, then point the check at
the result.

--config and --uploads read local files only. Media is never fetched: files
come from the directory you name, or from the media host you point at.

--fail-on never changes what is written; it only sets the exit status so a
caller can gate on the repair queue. The verification gate covers missing
content, missing pages, a page that still blocks indexing, a route that answered
badly, and any delivery or metadata regression against a baseline audit.`;
}

function parseArguments(argv: readonly string[]): ParsedOptions {
  const command = argv[0] ?? "help";
  if (!["inspect", "convert", "report", "verify", "demo", "help", "--help", "-h", "--version", "-v"].includes(command)) {
    throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }

  let help = command === "help" || command === "--help" || command === "-h";
  let version = command === "--version" || command === "-v";
  let input: string | undefined;
  let output: string | undefined;
  let target: OutputTarget = "astro";
  let includeDrafts = false;
  let keepSourceLinks = false;
  const liveUrlPaths: string[] = [];
  let htmlDirectory: string | undefined;
  let routelintReport: string | undefined;
  let ssrwireReport: string | undefined;
  let ssrwireBaseline: string | undefined;
  let configPath: string | undefined;
  let uploadsDirectory: string | undefined;
  let mediaBaseUrl: string | undefined;
  let copyUnusedMedia = false;
  let json = false;
  let failOn: FailureThreshold | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      help = true;
    } else if (value === "--version" || value === "-v") {
      version = true;
    } else if (value === "--include-drafts") {
      includeDrafts = true;
    } else if (value === "--keep-source-links") {
      keepSourceLinks = true;
    } else if (value === "--config") {
      configPath = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--uploads") {
      uploadsDirectory = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--media-base") {
      const candidate = optionValue(value, argv[index + 1]);
      if (!/^https?:\/\//i.test(candidate)) {
        throw new Error(
          `--media-base needs an absolute http or https URL, not "${candidate}". Media is never fetched: this is the host that already serves your uploads.`
        );
      }
      mediaBaseUrl = candidate;
      index += 1;
    } else if (value === "--copy-unused-media") {
      copyUnusedMedia = true;
    } else if (value === "--live-urls") {
      const candidate = optionValue(value, argv[index + 1]);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        throw new Error(
          "--live-urls reads a local file. Download the sitemap first and pass the saved file; this tool makes no network requests."
        );
      }
      liveUrlPaths.push(candidate);
      index += 1;
    } else if (value === "--html-dir") {
      htmlDirectory = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--routelint-report") {
      routelintReport = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--ssrwire-report") {
      ssrwireReport = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--ssrwire-baseline") {
      ssrwireBaseline = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--out") {
      output = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--target") {
      const candidate = optionValue(value, argv[index + 1]);
      if (candidate !== "astro" && candidate !== "next" && candidate !== "nuxt") {
        throw new Error(`Unknown target: ${candidate}. Use astro, next, or nuxt.`);
      }
      target = candidate;
      index += 1;
    } else if (value === "--fail-on") {
      const candidate = optionValue(value, argv[index + 1]);
      if (candidate !== "none" && candidate !== "warning" && candidate !== "blocker") {
        throw new Error(`Unknown --fail-on value: ${candidate}. Use none, warning, or blocker.`);
      }
      failOn = candidate;
      index += 1;
    } else if (!value?.startsWith("-") && input === undefined) {
      input = value;
    } else {
      throw new Error(`Unknown argument: ${value ?? "missing"}`);
    }
  }

  if (!help && !version) {
    const hasDelivery = ssrwireReport !== undefined || ssrwireBaseline !== undefined;
    const hasMediaOptions =
      uploadsDirectory !== undefined || mediaBaseUrl !== undefined || copyUnusedMedia;
    if (command !== "convert" && command !== "demo" && hasMediaOptions) {
      throw new Error(
        "--uploads, --media-base and --copy-unused-media write files into a generated project, so they are only supported by convert and demo."
      );
    }
    if (
      command !== "verify" &&
      (htmlDirectory !== undefined || routelintReport !== undefined || hasDelivery)
    ) {
      throw new Error(
        "--html-dir, --routelint-report, --ssrwire-report and --ssrwire-baseline are only supported by verify."
      );
    }
    if (command === "verify" && (htmlDirectory !== undefined) === (routelintReport !== undefined)) {
      throw new Error("Verification requires one observed source: pass --html-dir or --routelint-report.");
    }
    if (ssrwireBaseline !== undefined && ssrwireReport === undefined) {
      throw new Error(
        "--ssrwire-baseline compares two audits. Pass --ssrwire-report for the site you just checked."
      );
    }
  }

  return {
    command,
    help,
    version,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    target,
    includeDrafts,
    keepSourceLinks,
    liveUrlPaths,
    ...(htmlDirectory === undefined ? {} : { htmlDirectory }),
    ...(routelintReport === undefined ? {} : { routelintReport }),
    ...(ssrwireReport === undefined ? {} : { ssrwireReport }),
    ...(ssrwireBaseline === undefined ? {} : { ssrwireBaseline }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(uploadsDirectory === undefined ? {} : { uploadsDirectory }),
    ...(mediaBaseUrl === undefined ? {} : { mediaBaseUrl }),
    ...(copyUnusedMedia ? { copyUnusedMedia } : {}),
    json,
    ...(failOn === undefined ? {} : { failOn })
  };
}

function optionValue(option: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

/**
 * A migration config is the file the caller named, or the default name sitting
 * beside the export. A file the caller named has to exist; the default one is
 * only read when it is there.
 */
async function loadRunConfig(
  options: ParsedOptions,
  inputPath: string | undefined
): Promise<LoadedMigrationConfig | undefined> {
  if (options.configPath !== undefined) {
    return loadMigrationConfig(options.configPath);
  }
  if (inputPath === undefined) {
    return undefined;
  }

  const candidate = resolve(dirname(inputPath), defaultMigrationConfigFileName);
  return (await pathExists(candidate)) ? loadMigrationConfig(candidate) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Fold the config into the options. The command line wins where it was given,
 * and the config supplies the defaults for everything it did not.
 */
function resolveOptions(options: ParsedOptions, loaded: LoadedMigrationConfig | undefined): CliOptions {
  const config = loaded?.config;
  return {
    ...options,
    includeDrafts: options.includeDrafts || config?.includeDrafts === true,
    keepSourceLinks: options.keepSourceLinks || config?.keepSourceLinks === true,
    failOn: options.failOn ?? config?.failOn ?? "none",
    ...(loaded === undefined ? {} : { configPath: loaded.source })
  };
}

async function loadProject(
  inputPath: string,
  options: CliOptions,
  config: MigrationConfig | undefined
): Promise<MigrationProject> {
  const xml = await readFile(resolve(inputPath), "utf8");
  const liveUrlSource = await loadLiveUrlSource(options.liveUrlPaths);
  return parseWxr(xml, {
    includeDrafts: options.includeDrafts,
    ...(config === undefined ? {} : { config }),
    ...(liveUrlSource === undefined ? {} : { liveUrlSource })
  });
}

/**
 * Decide what the generated site does with every referenced upload.
 *
 * A run with neither an uploads directory nor a media base URL plans nothing,
 * which leaves the handoff exactly as 0.6 wrote it: source imagery stays a
 * repair marker. Nothing here fetches anything either way.
 */
async function deliverProjectMedia(
  project: MigrationProject,
  options: CliOptions,
  config: MigrationConfig | undefined
): Promise<MigrationProject> {
  const uploadsDirectory = options.uploadsDirectory ?? config?.media?.uploadsDir;
  const baseUrl = options.mediaBaseUrl ?? config?.media?.baseUrl;
  const copyUnusedAssets = options.copyUnusedMedia === true || config?.media?.copyUnused === true;

  if (uploadsDirectory === undefined && baseUrl === undefined) {
    return project;
  }

  const plan = await planMediaDelivery(project, {
    ...(uploadsDirectory === undefined ? {} : { uploadsDirectory }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(copyUnusedAssets ? { copyUnusedAssets: true } : {})
  });

  return applyMediaDelivery(project, plan);
}

/**
 * The demo ships a small uploads directory so the handoff shows real images
 * rather than markers. It is used only when the caller asked for nothing else,
 * and only when the directory is actually part of this install.
 */
async function demoMediaOptions(
  options: CliOptions,
  config: MigrationConfig | undefined
): Promise<{ readonly uploadsDirectory?: string }> {
  if (
    options.uploadsDirectory !== undefined ||
    options.mediaBaseUrl !== undefined ||
    config?.media?.uploadsDir !== undefined ||
    config?.media?.baseUrl !== undefined
  ) {
    return {};
  }

  const directory = fileURLToPath(new URL("../../fixtures/uploads", import.meta.url));
  return (await pathExists(directory)) ? { uploadsDirectory: directory } : {};
}

/**
 * Read the live URLs the caller supplied. They come from files only: the
 * coverage check never requests a sitemap, so a URL on the command line is a
 * mistake worth reporting rather than something to fetch.
 */
async function loadLiveUrlSource(paths: readonly string[]): Promise<LiveUrlSource | undefined> {
  if (paths.length === 0) {
    return undefined;
  }

  const sources: LiveUrlSource[] = [];
  for (const path of paths) {
    let contents: Buffer;
    try {
      contents = await readFile(resolve(path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read the --live-urls source ${path}: ${message}`);
    }

    sources.push(parseLiveUrlSource(contents, { sourcePath: path }));
  }

  return mergeLiveUrlSources(sources);
}

/**
 * Keep the default CLI plan useful for migration review without copying source
 * content, post metadata, parser attributes, diagnostic snippets, or
 * unsanitized source URLs into the default local review file.
 */
function createMigrationPlan(project: MigrationProject): object {
  return {
    site: { title: project.site.title },
    source: project.source.title === undefined ? {} : { title: project.source.title },
    records: project.records.map(createPlanRecord),
    issues: project.issues.map(createPlanIssue),
    media: {
      summary: project.media.summary,
      ...(project.media.delivery === undefined
        ? {}
        : { delivery: mediaDeliveryRecord(project.media.delivery) }),
      assets: project.media.assets.map((asset) => ({
        id: asset.id,
        wordpressId: asset.wordpressId,
        ...(asset.parentId === undefined ? {} : { parentId: asset.parentId }),
        title: asset.title,
        ...(asset.path === undefined ? {} : { path: asset.path }),
        ...(asset.url === undefined ? {} : { url: asset.url }),
        ...(asset.file === undefined ? {} : { file: asset.file }),
        ...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType }),
        ...(asset.altText === undefined ? {} : { altText: asset.altText }),
        ...(asset.width === undefined ? {} : { width: asset.width }),
        ...(asset.height === undefined ? {} : { height: asset.height }),
        referenceCount: asset.referenceCount,
        referencedBy: asset.referencedBy,
        ...(asset.delivery === undefined ? {} : { delivery: asset.delivery })
      })),
      references: project.media.references.map((reference) => ({
        id: reference.id,
        sourceId: reference.sourceId,
        ...(reference.route === undefined ? {} : { route: reference.route }),
        ...(reference.nodeId === undefined ? {} : { nodeId: reference.nodeId }),
        kind: reference.kind,
        ...(reference.path === undefined ? {} : { path: reference.path }),
        ...(reference.url === undefined ? {} : { url: reference.url }),
        ...(reference.altText === undefined ? {} : { altText: reference.altText }),
        ...(reference.assetId === undefined ? {} : { assetId: reference.assetId }),
        status: reference.status
      }))
    },
    routes: {
      summary: project.routes.summary,
      redirects: project.routes.redirects,
      entries: project.routes.entries
    },
    links: {
      summary: project.links.summary,
      rewrites: linkRewrites(project.links),
      references: project.links.references.map((reference) => ({
        id: reference.id,
        sourceId: reference.sourceId,
        ...(reference.route === undefined ? {} : { route: reference.route }),
        ...(reference.nodeId === undefined ? {} : { nodeId: reference.nodeId }),
        kind: reference.kind,
        href: sanitizeLinkHref(reference.href),
        ...(reference.path === undefined ? {} : { path: reference.path }),
        ...(reference.fragment === undefined ? {} : { fragment: reference.fragment }),
        ...(reference.host === undefined ? {} : { host: reference.host }),
        ...(reference.targetRoute === undefined ? {} : { targetRoute: reference.targetRoute }),
        status: reference.status,
        reason: reference.reason
      }))
    },
    coverage: {
      summary: project.coverage.summary,
      entries: coverageEntryRecords(project.coverage)
    },
    ...(project.config === undefined ? {} : { config: project.config }),
    summary: project.summary
  };
}

function createPlanRecord(record: ContentRecord): object {
  const route = sanitizeSourceUrl(record.route);

  return {
    sourceId: record.sourceId,
    wordpressId: record.wordpressId,
    type: record.type,
    status: record.status,
    title: record.title,
    slug: record.slug,
    ...(route === undefined ? {} : { route }),
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    ...(record.modifiedAt === undefined ? {} : { modifiedAt: record.modifiedAt }),
    editor: record.editor,
    nodes: record.nodes.map(createPlanNode),
    issues: record.issues.map(createPlanIssue)
  };
}

function createPlanNode(node: MigrationNode): object {
  return {
    id: node.id,
    source: node.source,
    sourceType: node.sourceType,
    kind: node.kind,
    conversion: node.conversion,
    children: node.children.map(createPlanNode)
  };
}

function createPlanIssue(issue: MigrationIssue): object {
  const route = sanitizeSourceUrl(issue.route);

  return {
    id: issue.id,
    severity: issue.severity,
    code: issue.code,
    sourceId: issue.sourceId,
    ...(route === undefined ? {} : { route }),
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.ignored === undefined ? {} : { ignored: issue.ignored }),
    title: issue.title,
    message: issue.message,
    requiredAction: issue.requiredAction
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function outputExistsError(outputPath: string): Error {
  return new Error(
    `Refusing to overwrite existing output: ${outputPath}. Choose a different --out path or remove the existing path intentionally.`
  );
}

async function prepareInspectionOutput(directory: string): Promise<void> {
  await mkdir(dirname(directory), { recursive: true });
  await assertOutputDoesNotExist(directory);
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }

  throw outputExistsError(outputPath);
}

async function writeNewFile(outputPath: string, contents: string): Promise<void> {
  try {
    await writeFile(outputPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) throw outputExistsError(outputPath);
    throw error;
  }
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function printSummary(project: MigrationProject): void {
  const { summary } = project;
  console.log(`\n${project.source.title ?? "WordPress export"}`);
  console.log(`  ${summary.records} records`);
  console.log(`  ${summary.nodes} detected content constructs`);
  console.log(`  ${summary.nativeNodes} constructs marked as directly supported`);
  console.log(`  ${summary.manualNodes} constructs need manual handling`);
  console.log(`  ${summary.blockedNodes} blocked constructs`);
  console.log(`  ${summary.blockers} blockers; ${summary.warnings} items need review`);
  console.log(
    `  media: ${summary.media.assets} ${pluralize(summary.media.assets, "asset")} in the export, ` +
      `${summary.media.referenced} referenced, ` +
      `${summary.media.notInExport} referenced but not in the export, ${summary.media.missingAltText} without alternative text`
  );
  const delivery = summary.media.delivery;
  if (delivery !== undefined) {
    console.log(
      `  media delivery: ${delivery.copied} of ${delivery.files} ${pluralize(delivery.files, "file")} copied, ` +
        `${delivery.linked} linked to the media base, ${delivery.remote} left remote, ${delivery.missing} missing`
    );
  }
  console.log(
    `  urls: ${summary.routes.generated} ${pluralize(summary.routes.generated, "route")} generated, ` +
      `${summary.routes.redirects} ${pluralize(summary.routes.redirects, "redirect")} needed, ` +
      `${summary.routes.withoutTarget} ${pluralize(summary.routes.withoutTarget, "source URL")} left without a target`
  );
  console.log(
    `  links: ${summary.links.internal} ${pluralize(summary.links.internal, "same-site link")}, ` +
      `${summary.links.needsRewrite} proposed rewrites, ` +
      `${summary.links.noTarget + summary.links.outsideExport} without a generated page, ` +
      `${summary.links.external} external`
  );

  if (project.coverage.summary.checked) {
    const coverage = project.coverage.summary;
    console.log(
      `  live urls: ${coverage.liveUrls} ${pluralize(coverage.liveUrls, "URL")} checked, ` +
        `${coverage.routed} served by a route, ${coverage.redirected} covered by a proposed rule, ` +
        `${coverage.uncovered} with no route or rule`
    );
  }

  if (project.issues.length > 0) {
    console.log("\nRepair queue");
    for (const issue of project.issues) {
      const marker = issue.severity === "blocker" ? "BLOCKED" : issue.severity.toUpperCase();
      console.log(`  [${marker}] ${issue.route ?? "site-wide"}: ${issue.message}`);
    }
  }
}

/**
 * A threshold is the minimum severity that should make the command fail. It is
 * a reporting choice only: every command still writes the same files.
 */
function failureThresholdTripped(summary: MigrationSummary, threshold: FailureThreshold): boolean {
  if (threshold === "blocker") return summary.blockers > 0;
  if (threshold === "warning") return summary.blockers > 0 || summary.warnings > 0;
  return false;
}

function describeFailure(summary: MigrationSummary, threshold: FailureThreshold): string {
  if (threshold === "blocker") {
    return `${summary.blockers} blocker(s)`;
  }

  return `${summary.blockers} blocker(s) and ${summary.warnings} warning(s)`;
}

/**
 * Keeps --json interchangeable with the default summary: the same sanitized
 * issues, the same counts, and no source content or unsanitized URLs.
 */
function createJsonDocument(
  project: MigrationProject,
  options: CliOptions,
  command: string,
  outputs: Readonly<Record<string, string>>,
  failed: boolean
): object {
  return {
    generator: { name: "wp-migrate-core", version: packageVersion },
    command,
    scan: {
      includeDrafts: options.includeDrafts,
      ...(options.configPath === undefined ? {} : { config: options.configPath })
    },
    source: project.source.title === undefined ? {} : { title: project.source.title },
    summary: project.summary,
    coverage: project.coverage.summary,
    issues: project.issues.map(createPlanIssue),
    ...(project.config === undefined ? {} : { config: project.config }),
    outputs,
    failed
  };
}

interface CommandResult {
  readonly command: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly humanLines: readonly string[];
}

function finishCommand(project: MigrationProject, options: CliOptions, result: CommandResult): void {
  const failed = failureThresholdTripped(project.summary, options.failOn);

  if (options.json) {
    console.log(JSON.stringify(createJsonDocument(project, options, result.command, result.outputs, failed), null, 2));
  } else {
    printSummary(project);
    for (const line of result.humanLines) {
      console.log(line);
    }
  }

  if (failed) {
    process.exitCode = 1;
    console.error(
      `wp-migrate-core: --fail-on ${options.failOn} matched ${describeFailure(project.summary, options.failOn)}. Review the repair queue before using this handoff.`
    );
  }
}

interface VerificationRouteRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly route: string;
  readonly status: VerificationStatus;
  readonly sourceWords: number;
  readonly observedWords?: number;
  readonly simhashDistance?: number;
  readonly reason: string;
  readonly requiredAction?: string;
}

function verificationRouteRecords(verification: SiteVerification): readonly VerificationRouteRecord[] {
  return verification.routes.map((route) => ({
    id: route.id,
    sourceId: route.sourceId,
    route: route.route,
    status: route.status,
    sourceWords: route.sourceWords,
    ...(route.observedWords === undefined ? {} : { observedWords: route.observedWords }),
    ...(route.simhashDistance === undefined ? {} : { simhashDistance: route.simhashDistance }),
    reason: route.reason,
    ...(route.requiredAction === undefined ? {} : { requiredAction: route.requiredAction })
  }));
}

/**
 * The verification artefact carries routes, counts, delivery evidence and
 * fingerprint distances. Neither side of the comparison is stored as text, and
 * the delivery section keeps tool finding codes rather than page metadata.
 */
function createVerificationDocument(verification: SiteVerification): object {
  return {
    schemaVersion: "0.6",
    generator: { name: "wp-migrate-core", version: packageVersion },
    observed: { kind: verification.observed, source: verification.source },
    routes: verificationRouteRecords(verification),
    summary: verification.summary,
    ...(verification.delivery === undefined
      ? {}
      : { delivery: deliveryEvidenceRecord(verification.delivery) }),
    launch: launchRecord(verification.launch)
  };
}

function deliveryEvidenceRecord(evidence: DeliveryEvidence): object {
  return {
    observed: evidence.observed,
    source: evidence.source,
    version: evidence.version,
    generatedAt: evidence.generatedAt,
    summary: evidence.summary,
    routes: evidence.routes.map((route) => ({
      id: route.id,
      sourceId: route.sourceId,
      route: route.route,
      ...(route.targetId === undefined ? {} : { targetId: route.targetId }),
      status: route.status,
      ...(route.httpStatus === undefined ? {} : { httpStatus: route.httpStatus }),
      agents: route.agents,
      indexing: route.indexing,
      ...(route.indexingSources.length === 0 ? {} : { indexingSources: route.indexingSources }),
      ...(route.socialMetadata.length === 0 ? {} : { socialMetadata: route.socialMetadata }),
      findings: route.findings.map((finding) => ({
        code: finding.code,
        severity: finding.severity,
        ...(finding.agent === undefined ? {} : { agent: finding.agent })
      })),
      reason: route.reason,
      ...(route.requiredAction === undefined ? {} : { requiredAction: route.requiredAction })
    })),
    ...(evidence.comparison === undefined
      ? {}
      : { comparison: deliveryComparisonRecord(evidence.comparison) })
  };
}

/**
 * The comparison keeps change codes, fields, agents, finding severities and
 * numeric values. The metadata text SSRWire compared never reaches this file.
 */
function deliveryComparisonRecord(comparison: DeliveryComparison): object {
  return {
    source: comparison.source,
    baselineSource: comparison.baselineSource,
    candidate: comparison.candidate,
    baseline: comparison.baseline,
    summary: comparison.summary,
    unmatched: comparison.unmatched,
    routes: comparison.routes.map((route) => ({
      id: route.id,
      route: route.route,
      status: route.status,
      baselineComplete: route.baselineComplete,
      regressions: route.regressions,
      fixed: route.fixed,
      changed: route.changed,
      changes: route.changes.map((change) => ({
        id: change.id,
        kind: change.kind,
        scope: change.scope,
        code: change.code,
        ...(change.field === undefined ? {} : { field: change.field }),
        ...(change.agents.length === 0 ? {} : { agents: change.agents }),
        ...(change.baselineSeverity === undefined ? {} : { baselineSeverity: change.baselineSeverity }),
        ...(change.candidateSeverity === undefined ? {} : { candidateSeverity: change.candidateSeverity }),
        ...(change.baselineValue === undefined ? {} : { baselineValue: change.baselineValue }),
        ...(change.candidateValue === undefined ? {} : { candidateValue: change.candidateValue }),
        ...(change.baselinePresent === undefined ? {} : { baselinePresent: change.baselinePresent }),
        ...(change.candidatePresent === undefined ? {} : { candidatePresent: change.candidatePresent }),
        message: change.message
      }))
    }))
  };
}

function launchRecord(findings: readonly LaunchFinding[]): object {
  return {
    blockers: findings.filter((finding) => finding.severity === "blocker").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      code: finding.code,
      ...(finding.route === undefined ? {} : { route: finding.route }),
      ...(finding.routes === undefined ? {} : { routes: finding.routes }),
      source: finding.source,
      ...(finding.agent === undefined ? {} : { agent: finding.agent }),
      ...(finding.field === undefined ? {} : { field: finding.field }),
      ...(finding.fields === undefined ? {} : { fields: finding.fields }),
      ...(finding.sourceCode === undefined ? {} : { sourceCode: finding.sourceCode }),
      title: finding.title,
      message: finding.message,
      requiredAction: finding.requiredAction
    }))
  };
}

function verificationThresholdTripped(summary: VerificationSummary, threshold: FailureThreshold): boolean {
  if (threshold === "none") return false;
  const blockers = summary.missingContent + summary.routeMissing + summary.launchBlockers;
  if (threshold === "blocker") return blockers > 0;
  return blockers > 0 || summary.diverged > 0 || summary.launchWarnings > 0;
}

function verificationMarker(status: VerificationStatus): string {
  if (status === "missing-content") return "NO CONTENT";
  if (status === "route-missing") return "NO PAGE";
  if (status === "diverged") return "DIFFERENT";
  return status.toUpperCase();
}

function printVerification(verification: SiteVerification, output: string): void {
  const { summary } = verification;
  const observedLabel = verification.observed === "html-directory" ? "built HTML" : "a RouteLint report";

  console.log(`\nVerification against ${observedLabel}`);
  console.log(`  observed: ${verification.source}`);
  console.log(
    `  ${summary.routes} ${pluralize(summary.routes, "route")} checked: ` +
      `${summary.verified} verified, ${summary.diverged} differ from the export, ` +
      `${summary.missingContent} with no content, ${summary.routeMissing} with no page, ` +
      `${summary.skipped} not judged`
  );
  console.log(
    `  pages without a title: ${summary.withoutTitle}; pages without a heading: ${summary.withoutHeading}`
  );

  const delivery = verification.delivery;
  if (delivery !== undefined) {
    console.log(`\nDelivery evidence from ${delivery.source}`);
    console.log(
      `  ${delivery.summary.covered} of ${summary.routes} ${pluralize(summary.routes, "route")} observed: ` +
        `${delivery.summary.delivered} delivered, ${delivery.summary.failed} answered with an error, ` +
        `${delivery.summary.incomplete} did not complete, ${delivery.summary.unobserved} unobserved`
    );
    console.log(
      `  ${delivery.summary.blockedIndexing} blocking indexing; ` +
        `${delivery.summary.errors} SSRWire ${pluralize(delivery.summary.errors, "error")}, ` +
        `${delivery.summary.warnings} ${pluralize(delivery.summary.warnings, "warning")}` +
        `${delivery.summary.unmatchedTargets === 0
          ? ""
          : `; ${delivery.summary.unmatchedTargets} ${pluralize(delivery.summary.unmatchedTargets, "target")} outside this plan`}`
    );

    const comparison = delivery.comparison;
    if (comparison !== undefined) {
      console.log(
        `  compared with ${comparison.baselineSource}: SSRWire counted ` +
          `${comparison.summary.regressions} ${pluralize(comparison.summary.regressions, "regression")}, ` +
          `${comparison.summary.fixed} fixed and ${comparison.summary.changed} changed; ` +
          "the findings below group them per route"
      );
      if (comparison.summary.unusableBaselines > 0) {
        const count = comparison.summary.unusableBaselines;
        console.log(
          `  ${count} ${pluralize(count, "route")} had no usable source audit, ` +
            `so ${count === 1 ? "its" : "their"} changes are not counted as losses`
        );
      }
    }
  }

  const problems = verification.routes.filter(
    (route) =>
      route.status === "missing-content" || route.status === "route-missing" || route.status === "diverged"
  );

  if (problems.length > 0) {
    console.log("\nVerification queue");
    for (const route of problems) {
      console.log(`  [${verificationMarker(route.status)}] ${route.route}: ${route.reason}`);
    }
  }

  if (verification.launch.length > 0) {
    console.log("\nPublishing findings");
    for (const finding of verification.launch) {
      const marker = finding.severity === "blocker" ? "BLOCKED" : "REVIEW";
      const routes = finding.routes;
      const label = finding.route ??
        (routes === undefined ? "site-wide" : `${routes.length} ${pluralize(routes.length, "route")}`);
      console.log(`  [${marker}] ${label}: ${finding.title} — ${finding.message}`);
    }
  }

  console.log(`\nVerification: ${output}`);
}

function finishVerification(verification: SiteVerification, options: CliOptions, output: string): void {
  const failed = verificationThresholdTripped(verification.summary, options.failOn);
  const document = createVerificationDocument(verification);

  if (options.json) {
    console.log(
      JSON.stringify({ ...document, command: "verify", outputs: { verification: output }, failed }, null, 2)
    );
  } else {
    printVerification(verification, output);
  }

  if (failed) {
    const missing = verification.summary.missingContent + verification.summary.routeMissing;
    const differing = options.failOn === "warning" ? verification.summary.diverged : 0;
    const launchBlockers = verification.summary.launchBlockers;
    const launchWarnings = options.failOn === "warning" ? verification.summary.launchWarnings : 0;
    process.exitCode = 1;
    console.error(
      `wp-migrate-core: --fail-on ${options.failOn} matched ` +
        `${missing} route(s) with missing content or no page` +
        `${differing === 0 ? "" : ` and ${differing} differing route(s)`}` +
        `${launchBlockers === 0 ? "" : ` and ${launchBlockers} publishing blocker(s)`}` +
        `${launchWarnings === 0 ? "" : ` and ${launchWarnings} delivery warning(s)`}. ` +
        "Review the verification queue before publishing."
    );
  }
}

async function inspect(
  project: MigrationProject,
  outputDirectory: string
): Promise<{ readonly plan: string; readonly report: string }> {
  const directory = resolve(outputDirectory);
  await prepareInspectionOutput(directory);
  // A sibling keeps the final rename on the same filesystem.
  const stagingDirectory = await mkdtemp(resolve(dirname(directory), `.${basename(directory)}.staging-`));

  try {
    const stagingPlanPath = resolve(stagingDirectory, "migration-plan.json");
    const stagingReportPath = resolve(stagingDirectory, "report.html");

    await writeNewFile(stagingPlanPath, `${JSON.stringify(createMigrationPlan(project), null, 2)}\n`);
    await writeReport(project, stagingReportPath, { noClobber: true });
    await assertOutputDoesNotExist(directory);
    await rename(stagingDirectory, directory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    plan: resolve(directory, "migration-plan.json"),
    report: resolve(directory, "report.html")
  };
}

async function run(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.help) {
    console.log(usage());
    return;
  }

  if (parsed.version) {
    console.log(packageVersion);
    return;
  }

  const demoFixture =
    parsed.command === "demo"
      ? fileURLToPath(new URL("../../fixtures/demo-wordpress.xml", import.meta.url))
      : undefined;
  const inputPath = parsed.input ?? demoFixture;
  const loaded = await loadRunConfig(parsed, inputPath);
  const options = resolveOptions(parsed, loaded);
  const config = loaded?.config;

  if (options.command === "demo") {
    assertTargetEnabled(options.target);
    const fixture = inputPath as string;
    // The demo also shows the coverage check, unless the caller supplied their own URLs.
    const demoSitemap = fileURLToPath(new URL("../../fixtures/demo-sitemap.xml", import.meta.url));
    const inspected = await loadProject(
      fixture,
      {
        ...options,
        liveUrlPaths: options.liveUrlPaths.length > 0 ? options.liveUrlPaths : [demoSitemap]
      },
      config
    );
    const project = await deliverProjectMedia(inspected, { ...options, ...(await demoMediaOptions(options, config)) }, config);
    const output = resolve(options.output ?? "wp-migrate-core-demo");
    const plan = await inspect(project, resolve(output, "migration-plan"));
    const site = resolve(output, "astro-site");
    const ruleFiles = redirectRuleFiles(project);
    await generateAstroProject(project, site, { rewriteLinks: !options.keepSourceLinks });
    await writeReport(project, resolve(site, "migration", "report.html"));
    finishCommand(project, options, {
      command: "demo",
      outputs: {
        plan: plan.plan,
        report: plan.report,
        site,
        ...((project.media.delivery?.copies.length ?? 0) === 0
          ? {}
          : { mediaCopies: resolve(site, "public", "wp-content", "uploads") }),
        ...(ruleFiles.length === 0 ? {} : { redirectRules: resolve(site, "migration", "redirect-rules") })
      },
      humanLines: [
        `\nPlan: ${plan.plan}`,
        `Report: ${plan.report}`,
        `Astro demo: ${site}`,
        `Media inventory: ${resolve(site, "migration", "media.json")}`,
        `URL and redirect map: ${resolve(site, "migration", "redirects.json")}`,
        `Link inventory: ${resolve(site, "migration", "links.json")}`,
        `Coverage check: ${resolve(site, "migration", "coverage.json")}`,
        ...((project.media.delivery?.copies.length ?? 0) === 0
          ? []
          : [`Media copies: ${resolve(site, "public", "wp-content", "uploads")}`]),
        ...(ruleFiles.length === 0 ? [] : [`Redirect rules: ${resolve(site, "migration", "redirect-rules")}`])
      ]
    });
    return;
  }

  if (!options.input) {
    throw new Error(`${options.command} requires a WordPress WXR file.\n\n${usage()}`);
  }

  const project = await loadProject(options.input, options, config);

  if (options.command === "inspect") {
    assertTargetEnabled(options.target);
    const outputs = await inspect(project, options.output ?? "migration-plan");
    finishCommand(project, options, {
      command: "inspect",
      outputs,
      humanLines: [`\nPlan: ${outputs.plan}`, `Report: ${outputs.report}`]
    });
    return;
  }

  if (options.command === "report") {
    const output = resolve(options.output ?? "migration-report.html");
    await writeReport(project, output, { noClobber: true });
    finishCommand(project, options, {
      command: "report",
      outputs: { report: output },
      humanLines: [`\nReport: ${output}`]
    });
    return;
  }

  if (options.command === "convert") {
    assertTargetEnabled(options.target);
    if (!options.output) throw new Error("convert requires --out <new-site>.");
    const output = resolve(options.output);
    const delivered = await deliverProjectMedia(project, options, config);
    const ruleFiles = redirectRuleFiles(delivered);
    await generateAstroProject(delivered, output, { rewriteLinks: !options.keepSourceLinks });
    await writeReport(delivered, resolve(output, "migration", "report.html"));
    finishCommand(delivered, options, {
      command: "convert",
      outputs: {
        site: output,
        manifest: resolve(output, "migration", "manifest.json"),
        issues: resolve(output, "migration", "issues.json"),
        media: resolve(output, "migration", "media.json"),
        ...((delivered.media.delivery?.copies.length ?? 0) === 0
          ? {}
          : { mediaCopies: resolve(output, "public", "wp-content", "uploads") }),
        redirects: resolve(output, "migration", "redirects.json"),
        links: resolve(output, "migration", "links.json"),
        coverage: resolve(output, "migration", "coverage.json"),
        ...(ruleFiles.length === 0 ? {} : { redirectRules: resolve(output, "migration", "redirect-rules") }),
        report: resolve(output, "migration", "report.html")
      },
      humanLines: [
        `\nGenerated ${targetAvailability[options.target].label} project: ${output}`,
        `Media inventory: ${resolve(output, "migration", "media.json")}`,
        ...((delivered.media.delivery?.copies.length ?? 0) === 0
          ? []
          : [`Media copies: ${resolve(output, "public", "wp-content", "uploads")}`]),
        `URL and redirect map: ${resolve(output, "migration", "redirects.json")}`,
        `Link inventory: ${resolve(output, "migration", "links.json")}`,
        `Coverage check: ${resolve(output, "migration", "coverage.json")}`,
        ...(ruleFiles.length === 0 ? [] : [`Redirect rules: ${resolve(output, "migration", "redirect-rules")}`])
      ]
    });
    return;
  }

  if (options.command === "verify") {
    const verification = await verifySite(project, {
      ...(options.htmlDirectory === undefined ? {} : { htmlDirectory: options.htmlDirectory }),
      ...(options.routelintReport === undefined ? {} : { routelintReportPath: options.routelintReport }),
      ...(options.ssrwireReport === undefined ? {} : { ssrwireReportPath: options.ssrwireReport }),
      ...(options.ssrwireBaseline === undefined ? {} : { ssrwireBaselinePath: options.ssrwireBaseline })
    });
    const output = resolve(options.output ?? "migration-verification.json");
    await writeNewFile(output, `${JSON.stringify(createVerificationDocument(verification), null, 2)}\n`);
    finishVerification(verification, options, output);
    return;
  }

  throw new Error(`Unknown command: ${options.command}.\n\n${usage()}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`wp-migrate-core: ${message}`);
  process.exitCode = 1;
});
