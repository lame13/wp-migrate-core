import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ImportAction,
  ImportEvidence,
  ImportRecord,
  ImportSummary,
  LaunchFinding,
  MigrationProject
} from "./types.js";

/**
 * A CMS bundle's importer writes a report after it touches the database, and
 * this module reads it. It is the third kind of evidence `verify` can take,
 * alongside a built site and a saved audit: the same run then answers whether
 * the content arrived in the front end *and* whether it arrived in the CMS.
 */

/** The import report format this release reads. It moves independently. */
export const importReportSchemaVersion = "0.9";

const IMPORT_ACTIONS: readonly ImportAction[] = ["created", "updated", "unchanged", "skipped", "failed"];

/**
 * Read an import report a generated importer wrote. Nothing is guessed: a
 * report this release does not understand is an error rather than something
 * quietly half-read, and an entry that does not carry a usable source id or
 * action is dropped rather than counted as a success.
 */
export async function readImportEvidence(path: string): Promise<ImportEvidence> {
  const source = resolve(path);
  let contents: string;
  try {
    contents = await readFile(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the import report ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${path} is not an import report: it must contain a JSON object.`);
  }
  if (parsed.schemaVersion !== importReportSchemaVersion) {
    throw new Error(
      `${path} is an import report for schema ${String(parsed.schemaVersion)}. This release reads schema ${importReportSchemaVersion}.`
    );
  }
  if (!Array.isArray(parsed.records)) {
    throw new Error(`${path} is not an import report: it has no records array.`);
  }

  const records: ImportRecord[] = [];
  for (const entry of parsed.records) {
    if (!isRecord(entry)) continue;
    const sourceId = typeof entry.sourceId === "string" ? entry.sourceId : undefined;
    const action = typeof entry.action === "string" ? entry.action : undefined;
    if (sourceId === undefined || action === undefined || !IMPORT_ACTIONS.includes(action as ImportAction)) {
      continue;
    }
    records.push({
      id: typeof entry.id === "string" ? entry.id : sourceId,
      sourceId,
      collection: typeof entry.collection === "string" ? entry.collection : "unknown",
      ...(typeof entry.postType === "string" ? { postType: entry.postType } : {}),
      ...(typeof entry.route === "string" ? { route: entry.route } : {}),
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      action: action as ImportAction,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      unresolved: Array.isArray(entry.unresolved)
        ? entry.unresolved.filter((value): value is string => typeof value === "string")
        : []
    });
  }

  const generator = isRecord(parsed.generator) ? parsed.generator : undefined;
  const destination = isRecord(parsed.destination) ? parsed.destination : undefined;

  return {
    observed: "import-report",
    source,
    version: generator !== undefined && typeof generator.version === "string" ? generator.version : "unknown",
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    target: destination !== undefined && typeof destination.target === "string" ? destination.target : "unknown",
    records,
    summary: summarizeImport(records, parsed.summary)
  };
}

function summarizeImport(records: readonly ImportRecord[], provided: unknown): ImportSummary {
  const reportedPlanned = isRecord(provided) && typeof provided.planned === "number" ? provided.planned : records.length;
  return {
    planned: reportedPlanned,
    created: records.filter((record) => record.action === "created").length,
    updated: records.filter((record) => record.action === "updated").length,
    unchanged: records.filter((record) => record.action === "unchanged").length,
    skipped: records.filter((record) => record.action === "skipped").length,
    failed: records.filter((record) => record.action === "failed").length,
    unresolved: records.reduce((total, record) => total + record.unresolved.length, 0)
  };
}

/**
 * The publishing findings an import report contributes. A CMS record that the
 * plan expected but the import never mentions is a warning, because a content
 * type the importer skipped is exactly the silent loss this tool exists to
 * catch; a record the importer failed on is a blocker.
 */
export function importLaunchFindings(project: MigrationProject, evidence: ImportEvidence): readonly LaunchFinding[] {
  const findings: LaunchFinding[] = [];
  const importedById = new Map(evidence.records.map((record) => [record.sourceId, record]));

  for (const record of project.records) {
    if (!importedById.has(record.sourceId)) {
      findings.push({
        id: `import-missing:${record.sourceId}`,
        severity: "warning",
        code: "IMPORT_RECORD_MISSING",
        ...(record.route === undefined ? {} : { route: record.route }),
        source: "import-report",
        title: "A planned record is not in the import report",
        message: `${record.sourceId} is in the migration plan but the import report says nothing about it.`,
        requiredAction: "Re-run the importer, and check the collection and drop file it should have read."
      });
    }
  }

  for (const record of evidence.records) {
    if (record.action === "failed") {
      findings.push({
        id: `import-failed:${record.sourceId}`,
        severity: "blocker",
        code: "IMPORT_RECORD_FAILED",
        ...(record.route === undefined ? {} : { route: record.route }),
        source: "import-report",
        title: "The importer could not create a record",
        message: `${record.sourceId} failed to import${record.reason === undefined ? "" : `: ${record.reason}`}.`,
        requiredAction: "Fix the reported error, then run the importer again."
      });
      continue;
    }

    if (record.action === "skipped") {
      findings.push({
        id: `import-skipped:${record.sourceId}`,
        severity: "warning",
        code: "IMPORT_RECORD_SKIPPED",
        ...(record.route === undefined ? {} : { route: record.route }),
        source: "import-report",
        title: "The importer skipped a record that was edited in the CMS",
        message: `${record.sourceId} was left alone${record.reason === undefined ? "" : ` (${record.reason})`}.`,
        requiredAction: "Reconcile the CMS copy with the source by hand, or restore the imported values before re-running."
      });
      continue;
    }

    // Taxonomies, authors and media are expected in a CMS drop but are not
    // content records, so only a content id the plan does not carry is
    // unexpected.
    if (isSupportingRecord(record.sourceId)) continue;
    if (!isPlanned(project, record.sourceId)) {
      findings.push({
        id: `import-unknown:${record.sourceId}`,
        severity: "warning",
        code: "IMPORT_RECORD_UNKNOWN",
        ...(record.route === undefined ? {} : { route: record.route }),
        source: "import-report",
        title: "The import report names a record the plan does not",
        message: `${record.sourceId} was imported but no planned record accounts for it.`,
        requiredAction: "Check whether the export changed since the plan was generated, then re-run the plan."
      });
    }
  }

  return findings;
}

function isPlanned(project: MigrationProject, sourceId: string): boolean {
  return project.records.some((record) => record.sourceId === sourceId);
}

function isSupportingRecord(sourceId: string): boolean {
  return sourceId.startsWith("wp:term:") || sourceId.startsWith("wp:author:") || sourceId.startsWith("media:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
