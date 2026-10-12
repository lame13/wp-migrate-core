import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MIGRATION_ISSUE_CODES } from "./types.js";
import type { FailureThreshold, MigrationConfig, MigrationIssueCode } from "./types.js";

/** The config format this release reads. It moves independently of the package. */
export const migrationConfigSchemaVersion = "0.7";

export const defaultMigrationConfigFileName = "wp-migrate-core.config.json";

/**
 * The settings this release reads, one list per object in the file. The parser
 * validates against these, and `src/contracts.ts` builds the published JSON
 * Schema from them, so editor help cannot offer a setting the parser refuses
 * or miss one it accepts.
 */
export const MIGRATION_CONFIG_KEYS = [
  "schemaVersion",
  "site",
  "includeDrafts",
  "keepSourceLinks",
  "failOn",
  "routes",
  "exclude",
  "ignoreIssues",
  "postTypes",
  "archives",
  "media"
] as const;

export const MIGRATION_CONFIG_SITE_KEYS = ["title", "url"] as const;
export const MIGRATION_CONFIG_MEDIA_KEYS = ["uploadsDir", "baseUrl", "copyUnused"] as const;
export const MIGRATION_CONFIG_POST_TYPE_KEYS = ["include", "exclude"] as const;
export const MIGRATION_CONFIG_ARCHIVE_KEYS = [
  "taxonomies",
  "authors",
  "dates",
  "postsIndex",
  "perPage",
  "feeds",
  "attachmentPages"
] as const;
export const MIGRATION_CONFIG_FAILURE_THRESHOLDS = ["none", "warning", "blocker"] as const;
export const MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES = ["redirect", "ignore"] as const;

export interface LoadedMigrationConfig {
  /** Absolute path of the config file the caller asked for. */
  readonly source: string;
  readonly config: MigrationConfig;
}

/**
 * Read a migration config from disk. Every decision the export cannot make on
 * its own lands here, and the file is read locally: a config never fetches
 * anything, and `uploadsDir` is resolved against the config file, so a config
 * can be committed next to the export it belongs to.
 */
