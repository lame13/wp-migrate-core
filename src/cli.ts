#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDecisionsToProject,
  decisionCount,
  decisionsFromSuggestions,
  loadDecisions,
  loadSuggestionsDocument,
  mergeDecisionRoutes,
  type AcceptedDecision
} from "./ai/apply.js";
import { renderDecisionsDocument } from "./ai/artifacts.js";
import { aiConfigJsonSchema, aiConfigFileName, loadAiConfig } from "./ai/config.js";
import { runAssist } from "./ai/run.js";
import { AI_JOBS } from "./ai/config.js";
import type { AiJob } from "./ai/types.js";
import { assertTargetEnabled, generateForTarget, targetAvailability } from "./adapters.js";
import type { DestinationGenerateOptions } from "./adapters.js";
import { defaultMigrationConfigFileName, loadMigrationConfig } from "./config.js";
import type { LoadedMigrationConfig } from "./config.js";
import { artifactSchemaVersions, migrationConfigJsonSchema } from "./contracts.js";
import { linkRewrites, parseWxr, sanitizeLinkHref, sanitizeSourceUrl } from "./core.js";
import { coverageEntryRecords, mergeLiveUrlSources, parseLiveUrlSource } from "./live-urls.js";
import { applyMediaDelivery, mediaDeliveryRecord, planMediaDelivery } from "./media.js";
import { redirectRuleFiles } from "./redirect-rules.js";
import { writeReport } from "./report.js";
import { SUPPORTED_TARGETS, isOutputTarget } from "./targets.js";
import { verifySite } from "./verify.js";
import { packageVersion } from "./version.js";
import type {
  ContentRecord,
  DeliveryComparison,
  DeliveryEvidence,
  FailureThreshold,
  ImportEvidence,
  LaunchFinding,
  LiveUrlSource,
  MenuItem,
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
  readonly assistMode: "run" | "apply";
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
  readonly importReport?: string;
  readonly configPath?: string;
  readonly uploadsDirectory?: string;
  readonly mediaBaseUrl?: string;
  readonly copyUnusedMedia?: boolean;
  readonly publishReady?: boolean;
  readonly json: boolean;
  readonly aiSchema: boolean;
  readonly job?: AiJob;
  readonly aiConfigPath?: string;
  readonly decisionsPath?: string;
  readonly exportPath?: string;
  readonly accept: readonly AcceptedDecision[];
  readonly dryRun: boolean;
  readonly force: boolean;
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
  wp-migrate-core convert <export.xml> --out <new-site> [--target astro|next|payload|pruvious]
  wp-migrate-core convert <export.xml> --out <new-site> --decisions <decisions.json>
  wp-migrate-core convert <export.xml> --out <new-site> --uploads <uploads-dir>
  wp-migrate-core convert <export.xml> --out <new-site> --media-base <https://cdn.example.com/uploads>
  wp-migrate-core report <export.xml> [--out migration-report.html]
  wp-migrate-core verify <export.xml> --html-dir <built-site> [--out migration-verification.json]
  wp-migrate-core verify <export.xml> --routelint-report <report.json>
  wp-migrate-core verify <export.xml> --import-report migration-import.json
  wp-migrate-core verify <export.xml> --html-dir <built-site> --ssrwire-report <audit.json>
  wp-migrate-core verify <export.xml> --html-dir <built-site> --ssrwire-report <audit.json> --ssrwire-baseline <audit.json>
  wp-migrate-core assist <plan-dir> --job <triage|alt-text|shortcodes|routes|repair> [--out <ai-dir>] [--ai-config <file>]
  wp-migrate-core assist <plan-dir> --job repair --export <export.xml> [--ai-config <file>]
  wp-migrate-core assist apply <suggestions.json> [--out <decisions.json>] [--accept alt-text,routes,shortcodes,repair]
  wp-migrate-core demo [--out wp-migrate-core-demo]
  wp-migrate-core schema [--ai] [--out wp-migrate-core.config.schema.json]

Options:
  --help, -h            show help, including after a command
  --version, -v         show the installed package version
  --include-drafts      also read items that are skipped by default
  --keep-source-links   keep exported link targets instead of rewriting them
  --config <file>       read a migration config that decides routes, excludes
                        items and waives reviewed findings; without this option
                        a ${defaultMigrationConfigFileName} next to the export is used
  --uploads <dir>       copy referenced media from a local uploads directory
                        into the generated site; verify uses it to check copies
  --media-base <url>    point generated markup at a media host instead of
                        copying the files (convert, demo and verify)
  --copy-unused-media   also deliver attachments no included content uses
                        (convert, demo and verify)
  --publish-ready       write a site ready to be indexed: canonical URLs, no
                        noindex meta, and a robots.txt that allows crawling
                        (convert and demo). The default handoff stays private.
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
  --import-report <file>
                        read the migration-import.json a generated CMS importer
                        wrote, and check the imported records against the plan
                        (verify). It can stand alone, or join a build check.
  --json                print one JSON document instead of the summary
  --fail-on <severity>  fail on warning or blocker; none disables the gate (default)
  --decisions <file>    apply accepted decisions before inspect, convert, report or verify
  --job <name>          assist job: triage, alt-text, shortcodes, routes or repair
  --ai-config <file>    the AI config; the key is named by environment variable,
                        never stored in this file (default: ${aiConfigFileName})
  --export <file>       the WordPress export repair reads for page bodies
  --accept <list>       assist apply: comma-separated alt-text, routes, shortcodes
                        and repair; default alt-text,routes,shortcodes
  --dry-run             assist: show the destination and inputs; no request or file
  --force               assist: replace an existing AI artifact or decisions file

Targets:
  astro    implemented, static site
  next     implemented, static-site export for Next.js
  payload  implemented, CMS bundle plus a generated importer
  pruvious implemented, a Pruvious bundle for Nuxt plus a generated importer
  nuxt     planned, not implemented (the Pruvious bundle integrates with Nuxt)
  svelte   planned, not implemented (planned after Nuxt)

--help and --version work on their own. Every other command reads local files
only: this tool never modifies WordPress, never fetches a URL, and never talks
to a database. Anything it cannot map cleanly stays a finding with a severity
and a required action rather than an invented page.

schema prints the JSON Schema for ${defaultMigrationConfigFileName}, generated
from the settings this release accepts. Editors can use it for completion and
CI can use it to check a config before a run. Add --ai to print the schema for
${aiConfigFileName} instead.

assist is the one command that talks to the network, and only when you invoke
it. It reads the plan artifacts, sends the smallest useful payload to the
OpenAI-compatible endpoint named in the AI config, and writes suggestions for
review. Triage reads the finding queue, not post bodies. The migration commands
inspect, convert, report and verify remain local and make no network requests.
Accept suggestions with \`assist apply\`; pass the resulting decisions file to
convert or verify with --decisions. The key is read from the environment
variable named by \`provider.apiKeyEnv\`, or from WPMC_AI_API_KEY; it is never
written to an artifact.

--live-urls reads a local file. Save the sitemap yourself; this tool makes no
network requests.

--html-dir, --routelint-report, --ssrwire-report, --ssrwire-baseline and
--import-report read local files only. Build, crawl, audit or import first,
then point the check at the result.

--config and --uploads read local files only. Media is never fetched: files
come from the directory you name, or from the media host you point at.

--fail-on never changes what is written; it only sets the exit status so a
caller can gate on the repair queue. The verification gate covers missing
content, missing pages, a page that still blocks indexing, a route that answered
badly, and any delivery or metadata regression against a baseline audit.`;
}

