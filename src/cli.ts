#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTargetEnabled, targetAvailability } from "./adapters.js";
import { parseWxr } from "./core.js";
import { generateAstroProject } from "./generate.js";
import { writeReport } from "./report.js";
import type {
  ContentRecord,
  MigrationIssue,
  MigrationNode,
  MigrationProject,
  OutputTarget
} from "./types.js";

interface CliOptions {
  readonly command: string;
  readonly input?: string;
  readonly output?: string;
  readonly target: OutputTarget;
}

function usage(): string {
  return `WP Migrate Core 0.1.1

Usage:
  wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro]
  wp-migrate-core convert <export.xml> --out <new-site> [--target astro]
  wp-migrate-core report <export.xml> [--out migration-report.html]
  wp-migrate-core demo [--out wp-migrate-core-demo]

Targets:
  astro  implemented
  next   planned, not implemented
  nuxt   planned, not implemented

This is a deliberately incomplete demonstration. It does not modify WordPress.`;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const command = argv[0] ?? "help";
  let input: string | undefined;
  let output: string | undefined;
  let target: OutputTarget = "astro";

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") {
      output = argv[index + 1];
      index += 1;
    } else if (value === "--target") {
      const candidate = argv[index + 1];
      if (candidate !== "astro" && candidate !== "next" && candidate !== "nuxt") {
        throw new Error(`Unknown target: ${candidate ?? "missing"}. Use astro, next, or nuxt.`);
      }
      target = candidate;
      index += 1;
    } else if (!value?.startsWith("--") && input === undefined) {
      input = value;
    } else {
      throw new Error(`Unknown argument: ${value ?? "missing"}`);
    }
  }

  return { command, ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), target };
}

async function loadProject(inputPath: string): Promise<MigrationProject> {
  const xml = await readFile(resolve(inputPath), "utf8");
  return parseWxr(xml);
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
    summary: project.summary
  };
}

function createPlanRecord(record: ContentRecord): object {
  const route = sanitizePlanRoute(record.route);

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
  const route = sanitizePlanRoute(issue.route);

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

function sanitizePlanRoute(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    const pathname = value.trim().split(/[?#]/, 1)[0] ?? "";
    return pathname.startsWith("/") ? pathname : undefined;
  }
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

function printSummary(project: MigrationProject): void {
  const { summary } = project;
  console.log(`\n${project.source.title ?? "WordPress export"}`);
  console.log(`  ${summary.records} records`);
  console.log(`  ${summary.nodes} detected content constructs`);
  console.log(`  ${summary.nativeNodes} constructs marked as directly supported`);
  console.log(`  ${summary.manualNodes} constructs need manual handling`);
  console.log(`  ${summary.blockedNodes} blocked constructs`);
  console.log(`  ${summary.blockers} blockers; ${summary.warnings} items need review`);

  if (project.issues.length > 0) {
    console.log("\nRepair queue");
    for (const issue of project.issues) {
      const marker = issue.severity === "blocker" ? "BLOCKED" : issue.severity.toUpperCase();
      console.log(`  [${marker}] ${issue.route ?? "site-wide"}: ${issue.message}`);
    }
  }
}

async function inspect(project: MigrationProject, outputDirectory: string): Promise<void> {
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

  const planPath = resolve(directory, "migration-plan.json");
  const reportPath = resolve(directory, "report.html");
  printSummary(project);
  console.log(`\nPlan: ${planPath}`);
  console.log(`Report: ${reportPath}`);
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    console.log(usage());
    return;
  }

  if (options.command === "demo") {
    assertTargetEnabled(options.target);
    const fixture = fileURLToPath(new URL("../../fixtures/demo-wordpress.xml", import.meta.url));
    const project = await loadProject(fixture);
    const output = resolve(options.output ?? "wp-migrate-core-demo");
    await inspect(project, resolve(output, "migration-plan"));
    await generateAstroProject(project, resolve(output, "astro-site"));
    await writeReport(project, resolve(output, "astro-site", "migration", "report.html"));
    console.log(`Astro demo: ${resolve(output, "astro-site")}`);
    return;
  }

  if (!options.input) {
    throw new Error(`${options.command} requires a WordPress WXR file.\n\n${usage()}`);
  }

  const project = await loadProject(options.input);

  if (options.command === "inspect") {
    assertTargetEnabled(options.target);
    await inspect(project, options.output ?? "migration-plan");
    return;
  }

  if (options.command === "report") {
    const output = resolve(options.output ?? "migration-report.html");
    await writeReport(project, output, { noClobber: true });
    printSummary(project);
    console.log(`\nReport: ${output}`);
    return;
  }

  if (options.command === "convert") {
    assertTargetEnabled(options.target);
    if (!options.output) throw new Error("convert requires --out <new-site>.");
    const output = resolve(options.output);
    await generateAstroProject(project, output);
    await writeReport(project, resolve(output, "migration", "report.html"));
    printSummary(project);
    console.log(`\nGenerated ${targetAvailability[options.target].label} project: ${output}`);
    return;
  }

  throw new Error(`Unknown command: ${options.command}.\n\n${usage()}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`wp-migrate-core: ${message}`);
  process.exitCode = 1;
});