export async function loadMigrationConfig(path: string): Promise<LoadedMigrationConfig> {
  const source = resolve(path);
  let contents: string;
  try {
    contents = await readFile(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the migration config ${path}: ${message}`);
  }

  return { source, config: parseMigrationConfig(contents, { sourcePath: source }) };
}

/**
 * Validate a config that is already in memory, so a library caller can hand
 * one in without writing a file. Unknown keys are errors: a config that
 * silently ignores a typo is worse than one that refuses to run.
 */
export function parseMigrationConfig(
  contents: string,
  options: { readonly sourcePath?: string } = {}
): MigrationConfig {
  const label = options.sourcePath ?? defaultMigrationConfigFileName;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }

  expectKnownKeys(parsed, MIGRATION_CONFIG_KEYS, label);

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== migrationConfigSchemaVersion) {
    throw new Error(
      `${label} asks for config schema ${String(schemaVersion)}. This release reads schema ${migrationConfigSchemaVersion}.`
    );
  }

  const config: {
    schemaVersion?: string;
    site?: { title?: string; url?: string };
    includeDrafts?: boolean;
    keepSourceLinks?: boolean;
    failOn?: FailureThreshold;
    routes?: Record<string, string>;
    exclude?: string[];
    ignoreIssues?: MigrationIssueCode[];
    postTypes?: { include?: string[]; exclude?: string[] };
    archives?: {
      taxonomies?: boolean;
      authors?: boolean;
      dates?: boolean;
      postsIndex?: string;
      perPage?: number;
      feeds?: string[];
      attachmentPages?: "redirect" | "ignore";
    };
    media?: { uploadsDir?: string; baseUrl?: string; copyUnused?: boolean };
  } = {};

  if (schemaVersion !== undefined) {
    config.schemaVersion = migrationConfigSchemaVersion;
  }

  const site = parsed.site;
  if (site !== undefined) {
    const siteLabel = `${label} site`;
    const record = expectRecord(site, siteLabel);
    expectKnownKeys(record, MIGRATION_CONFIG_SITE_KEYS, siteLabel);
    config.site = {
      ...(record.title === undefined ? {} : { title: expectNonEmptyString(record.title, `${siteLabel} title`) }),
      ...(record.url === undefined ? {} : { url: expectHttpUrl(record.url, `${siteLabel} url`) })
    };
  }

  if (parsed.includeDrafts !== undefined) {
    config.includeDrafts = expectBoolean(parsed.includeDrafts, `${label} includeDrafts`);
  }
  if (parsed.keepSourceLinks !== undefined) {
    config.keepSourceLinks = expectBoolean(parsed.keepSourceLinks, `${label} keepSourceLinks`);
  }
  if (parsed.failOn !== undefined) {
    config.failOn = expectThreshold(parsed.failOn, `${label} failOn`);
  }

  if (parsed.routes !== undefined) {
    const routesLabel = `${label} routes`;
    const record = expectRecord(parsed.routes, routesLabel);
    const routes: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key.trim() === "") {
        throw new Error(`${routesLabel} has an empty key. Use a content id, path, or permalink.`);
      }
      const target = expectNonEmptyString(value, `${routesLabel}["${key}"]`);
      if (!target.startsWith("/") || target.startsWith("//")) {
        throw new Error(
          `${routesLabel}["${key}"] must be a site-relative route such as "/about/", not "${target}".`
        );
      }
      routes[key] = target;
    }
    config.routes = routes;
  }

  if (parsed.exclude !== undefined) {
    config.exclude = expectStringList(parsed.exclude, `${label} exclude`);
  }

  if (parsed.ignoreIssues !== undefined) {
    const list = expectStringList(parsed.ignoreIssues, `${label} ignoreIssues`);
    const unknown = list.filter((code) => !MIGRATION_ISSUE_CODES.includes(code as MigrationIssueCode));
    if (unknown.length > 0) {
      throw new Error(
        `${label} ignoreIssues lists ${unknown.map((code) => `"${code}"`).join(", ")}, which this release never reports.`
      );
    }
    config.ignoreIssues = list as MigrationIssueCode[];
  }

  if (parsed.postTypes !== undefined) {
    const typesLabel = `${label} postTypes`;
    const record = expectRecord(parsed.postTypes, typesLabel);
    expectKnownKeys(record, MIGRATION_CONFIG_POST_TYPE_KEYS, typesLabel);
    config.postTypes = {
      ...(record.include === undefined
        ? {}
        : { include: expectStringList(record.include, `${typesLabel} include`) }),
      ...(record.exclude === undefined
        ? {}
        : { exclude: expectStringList(record.exclude, `${typesLabel} exclude`) })
    };
  }

  if (parsed.archives !== undefined) {
    const archivesLabel = `${label} archives`;
    const record = expectRecord(parsed.archives, archivesLabel);
    expectKnownKeys(record, MIGRATION_CONFIG_ARCHIVE_KEYS, archivesLabel);
    config.archives = {
      ...(record.taxonomies === undefined
        ? {}
        : { taxonomies: expectBoolean(record.taxonomies, `${archivesLabel} taxonomies`) }),
      ...(record.authors === undefined
        ? {}
        : { authors: expectBoolean(record.authors, `${archivesLabel} authors`) }),
      ...(record.dates === undefined
        ? {}
        : { dates: expectBoolean(record.dates, `${archivesLabel} dates`) }),
      ...(record.postsIndex === undefined
        ? {}
        : { postsIndex: expectRoute(record.postsIndex, `${archivesLabel} postsIndex`) }),
      ...(record.perPage === undefined
        ? {}
        : { perPage: expectPositiveInteger(record.perPage, `${archivesLabel} perPage`) }),
      ...(record.feeds === undefined
        ? {}
        : {
            feeds: expectStringList(record.feeds, `${archivesLabel} feeds`).map((feed) =>
              expectRoute(feed, `${archivesLabel} feeds[]`)
            )
          }),
      ...(record.attachmentPages === undefined
        ? {}
        : {
            attachmentPages: expectMode(
              record.attachmentPages,
              MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES,
              `${archivesLabel} attachmentPages`
            )
          })
    };
  }

  if (parsed.media !== undefined) {
    const mediaLabel = `${label} media`;
    const record = expectRecord(parsed.media, mediaLabel);
    expectKnownKeys(record, MIGRATION_CONFIG_MEDIA_KEYS, mediaLabel);
    config.media = {
      ...(record.uploadsDir === undefined
        ? {}
        : {
            uploadsDir: resolveAgainstConfig(
              expectNonEmptyString(record.uploadsDir, `${mediaLabel} uploadsDir`),
              options.sourcePath
            )
          }),
      ...(record.baseUrl === undefined
        ? {}
        : { baseUrl: expectHttpUrl(record.baseUrl, `${mediaLabel} baseUrl`) }),
      ...(record.copyUnused === undefined
        ? {}
        : { copyUnused: expectBoolean(record.copyUnused, `${mediaLabel} copyUnused`) })
    };
  }

  return config;
}

/**
 * A relative uploads directory means "next to the config", so a config can be
 * checked in beside the export it describes and still work from any directory.
 */
function resolveAgainstConfig(value: string, sourcePath: string | undefined): string {
  if (sourcePath === undefined) {
    return value;
  }

  return resolve(dirname(sourcePath), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function expectKnownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  label: string
): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} has no setting named ${unknown.map((key) => `"${key}"`).join(", ")}. ` +
        `Known settings are ${known.join(", ")}.`
    );
  }
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be true or false.`);
  }

  return value;
}

function expectThreshold(value: unknown, label: string): FailureThreshold {
  if (typeof value !== "string" || !MIGRATION_CONFIG_FAILURE_THRESHOLDS.includes(value as FailureThreshold)) {
    throw new Error(`${label} must be one of ${MIGRATION_CONFIG_FAILURE_THRESHOLDS.join(", ")}.`);
  }

  return value as FailureThreshold;
}

function expectStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  return value.map((entry, index) => expectNonEmptyString(entry, `${label}[${index}]`));
}

function expectHttpUrl(value: unknown, label: string): string {
  const candidate = expectNonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be an absolute http or https URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be an absolute http or https URL.`);
  }

  // Keep the trailing slash the author wrote, matching how the export's own
  // channel link is reported, and drop any query or fragment a base URL
  // cannot mean.
  return parsed.origin + parsed.pathname;
}

/** A site-relative path, such as a generated route or a feed path. */
function expectRoute(value: unknown, label: string): string {
  const candidate = expectNonEmptyString(value, label);
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    throw new Error(`${label} must be a site-relative path such as "/blog/", not "${candidate}".`);
  }

  return candidate;
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }

  return value;
}

function expectMode<const Mode extends string>(
  value: unknown,
  modes: readonly Mode[],
  label: string
): Mode {
  if (typeof value !== "string" || !modes.includes(value as Mode)) {
    throw new Error(`${label} must be one of ${modes.join(", ")}.`);
  }

  return value as Mode;
}
