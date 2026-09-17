#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTargetEnabled, targetAvailability } from "./adapters.js";
import { parseWxr, sanitizeSourceUrl } from "./core.js";
import { generateAstroProject } from "./generate.js";
import { writeReport } from "./report.js";
import { packageVersion } from "./version.js";
import type {
  ContentRecord,
  MigrationIssue,
  MigrationNode,
  MigrationProject,
  MigrationSummary,
  OutputTarget
} from "./types.js";

type FailureThreshold = "none" | "warning" | "blocker";

interface CliOptions {
  readonly command: string;
  readonly help: boolean;
  readonly version: boolean;
  readonly input?: string;
  readonly output?: string;
  readonly target: OutputTarget;
  readonly includeDrafts: boolean;
  readonly json: boolean;
  readonly failOn: FailureThreshold;
}

function usage(): string {
  return `WP Migrate Core ${packageVersion}

Usage:
  wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro]
  wp-migrate-core convert <export.xml> --out <new-site> [--target astro]
  wp-migrate-core report <export.xml> [--out migration-report.html]
  wp-migrate-core demo [--out wp-migrate-core-demo]

Options:
  --help, -h            show help, including after a command
  --version, -v         show the installed package version
  --include-drafts      also read items that are skipped by default
  --json                print one JSON document instead of the summary
  --fail-on <severity>  fail on warning or blocker; none disables the gate (default)

Targets:
  astro  implemented
  next   planned, not implemented
  nuxt   planned, not implemented

This is a deliberately incomplete demonstration. It does not modify WordPress.

--fail-on never changes what is written; it only sets the exit status so a
caller can gate on the repair queue.`;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const command = argv[0] ?? "help";
  if (!["inspect", "convert", "report", "demo", "help", "--help", "-h", "--version", "-v"].includes(command)) {
    throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }

  let help = command === "help" || command === "--help" || command === "-h";
  let version = command === "--version" || command === "-v";
  let input: string | undefined;
  let output: string | undefined;
  let target: OutputTarget = "astro";
  let includeDrafts = false;
  let json = false;
  let failOn: FailureThreshold = "none";

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      help = true;
    } else if (value === "--version" || value === "-v") {
      version = true;
    } else if (value === "--include-drafts") {
      includeDrafts = true;
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

  return {
    command,
    help,
    version,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    target,
    includeDrafts,
    json,
    failOn
  };
}

function optionValue(option: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

async function loadProject(inputPath: string, options: CliOptions): Promise<MigrationProject> {
  const xml = await readFile(resolve(inputPath), "utf8");
  return parseWxr(xml, { includeDrafts: options.includeDrafts });
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
        referencedBy: asset.referencedBy
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
  console.log(
    `  urls: ${summary.routes.generated} ${pluralize(summary.routes.generated, "route")} generated, ` +
      `${summary.routes.redirects} ${pluralize(summary.routes.redirects, "redirect")} needed, ` +
      `${summary.routes.withoutTarget} ${pluralize(summary.routes.withoutTarget, "source URL")} left without a target`
  );

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
    scan: { includeDrafts: options.includeDrafts },
    source: project.source.title === undefined ? {} : { title: project.source.title },
    summary: project.summary,
    issues: project.issues.map(createPlanIssue),
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
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(packageVersion);
    return;
  }

  if (options.command === "demo") {
    assertTargetEnabled(options.target);
    const fixture = fileURLToPath(new URL("../../fixtures/demo-wordpress.xml", import.meta.url));
    const project = await loadProject(fixture, options);
    const output = resolve(options.output ?? "wp-migrate-core-demo");
    const plan = await inspect(project, resolve(output, "migration-plan"));
    const site = resolve(output, "astro-site");
    await generateAstroProject(project, site);
    await writeReport(project, resolve(site, "migration", "report.html"));
    finishCommand(project, options, {
      command: "demo",
      outputs: { plan: plan.plan, report: plan.report, site },
      humanLines: [
        `\nPlan: ${plan.plan}`,
        `Report: ${plan.report}`,
        `Astro demo: ${site}`,
        `Media inventory: ${resolve(site, "migration", "media.json")}`,
        `URL and redirect map: ${resolve(site, "migration", "redirects.json")}`
      ]
    });
    return;
  }

  if (!options.input) {
    throw new Error(`${options.command} requires a WordPress WXR file.\n\n${usage()}`);
  }

  const project = await loadProject(options.input, options);

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
    await generateAstroProject(project, output);
    await writeReport(project, resolve(output, "migration", "report.html"));
    finishCommand(project, options, {
      command: "convert",
      outputs: {
        site: output,
        manifest: resolve(output, "migration", "manifest.json"),
        issues: resolve(output, "migration", "issues.json"),
        media: resolve(output, "migration", "media.json"),
        redirects: resolve(output, "migration", "redirects.json"),
        report: resolve(output, "migration", "report.html")
      },
      humanLines: [
        `\nGenerated ${targetAvailability[options.target].label} project: ${output}`,
        `Media inventory: ${resolve(output, "migration", "media.json")}`,
        `URL and redirect map: ${resolve(output, "migration", "redirects.json")}`
      ]
    });
    return;
  }

  throw new Error(`Unknown command: ${options.command}.\n\n${usage()}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`wp-migrate-core: ${message}`);
  process.exitCode = 1;
});
