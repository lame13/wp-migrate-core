import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { MigrationIssue } from "../types.js";

export interface PlanRecord {
  readonly sourceId: string;
  readonly title: string;
  readonly route?: string;
  readonly type?: string;
  readonly editor?: string;
  readonly nodes?: readonly PlanNode[];
  readonly issues?: readonly MigrationIssue[];
}

export interface PlanNode {
  readonly id?: string;
  readonly source?: string;
  readonly sourceType?: string;
  readonly kind?: string;
  readonly conversion?: string;
  readonly children?: readonly PlanNode[];
}

export interface PlanArtifact {
  readonly site?: { readonly title?: string; readonly url?: string };
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly records?: readonly PlanRecord[];
  readonly issues?: readonly MigrationIssue[];
  readonly media?: MediaArtifact;
  readonly coverage?: CoverageArtifact;
  readonly routes?: RedirectArtifact;
  readonly redirects?: RedirectArtifact;
  readonly menus?: MenuArtifact;
  readonly archives?: ArchiveArtifact;
}

export interface MediaArtifact {
  readonly schemaVersion?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly assets?: readonly MediaAssetRecord[];
  readonly references?: readonly MediaReferenceRecord[];
}

export interface MediaAssetRecord {
  readonly id: string;
  readonly wordpressId?: number;
  readonly title?: string;
  readonly path?: string;
  readonly url?: string;
  readonly file?: string;
  readonly mimeType?: string;
  readonly altText?: string;
  readonly width?: number;
  readonly height?: number;
  readonly referenceCount?: number;
  readonly referencedBy?: readonly string[];
}

export interface MediaReferenceRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly route?: string;
  readonly kind?: string;
  readonly path?: string;
  readonly url?: string;
  readonly altText?: string;
  readonly assetId?: string;
  readonly status?: string;
}

export interface CoverageEntry {
  readonly id?: string;
  readonly url?: string;
  readonly path?: string;
  readonly targetRoute?: string;
  readonly status?: string;
  readonly reason?: string;
}

export interface CoverageArtifact {
  readonly schemaVersion?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly entries?: readonly CoverageEntry[];
}

export interface RedirectEntry {
  readonly id?: string;
  readonly sourceId?: string;
  readonly sourcePath?: string;
  readonly sourceUrl?: string;
  readonly targetRoute?: string;
  readonly status?: string;
  readonly reason?: string;
}

export interface RedirectArtifact {
  readonly schemaVersion?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly urls?: readonly RedirectEntry[];
  readonly entries?: readonly RedirectEntry[];
  readonly redirects?: readonly RedirectEntry[];
}

export interface MenuItemRecord {
  readonly label?: string;
  readonly url?: string;
  readonly targetRoute?: string;
  readonly kind?: string;
  readonly reason?: string;
  readonly children?: readonly MenuItemRecord[];
}

export interface MenuArtifact {
  readonly schemaVersion?: string;
  readonly trees?: readonly { readonly items?: readonly MenuItemRecord[] }[];
}

export interface ArchivePageRecord {
  readonly id?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly route?: string;
  readonly subject?: string;
}

export interface ArchiveArtifact {
  readonly schemaVersion?: string;
  readonly pages?: readonly ArchivePageRecord[];
}

export interface PlanBundle {
  readonly directory: string;
  readonly plan?: PlanArtifact;
  readonly issues: readonly MigrationIssue[];
  readonly media?: MediaArtifact;
  readonly coverage?: CoverageArtifact;
  readonly redirects?: RedirectArtifact;
  readonly menus?: MenuArtifact;
}

/**
 * Read the artifacts a plan already wrote. `inspect` puts the queue inside
 * `migration-plan.json`; a generated handoff puts it in `migration/issues.json`
 * (or `issues.json`). Both are accepted, and the export itself is never read
 * by triage.
 */
export async function loadPlanBundle(directoryInput: string): Promise<PlanBundle> {
  const directory = resolve(directoryInput);
  const planPath = join(directory, "migration-plan.json");
  const plan = (await readJsonIfPresent(planPath, "migration-plan.json")) as PlanArtifact | undefined;

  const issues =
    (await readArrayIfPresent<MigrationIssue>([
      join(directory, "issues.json"),
      join(directory, "migration", "issues.json")
    ])) ??
    (Array.isArray(plan?.issues) ? plan.issues : []);

  const media =
    ((await readJsonIfPresent(join(directory, "migration", "media.json"), "migration/media.json")) as
      | MediaArtifact
      | undefined) ??
    ((await readJsonIfPresent(join(directory, "media.json"), "media.json")) as MediaArtifact | undefined) ??
    plan?.media;

  const coverage =
    ((await readJsonIfPresent(join(directory, "migration", "coverage.json"), "migration/coverage.json")) as
      | CoverageArtifact
      | undefined) ??
    ((await readJsonIfPresent(join(directory, "coverage.json"), "coverage.json")) as
      | CoverageArtifact
      | undefined) ??
    plan?.coverage;

  const redirects =
    ((await readJsonIfPresent(join(directory, "migration", "redirects.json"), "migration/redirects.json")) as
      | RedirectArtifact
      | undefined) ??
    ((await readJsonIfPresent(join(directory, "redirects.json"), "redirects.json")) as
      | RedirectArtifact
      | undefined) ??
    plan?.redirects ??
    plan?.routes;

  const menus =
    ((await readJsonIfPresent(join(directory, "migration", "menus.json"), "migration/menus.json")) as
      | MenuArtifact
      | undefined) ??
    ((await readJsonIfPresent(join(directory, "menus.json"), "menus.json")) as MenuArtifact | undefined) ??
    plan?.menus;

  return {
    directory,
    ...(plan === undefined ? {} : { plan }),
    issues,
    ...(media === undefined ? {} : { media }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(redirects === undefined ? {} : { redirects }),
    ...(menus === undefined ? {} : { menus })
  };
}

export async function readJsonIfPresent(path: string, label: string): Promise<unknown> {
  try {
    const contents = await readFile(path, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${label} at ${path}: ${message}`);
  }
}

async function readArrayIfPresent<T>(paths: readonly string[]): Promise<readonly T[] | undefined> {
  for (const path of paths) {
    const value = await readJsonIfPresent(path, path);
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array.`);
    return value as T[];
  }
  return undefined;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function recordsById(plan: PlanArtifact | undefined): ReadonlyMap<string, PlanRecord> {
  return new Map((plan?.records ?? []).map((record) => [record.sourceId, record]));
}

export function allRecordNodes(nodes: readonly PlanNode[] | undefined): readonly PlanNode[] {
  if (nodes === undefined) return [];
  return nodes.flatMap((node) => [node, ...allRecordNodes(node.children)]);
}