function parseArguments(argv: readonly string[]): ParsedOptions {
  const command = argv[0] ?? "help";
  const assistMode = command === "assist" && argv[1] === "apply" ? "apply" : "run";
  if (
    !["inspect", "convert", "report", "verify", "demo", "schema", "assist", "help", "--help", "-h", "--version", "-v"].includes(
      command
    )
  ) {
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
  let importReport: string | undefined;
  let configPath: string | undefined;
  let uploadsDirectory: string | undefined;
  let mediaBaseUrl: string | undefined;
  let copyUnusedMedia = false;
  let publishReady = false;
  let json = false;
  let aiSchema = false;
  let job: AiJob | undefined;
  let aiConfigPath: string | undefined;
  let decisionsPath: string | undefined;
  let exportPath: string | undefined;
  const accept: AcceptedDecision[] = [];
  let dryRun = false;
  let force = false;
  let failOn: FailureThreshold | undefined;

  for (let index = assistMode === "apply" ? 2 : 1; index < argv.length; index += 1) {
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
    } else if (value === "--publish-ready") {
      publishReady = true;
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
    } else if (value === "--import-report") {
      importReport = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--ai") {
      aiSchema = true;
    } else if (value === "--job") {
      const candidate = optionValue(value, argv[index + 1]);
      if (!AI_JOBS.includes(candidate as AiJob)) {
        throw new Error(`Unknown assist job: ${candidate}. Use ${AI_JOBS.join(", ")}.`);
      }
      job = candidate as AiJob;
      index += 1;
    } else if (value === "--ai-config") {
      aiConfigPath = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--decisions") {
      decisionsPath = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--export") {
      exportPath = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--accept") {
      const candidate = optionValue(value, argv[index + 1]);
      for (const entry of candidate.split(",")) {
        const trimmed = entry.trim();
        if (
          trimmed !== "alt-text" &&
          trimmed !== "routes" &&
          trimmed !== "shortcodes" &&
          trimmed !== "repair"
        ) {
          throw new Error(
            `Unknown --accept value: ${trimmed}. Use alt-text, routes, shortcodes or repair.`
          );
        }
        if (!accept.includes(trimmed)) accept.push(trimmed);
      }
      index += 1;
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--force") {
      force = true;
    } else if (value === "--out") {
      output = optionValue(value, argv[index + 1]);
      index += 1;
    } else if (value === "--target") {
      const candidate = optionValue(value, argv[index + 1]);
      if (!isOutputTarget(candidate)) {
        throw new Error(`Unknown target: ${candidate}. Use ${SUPPORTED_TARGETS.join(", ")}.`);
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
    if (command !== "convert" && command !== "demo" && command !== "verify" && hasMediaOptions) {
      throw new Error(
        "--uploads, --media-base and --copy-unused-media are only supported by convert, demo and verify."
      );
    }
    if (command !== "convert" && command !== "demo" && publishReady) {
      throw new Error("--publish-ready writes a generated project, so it is only supported by convert and demo.");
    }
    if (
      command !== "verify" &&
      (htmlDirectory !== undefined || routelintReport !== undefined || hasDelivery || importReport !== undefined)
    ) {
      throw new Error(
        "--html-dir, --routelint-report, --ssrwire-report, --ssrwire-baseline and --import-report are only supported by verify."
      );
    }
    if (command === "verify" && htmlDirectory !== undefined && routelintReport !== undefined) {
      throw new Error("Verification reads one content source: pass --html-dir or --routelint-report, not both.");
    }
    if (
      command === "verify" &&
      htmlDirectory === undefined &&
      routelintReport === undefined &&
      importReport === undefined
    ) {
      throw new Error(
        "Verification needs something to check: pass --html-dir, --routelint-report, or --import-report."
      );
    }
    if (ssrwireBaseline !== undefined && ssrwireReport === undefined) {
      throw new Error(
        "--ssrwire-baseline compares two audits. Pass --ssrwire-report for the site you just checked."
      );
    }
    if (command === "assist") {
      if (aiSchema) throw new Error("--ai belongs to schema.");
      if (input === undefined) {
        throw new Error(
          assistMode === "apply"
            ? "assist apply needs a suggestions.json file."
            : "assist needs a plan directory from inspect or convert."
        );
      }
      if (configPath !== undefined) {
        throw new Error("assist reads its own settings with --ai-config, not the migration --config.");
      }
      if (assistMode === "apply") {
        if (job !== undefined || aiConfigPath !== undefined || exportPath !== undefined || dryRun) {
          throw new Error("--job, --ai-config, --export and --dry-run belong to an assist run, not assist apply.");
        }
      } else {
        if (job === undefined) {
          throw new Error(`assist needs --job ${AI_JOBS.join("|")}.`);
        }
        if (accept.length > 0) {
          throw new Error("--accept belongs to assist apply.");
        }
        if (exportPath !== undefined && job !== "repair") {
          throw new Error("--export is only used by --job repair.");
        }
        if (job === "repair" && exportPath === undefined) {
          throw new Error("--job repair reads page bodies; pass --export <export.xml>.");
        }
      }
    } else {
      if (job !== undefined || aiConfigPath !== undefined || exportPath !== undefined || dryRun || force) {
        throw new Error("--job, --ai-config, --export, --dry-run and --force are only supported by assist.");
      }
      if (accept.length > 0) {
        throw new Error("--accept is only supported by assist apply.");
      }
      if (
        decisionsPath !== undefined &&
        command !== "convert" &&
        command !== "verify" &&
        command !== "inspect" &&
        command !== "report"
      ) {
        throw new Error("--decisions is only supported by inspect, convert, report and verify.");
      }
      if (aiSchema && command !== "schema") {
        throw new Error("--ai is only supported by schema.");
      }
    }
  }

  return {
    command,
    assistMode,
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
    ...(importReport === undefined ? {} : { importReport }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(uploadsDirectory === undefined ? {} : { uploadsDirectory }),
    ...(mediaBaseUrl === undefined ? {} : { mediaBaseUrl }),
    ...(copyUnusedMedia ? { copyUnusedMedia } : {}),
    ...(publishReady ? { publishReady } : {}),
    json,
    aiSchema,
    ...(job === undefined ? {} : { job }),
    ...(aiConfigPath === undefined ? {} : { aiConfigPath }),
    ...(decisionsPath === undefined ? {} : { decisionsPath }),
    ...(exportPath === undefined ? {} : { exportPath }),
    accept,
    dryRun,
    force,
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
    types: project.types.map((entry) => ({
      name: entry.name,
      label: entry.label,
      collection: entry.collection,
      sourceItems: entry.sourceItems,
      records: entry.records,
      included: entry.included,
      ...(entry.reason === undefined ? {} : { reason: entry.reason })
    })),
    archives: {
      summary: project.archives.summary,
      pages: project.archives.pages.map((page) => ({
        id: page.id,
        kind: page.kind,
        title: page.title,
        route: page.route,
        subject: page.subject,
        ...(page.sourceUrl === undefined ? {} : { sourceUrl: page.sourceUrl }),
        routeSource: page.routeSource,
        paginated: page.paginated,
        sourceIds: page.sourceIds
      })),
      feeds: project.archives.feeds.map((feed) => ({
        id: feed.id,
        path: feed.path,
        ...(feed.sourcePath === undefined ? {} : { sourcePath: feed.sourcePath }),
        title: feed.title,
        sourceIds: feed.sourceIds
      }))
    },
    menus: {
      summary: project.menus.summary,
      trees: project.menus.trees.map((menu) => ({
        id: menu.id,
        name: menu.name,
        slug: menu.slug,
        items: menu.items.map(planMenuItem)
      }))
    },
    ...(project.config === undefined ? {} : { config: project.config }),
    summary: project.summary
  };
}

function planMenuItem(item: MenuItem): object {
  return {
    id: item.id,
    label: item.label,
    kind: item.kind,
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.targetRoute === undefined ? {} : { targetRoute: item.targetRoute }),
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
    children: item.children.map(planMenuItem)
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

/** The generator options a destination understands, from the CLI flags. */
function generateOptions(options: CliOptions): DestinationGenerateOptions {
  return {
    rewriteLinks: !options.keepSourceLinks,
    ...(options.publishReady === true ? { publishReady: true } : {})
  };
}

/** Where a target writes its output inside a `demo` directory. */
function targetDirectoryName(target: OutputTarget): string {
  if (target === "astro") return "astro-site";
  if (target === "payload") return "payload-bundle";
  if (target === "pruvious") return "pruvious-bundle";
  return `${target}-site`;
}

/** Where a target puts delivered media, for the summary lines. */
function mediaRootPath(target: OutputTarget, directory: string): string {
  if (target === "payload") {
    return resolve(directory, "import", "media", "public", "wp-content", "uploads");
  }
  return resolve(directory, "public", "wp-content", "uploads");
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
  const types = Object.entries(summary.types).sort(([left], [right]) => left.localeCompare(right));
  if (types.length > 2 || types.some(([name]) => name !== "page" && name !== "post")) {
    console.log(`  content types: ${types.map(([name, count]) => `${count} ${name}`).join(", ")}`);
  }
  const archives = summary.archives;
  const listings = archives.taxonomies + archives.authors + archives.dates + archives.postsIndex;
  if (listings > 0 || archives.feeds > 0) {
    console.log(
      `  listings: ${listings} ${pluralize(listings, "archive page")} ` +
        `(${archives.taxonomies} term, ${archives.authors} author, ${archives.dates} date, ${archives.postsIndex} posts index), ` +
        `${archives.fromLiveUrls} from live URLs, ${archives.assumed} built on an assumed base` +
        `${archives.feeds === 0 ? "" : `, ${archives.feeds} ${pluralize(archives.feeds, "feed")}`}`
    );
  }
  if (summary.menus.menus > 0) {
    console.log(
      `  navigation: ${summary.menus.menus} ${pluralize(summary.menus.menus, "menu")}, ` +
        `${summary.menus.items} ${pluralize(summary.menus.items, "entry")}, ` +
        `${summary.menus.unresolved} without a generated target`
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
    schemaVersion: artifactSchemaVersions.verification,
    generator: { name: "wp-migrate-core", version: packageVersion },
    observed: { kind: verification.observed, source: verification.source },
    routes: verificationRouteRecords(verification),
    summary: verification.summary,
    checks: verification.checks.map((check) => ({
      id: check.id,
      label: check.label,
      checked: check.checked,
      ...(check.reason === undefined ? {} : { reason: check.reason })
    })),
    ...(verification.delivery === undefined
      ? {}
      : { delivery: deliveryEvidenceRecord(verification.delivery) }),
    ...(verification.imports === undefined ? {} : { imports: importEvidenceRecord(verification.imports) }),
    launch: launchRecord(verification.launch)
  };
}

/** The import report as the verification artifact stores it. */
function importEvidenceRecord(evidence: ImportEvidence): object {
  return {
    observed: evidence.observed,
    source: evidence.source,
    version: evidence.version,
    generatedAt: evidence.generatedAt,
    target: evidence.target,
    summary: evidence.summary,
    records: evidence.records.map((record) => ({
      id: record.id,
      sourceId: record.sourceId,
      collection: record.collection,
      ...(record.postType === undefined ? {} : { postType: record.postType }),
      ...(record.route === undefined ? {} : { route: record.route }),
      ...(record.title === undefined ? {} : { title: record.title }),
      action: record.action,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.unresolved.length === 0 ? {} : { unresolved: record.unresolved })
    }))
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
  const observedLabel =
    verification.observed === "html-directory"
      ? "built HTML"
      : verification.observed === "routelint-report"
        ? "a RouteLint report"
        : "a CMS import report";

  const imports = verification.imports;
  if (verification.observed === "import-report" && imports !== undefined) {
    console.log(`\nVerification against ${observedLabel}`);
    console.log(`  observed: ${verification.source}`);
    console.log(
      `  ${imports.summary.planned} ${pluralize(imports.summary.planned, "record")} reported by the ${imports.target} importer: ` +
        `${imports.summary.created} created, ${imports.summary.updated} updated, ` +
        `${imports.summary.unchanged} unchanged, ${imports.summary.skipped} skipped, ${imports.summary.failed} failed`
    );
    printVerificationChecks(verification);
    printVerificationLaunch(verification);
    console.log(`\nVerification: ${output}`);
    return;
  }

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

  printVerificationChecks(verification);

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

  if (imports !== undefined) {
    console.log(`\nCMS import evidence from ${imports.source}`);
    console.log(
      `  ${imports.summary.planned} ${pluralize(imports.summary.planned, "record")} reported by the ${imports.target} importer: ` +
        `${imports.summary.created} created, ${imports.summary.updated} updated, ` +
        `${imports.summary.unchanged} unchanged, ${imports.summary.skipped} skipped, ${imports.summary.failed} failed`
    );
  }

  printVerificationLaunch(verification);

  console.log(`\nVerification: ${output}`);
}

function printVerificationChecks(verification: SiteVerification): void {
  const unchecked = verification.checks.filter((check) => !check.checked);
  console.log(
    `\nChecks taken: ${verification.checks.length - unchecked.length} of ${verification.checks.length}` +
      `${unchecked.length === 0 ? "" : `; not checked: ${unchecked.map((check) => check.label).join("; ")}`}`
  );
  for (const check of unchecked) {
    console.log(`  [NOT CHECKED] ${check.label}${check.reason === undefined ? "" : ` — ${check.reason}`}`);
  }
}

function printVerificationLaunch(verification: SiteVerification): void {
  if (verification.launch.length === 0) return;

  console.log("\nPublishing findings");
  for (const finding of verification.launch) {
    const marker = finding.severity === "blocker" ? "BLOCKED" : "REVIEW";
    const routes = finding.routes;
    const label =
      finding.route ?? (routes === undefined ? "site-wide" : `${routes.length} ${pluralize(routes.length, "route")}`);
    console.log(`  [${marker}] ${label}: ${finding.title} — ${finding.message}`);
  }
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

async function resolveAiConfigPath(
  options: ParsedOptions,
  planDirectory: string
): Promise<string> {
  if (options.aiConfigPath !== undefined) return resolve(options.aiConfigPath);
  const besidePlan = join(planDirectory, aiConfigFileName);
  if (await pathExists(besidePlan)) return besidePlan;
  const inWorkingDirectory = resolve(aiConfigFileName);
  if (await pathExists(inWorkingDirectory)) return inWorkingDirectory;
  throw new Error(
    `assist needs an AI config. Pass --ai-config <file>, or put ${aiConfigFileName} beside the plan or in the working directory.`
  );
}

async function runAssistCommand(parsed: ParsedOptions): Promise<void> {
  const planDirectory = resolve(parsed.input as string);
  const configPath = await resolveAiConfigPath(parsed, planDirectory);
  const loaded = await loadAiConfig(configPath);
  const outputDirectory = resolve(parsed.output ?? join(planDirectory, "ai", parsed.job as AiJob));
  const result = await runAssist({
    planDirectory,
    outputDirectory,
    job: parsed.job as AiJob,
    config: loaded.config,
    ...(parsed.exportPath === undefined ? {} : { exportPath: parsed.exportPath }),
    ...(parsed.dryRun ? { dryRun: true } : {}),
    ...(parsed.force ? { force: true } : {})
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.dryRun) {
    console.log(result.preview);
    return;
  }
  console.log(`\nAI ${result.job} suggestions: ${result.suggestions}`);
  console.log(`Review: ${result.review}`);
  console.log(`Run record: ${result.run}`);
  if (result.brief !== undefined) console.log(`Brief: ${result.brief}`);
  console.log(
    `Usage: ${result.usage.requests} request${result.usage.requests === 1 ? "" : "s"}, ` +
      `${result.usage.inputTokens} input tokens, ${result.usage.outputTokens} output tokens` +
      `${result.cacheHits === 0 ? "" : `, ${result.cacheHits} cache hit${result.cacheHits === 1 ? "" : "s"}`}.`
  );
  if (result.rejected > 0) {
    console.log(`${result.rejected} suggestion${result.rejected === 1 ? " was" : "s were"} rejected by validation; see run.json.`);
  }
  console.log(
    `\nNothing has changed yet. Accept what you agree with:\n  wp-migrate-core assist apply ${result.suggestions}`
  );
}

async function applyAssistSuggestions(parsed: ParsedOptions): Promise<void> {
  const suggestionsPath = resolve(parsed.input as string);
  const document = await loadSuggestionsDocument(suggestionsPath);
  const accepted = new Set<AcceptedDecision>(
    parsed.accept.length > 0
      ? parsed.accept
      : (["alt-text", "routes", "shortcodes"] as const)
  );
  const decisions = decisionsFromSuggestions(document, accepted);
  const count = decisionCount(decisions);
  if (count === 0) {
    throw new Error(
      "The accepted suggestions contain no decisions to apply. Check --accept, or review the rejected items in run.json."
    );
  }
  const output = resolve(parsed.output ?? "wp-migrate-core.decisions.json");
  const contents = renderDecisionsDocument(decisions);
  if (parsed.force) {
    await writeFile(output, contents, { encoding: "utf8", mode: 0o600 });
  } else {
    await writeNewFile(output, contents);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ decisions: output, count }, null, 2));
    return;
  }
  console.log(`\nDecisions: ${output}`);
  console.log(
    `${count} accepted decision${count === 1 ? "" : "s"}. Rebuild with:\n` +
      `  wp-migrate-core convert <export.xml> --out <new-site> --decisions ${output}`
  );
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

  if (parsed.command === "schema") {
    // The schema is generated from the parser's own key lists, so it describes
    // exactly the settings this release accepts. Printing it writes nothing;
    // --out writes the file and refuses to replace one that exists.
    const schema = `${JSON.stringify(parsed.aiSchema ? aiConfigJsonSchema : migrationConfigJsonSchema, null, 2)}\n`;
    if (parsed.output === undefined) {
      process.stdout.write(schema);
      return;
    }

    const schemaPath = resolve(parsed.output);
    await writeNewFile(schemaPath, schema);
    console.log(`Schema: ${schemaPath}`);
    return;
  }

  if (parsed.command === "assist") {
    if (parsed.assistMode === "apply") {
      await applyAssistSuggestions(parsed);
    } else {
      await runAssistCommand(parsed);
    }
    return;
  }

  const demoFixture =
    parsed.command === "demo"
      ? fileURLToPath(new URL("../../fixtures/demo-wordpress.xml", import.meta.url))
      : undefined;
  const inputPath = parsed.input ?? demoFixture;
  const loaded = await loadRunConfig(parsed, inputPath);
  const options = resolveOptions(parsed, loaded);
  const decisions =
    parsed.decisionsPath === undefined
      ? undefined
      : (await loadDecisions(parsed.decisionsPath)).decisions;
  const config = mergeDecisionRoutes(loaded?.config, decisions);

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
    const site = resolve(output, targetDirectoryName(options.target));
    const ruleFiles = redirectRuleFiles(project);
    await generateForTarget(options.target, project, site, generateOptions(options));
    await writeReport(project, resolve(site, "migration", "report.html"));
    finishCommand(project, options, {
      command: "demo",
      outputs: {
        plan: plan.plan,
        report: plan.report,
        site,
        ...((project.media.delivery?.copies.length ?? 0) === 0
          ? {}
          : { mediaCopies: mediaRootPath(options.target, site) }),
        ...(ruleFiles.length === 0 ? {} : { redirectRules: resolve(site, "migration", "redirect-rules") })
      },
      humanLines: [
        `\nPlan: ${plan.plan}`,
        `Report: ${plan.report}`,
        `${targetAvailability[options.target].label} demo: ${site}`,
        `Media inventory: ${resolve(site, "migration", "media.json")}`,
        `URL and redirect map: ${resolve(site, "migration", "redirects.json")}`,
        `Link inventory: ${resolve(site, "migration", "links.json")}`,
        `Coverage check: ${resolve(site, "migration", "coverage.json")}`,
        ...((project.media.delivery?.copies.length ?? 0) === 0
          ? []
          : [`Media copies: ${mediaRootPath(options.target, site)}`]),
        ...(ruleFiles.length === 0 ? [] : [`Redirect rules: ${resolve(site, "migration", "redirect-rules")}`])
      ]
    });
    return;
  }

  if (!options.input) {
    throw new Error(`${options.command} requires a WordPress WXR file.\n\n${usage()}`);
  }

  const project = await loadProject(options.input, options, config);
  const decidedProject =
    decisions === undefined ? project : applyDecisionsToProject(project, decisions);

  if (options.command === "inspect") {
    assertTargetEnabled(options.target);
    const outputs = await inspect(decidedProject, options.output ?? "migration-plan");
    finishCommand(decidedProject, options, {
      command: "inspect",
      outputs,
      humanLines: [`\nPlan: ${outputs.plan}`, `Report: ${outputs.report}`]
    });
    return;
  }

  if (options.command === "report") {
    const output = resolve(options.output ?? "migration-report.html");
    await writeReport(decidedProject, output, { noClobber: true });
    finishCommand(decidedProject, options, {
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
    const finalProject =
      decisions === undefined ? delivered : applyDecisionsToProject(delivered, decisions);
    const ruleFiles = redirectRuleFiles(finalProject);
    await generateForTarget(options.target, finalProject, output, generateOptions(options));
    await writeReport(finalProject, resolve(output, "migration", "report.html"));
    finishCommand(finalProject, options, {
      command: "convert",
      outputs: {
        site: output,
        manifest: resolve(output, "migration", "manifest.json"),
        issues: resolve(output, "migration", "issues.json"),
        media: resolve(output, "migration", "media.json"),
        ...((finalProject.media.delivery?.copies.length ?? 0) === 0
          ? {}
          : { mediaCopies: mediaRootPath(options.target, output) }),
        redirects: resolve(output, "migration", "redirects.json"),
        links: resolve(output, "migration", "links.json"),
        coverage: resolve(output, "migration", "coverage.json"),
        ...(ruleFiles.length === 0 ? {} : { redirectRules: resolve(output, "migration", "redirect-rules") }),
        report: resolve(output, "migration", "report.html")
      },
      humanLines: [
        `\nGenerated ${targetAvailability[options.target].label} ${
          targetAvailability[options.target].kind === "cms" ? "bundle" : "project"
        }: ${output}`,
        `Media inventory: ${resolve(output, "migration", "media.json")}`,
        ...((finalProject.media.delivery?.copies.length ?? 0) === 0
          ? []
          : [`Media copies: ${mediaRootPath(options.target, output)}`]),
        `URL and redirect map: ${resolve(output, "migration", "redirects.json")}`,
        `Link inventory: ${resolve(output, "migration", "links.json")}`,
        `Coverage check: ${resolve(output, "migration", "coverage.json")}`,
        ...(ruleFiles.length === 0 ? [] : [`Redirect rules: ${resolve(output, "migration", "redirect-rules")}`])
      ]
    });
    return;
  }

  if (options.command === "verify") {
    const delivered = await deliverProjectMedia(project, options, config);
    const finalProject =
      decisions === undefined ? delivered : applyDecisionsToProject(delivered, decisions);
    const verification = await verifySite(finalProject, {
      ...(options.htmlDirectory === undefined ? {} : { htmlDirectory: options.htmlDirectory }),
      ...(options.routelintReport === undefined ? {} : { routelintReportPath: options.routelintReport }),
      ...(options.ssrwireReport === undefined ? {} : { ssrwireReportPath: options.ssrwireReport }),
      ...(options.ssrwireBaseline === undefined ? {} : { ssrwireBaselinePath: options.ssrwireBaseline }),
      ...(options.importReport === undefined ? {} : { importReportPath: options.importReport })
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
