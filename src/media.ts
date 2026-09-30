import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { mediaPath, readHtmlAttribute, sanitizeSourceUrl, stripMediaVariants } from "./core.js";
import type {
  ContentRecord,
  MediaAsset,
  MediaAssetDelivery,
  MediaCopy,
  MediaDeliveryEntry,
  MediaDeliveryOptions,
  MediaDeliveryPlan,
  MediaDeliveryStatus,
  MediaDeliverySummary,
  MigrationIssue,
  MigrationIssueCode,
  MigrationMedia,
  MigrationNode,
  MigrationProject
} from "./types.js";

/** Every upload the source serves from its own media library. */
const UPLOADS_PREFIX = "/wp-content/uploads/";

interface MediaCandidate {
  readonly sourcePath: string;
  readonly assetId?: string | undefined;
  /** Absolute source URL, kept only to recognize media this export cannot vouch for. */
  readonly url?: string | undefined;
}

/**
 * Decide what the generated site will do with each referenced upload.
 *
 * The plan is built from local files only. It reads the uploads directory the
 * caller supplied, measures the files it finds, and never requests the URLs it
 * rewrites: a CDN origin named with `baseUrl` is configuration, not a fetch.
 */
export async function planMediaDelivery(
  project: MigrationProject,
  options: MediaDeliveryOptions
): Promise<MediaDeliveryPlan> {
  const uploadsDirectory =
    options.uploadsDirectory === undefined || options.uploadsDirectory.trim() === ""
      ? undefined
      : resolve(options.uploadsDirectory);
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  if (uploadsDirectory === undefined && baseUrl === undefined) {
    throw new Error(
      "Media delivery needs a place for the files to come from: pass an uploads directory or a media base URL."
    );
  }

  const assetsById = new Map(project.media.assets.map((asset) => [asset.id, asset]));
  const candidates = collectMediaCandidates(project, assetsById, options.copyUnusedAssets === true);
  const entries: MediaDeliveryEntry[] = [];
  const copies = new Map<string, MediaCopy>();

  for (const candidate of candidates) {
    const relative = uploadsRelative(candidate.sourcePath);
    const local = await findLocalFile(uploadsDirectory, relative);
    const ordinal = entries.length + 1;

    if (local !== undefined) {
      // A resized variant the uploads directory does not carry is served by
      // the original file it was made from, which is what WordPress does when
      // the size is missing too.
      const outputPath = `${UPLOADS_PREFIX}${local.relativePath}`;
      copies.set(outputPath, {
        localPath: local.localPath,
        outputPath,
        byteSize: local.byteSize
      });
      entries.push({
        id: `media-delivery:${ordinal}`,
        sourcePath: candidate.sourcePath,
        ...(candidate.assetId === undefined ? {} : { assetId: candidate.assetId }),
        status: "copied",
        outputPath,
        byteSize: local.byteSize,
        reason:
          local.relativePath === relative
            ? "The uploads directory carries this file, and the copy is written into the generated site."
            : `The uploads directory carries ${local.relativePath} rather than this variant, so the original file is served here.`
      });
      continue;
    }

    if (baseUrl !== undefined && relative !== undefined) {
      entries.push({
        id: `media-delivery:${ordinal}`,
        sourcePath: candidate.sourcePath,
        ...(candidate.assetId === undefined ? {} : { assetId: candidate.assetId }),
        status: "linked",
        url: `${baseUrl}/${encodeRelativePath(relative)}`,
        reason: "The media base URL serves this file, so the generated markup points there instead of copying it."
      });
      continue;
    }

    if (candidate.assetId === undefined) {
      // Media the export carries no attachment item for is the source site's
      // problem to keep serving, and its URL is left exactly as written.
      entries.push({
        id: `media-delivery:${ordinal}`,
        sourcePath: candidate.sourcePath,
        status: "remote",
        ...(candidate.url === undefined ? {} : { url: candidate.url }),
        reason: "The export carries no attachment item for this file, so its source URL is left as written."
      });
      continue;
    }

    entries.push({
      id: `media-delivery:${ordinal}`,
      sourcePath: candidate.sourcePath,
      assetId: candidate.assetId,
      status: "missing",
      reason: uploadsDirectory === undefined
        ? "The export carries this attachment, and no uploads directory or media base URL was supplied to deliver it."
        : "The export carries this attachment, and the uploads directory does not hold the file."
    });
  }

  return {
    source:
      uploadsDirectory !== undefined ? "uploads-directory" : baseUrl !== undefined ? "base-url" : "none",
    ...(uploadsDirectory === undefined ? {} : { uploadsDirectory }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    entries,
    summary: summarizeDelivery(entries, copies),
    copies: [...copies.values()].sort((left, right) => left.outputPath.localeCompare(right.outputPath))
  };
}

/**
 * Fold a delivery plan back into the project, so the report, the inventories
 * and the generated content all describe the same decision.
 *
 * Nothing here touches the filesystem: the plan already measured the files, and
 * `deliverMedia` does the writing.
 */
export function applyMediaDelivery(project: MigrationProject, plan: MediaDeliveryPlan): MigrationProject {
  const deliveryByPath = new Map(plan.entries.map((entry) => [entry.sourcePath, entry]));
  const assetStatus = rollUpAssetDelivery(project.media.assets, plan);
  const assets = project.media.assets.map((asset) => {
    const delivery = assetStatus.get(asset.id);
    return delivery === undefined ? asset : { ...asset, delivery };
  });

  const media: MigrationMedia = {
    assets,
    references: project.media.references,
    summary: { ...project.media.summary, delivery: plan.summary },
    delivery: plan
  };

  const served = new Set(
    plan.entries.filter((entry) => entry.status === "copied").flatMap((entry) => entry.outputPath ?? [])
  );
  const coverage = {
    ...project.coverage,
    entries: project.coverage.entries.map((entry) => {
      if (entry.shape !== "media-file" || entry.path === undefined || entry.status === "routed") {
        return entry;
      }
      const path = mediaPath(entry.path) ?? entry.path;
      if (served.has(path)) {
        return {
          ...entry,
          status: "routed" as const,
          targetRoute: entry.path,
          reason: "The generated site serves this upload from the media you supplied."
        };
      }
      const planned = deliveryByPath.get(path);
      return planned?.status === "missing"
        ? {
            ...entry,
            reason:
              "This is an upload the export carries, and the media plan could not find a local file for it."
          }
        : entry;
    }),
    summary: { ...project.coverage.summary }
  };
  coverage.summary = summarizeCoverage(coverage.entries, project.coverage.summary);

  const waived = new Set<MigrationIssueCode>(project.config?.decisions.ignoredIssueCodes ?? []);
  const deliveryIssues = createDeliveryIssues(project, plan, waived);
  // Replacing the previous delivery findings keeps a second call idempotent,
  // which matters because nothing here writes anything a caller can diff.
  const issues = [
    ...project.issues.filter((issue) => issue.code !== "MEDIA_NOT_LOCAL"),
    ...deliveryIssues
  ];
  const records = project.records.map((record) => {
    const existing = record.issues.filter((issue) => issue.code !== "MEDIA_NOT_LOCAL");
    const forRecord = deliveryIssues.filter((issue) => issue.sourceId === record.sourceId);
    return forRecord.length === 0 && existing.length === record.issues.length
      ? record
      : { ...record, issues: [...existing, ...forRecord] };
  });

  return {
    ...project,
    records,
    issues,
    media,
    coverage,
    ...(project.config === undefined ? {} : {
      config: {
        ...project.config,
        decisions: {
          ...project.config.decisions,
          ignoredIssues: issues.filter((issue) => issue.ignored === true).length
        }
      }
    }),
    summary: {
      ...project.summary,
      warnings: issues.filter((issue) => issue.severity === "warning" && issue.ignored !== true).length,
      blockers: issues.filter((issue) => issue.severity === "blocker" && issue.ignored !== true).length,
      media: media.summary
    }
  };
}

/**
 * Write the files the plan measured. The output directory is the generated
 * project, and every copy lands inside `public/`, so the uploads keep serving
 * the paths the source site used.
 */
export async function deliverMedia(plan: MediaDeliveryPlan, projectDirectory: string): Promise<void> {
  const publicDirectory = resolve(projectDirectory, "public");

  for (const copy of plan.copies) {
    const destination = resolveWithin(publicDirectory, copy.outputPath);
    if (destination === undefined) {
      throw new Error(`Refusing to write media outside the generated site: ${copy.outputPath}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(copy.localPath, destination);
  }
}

/**
 * The delivery plan as an artifact. The local paths the plan measured stay
 * out: where this machine keeps its uploads directory is not part of the
 * handoff, and neither is the list of files it copied from.
 */
export function mediaDeliveryRecord(plan: MediaDeliveryPlan): Record<string, unknown> {
  return {
    source: plan.source,
    ...(plan.baseUrl === undefined ? {} : { baseUrl: plan.baseUrl }),
    summary: plan.summary,
    entries: plan.entries.map((entry) => ({
      id: entry.id,
      sourcePath: entry.sourcePath,
      ...(entry.assetId === undefined ? {} : { assetId: entry.assetId }),
      status: entry.status,
      ...(entry.outputPath === undefined ? {} : { outputPath: entry.outputPath }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.byteSize === undefined ? {} : { byteSize: entry.byteSize }),
      reason: entry.reason
    }))
  };
}

/**
 * Every path a plan has to decide about, in a stable order: one per referenced
 * upload, plus the un referenced attachments when the caller asked for them.
 */
function collectMediaCandidates(
  project: MigrationProject,
  assetsById: ReadonlyMap<string, MediaAsset>,
  copyUnusedAssets: boolean
): readonly MediaCandidate[] {
  const candidates = new Map<string, MediaCandidate>();

  const offer = (candidate: MediaCandidate): void => {
    const existing = candidates.get(candidate.sourcePath);
    if (existing === undefined || (existing.assetId === undefined && candidate.assetId !== undefined)) {
      candidates.set(candidate.sourcePath, candidate);
    }
  };

  for (const reference of project.media.references) {
    const asset = reference.assetId === undefined ? undefined : assetsById.get(reference.assetId);
    const sourcePath = reference.path ?? assetSourcePath(asset);
    if (sourcePath === undefined) {
      continue;
    }
    offer({
      sourcePath,
      ...(reference.assetId === undefined ? {} : { assetId: reference.assetId }),
      ...(reference.url === undefined ? {} : { url: reference.url })
    });
  }

  // The inventory groups references by attachment, while delivery needs every
  // filename used by img/source tags and responsive image candidates.
  for (const record of project.records) {
    for (const url of mediaUrlsInRecord(record)) {
      const sourcePath = mediaPath(url);
      if (sourcePath === undefined) continue;
      const reference = project.media.references.find((entry) =>
        entry.sourceId === record.sourceId && entry.assetId !== undefined && entry.path !== undefined &&
        stripMediaVariants(entry.path) === stripMediaVariants(sourcePath)
      );
      offer({ sourcePath, assetId: reference?.assetId, url: sanitizeSourceUrl(url) });
    }
  }

  if (copyUnusedAssets) {
    for (const asset of project.media.assets) {
      const sourcePath = assetSourcePath(asset);
      if (sourcePath !== undefined) {
        offer({ sourcePath, assetId: asset.id, ...(asset.url === undefined ? {} : { url: asset.url }) });
      }
    }
  }

  // Uploads the live site already serves are URLs a migration must not drop,
  // so a supplied media library delivers them whether or not the included
  // content still points at them.
  const assetIdByPath = new Map<string, string>();
  for (const asset of project.media.assets) {
    const sourcePath = assetSourcePath(asset);
    if (sourcePath !== undefined && !assetIdByPath.has(sourcePath)) {
      assetIdByPath.set(sourcePath, asset.id);
    }
  }
  for (const entry of project.coverage.entries) {
    if (entry.shape !== "media-file" || entry.path === undefined) {
      continue;
    }
    const sourcePath = mediaPath(entry.path) ?? entry.path;
    const assetId = assetIdByPath.get(sourcePath);
    offer({
      sourcePath,
      ...(assetId === undefined ? {} : { assetId })
    });
  }

  return [...candidates.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

/** Every image URL used by the markup, including responsive candidates. */
function mediaUrlsInRecord(record: ContentRecord): readonly string[] {
  const urls = new Set<string>();
  const scan = (html: string): void => {
    for (const [tag] of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
      const src = readHtmlAttribute(tag, "src");
      if (src !== undefined) urls.add(src);
      const srcset = readHtmlAttribute(tag, "srcset");
      if (srcset !== undefined && !/data:/i.test(srcset)) {
        for (const candidate of srcset.split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) urls.add(url);
        }
      }
    }
  };
  const visit = (node: MigrationNode): void => {
    if (node.rawHtml !== undefined) scan(node.rawHtml);
    if (node.source === "elementor") {
      for (const value of [node.attributes.editor, node.attributes.html]) {
        if (typeof value === "string") scan(value);
      }
    }
    node.children.forEach(visit);
  };
  scan(record.rawContent);
  record.nodes.forEach(visit);
  return [...urls];
}

/** The upload path an attachment record describes, when it describes one. */
function assetSourcePath(asset: MediaAsset | undefined): string | undefined {
  if (asset === undefined) {
    return undefined;
  }

  if (asset.path !== undefined) {
    return asset.path;
  }
  if (asset.file !== undefined && asset.file.trim() !== "") {
    return `${UPLOADS_PREFIX}${normalizeRelative(asset.file)}`;
  }
  return mediaPath(asset.url);
}

/**
 * Find the file for one upload inside the directory the caller supplied. The
 * path comes from the export, so it is treated as untrusted: a segment that
 * climbs out of the directory is not a file this plan will copy.
 */
async function findLocalFile(
  uploadsDirectory: string | undefined,
  relative: string | undefined
): Promise<{ readonly localPath: string; readonly relativePath: string; readonly byteSize: number } | undefined> {
  if (uploadsDirectory === undefined || relative === undefined) {
    return undefined;
  }

  const root = await realpath(uploadsDirectory).catch(() => undefined);
  if (root === undefined) return undefined;

  for (const candidate of [relative, stripMediaVariants(relative)]) {
    if (candidate === "" || candidate.startsWith("../") || candidate.includes("/../")) {
      continue;
    }

    const localPath = resolveWithin(uploadsDirectory, candidate);
    if (localPath === undefined) {
      continue;
    }

    const actualPath = await realpath(localPath).catch(() => undefined);
    if (actualPath === undefined || !actualPath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      continue;
    }
    const details = await statFile(actualPath);
    if (details !== undefined) {
      return { localPath: actualPath, relativePath: normalizeRelative(candidate), byteSize: details };
    }
  }

  return undefined;
}

async function statFile(path: string): Promise<number | undefined> {
  try {
    const details = await stat(path);
    return details.isFile() ? details.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The path an upload carries, relative to the uploads directory. Anything
 * outside the media library, such as a CDN copy or a theme image, has no local
 * counterpart to look for.
 */
function uploadsRelative(sourcePath: string): string | undefined {
  if (!sourcePath.startsWith(UPLOADS_PREFIX)) {
    return undefined;
  }

  const relative = normalizeRelative(sourcePath.slice(UPLOADS_PREFIX.length));
  return relative === "" ? undefined : relative;
}

/**
 * Resolve a relative path inside a root, refusing anything that escapes it.
 * Returns undefined rather than throwing so a caller can report the entry.
 */
function resolveWithin(root: string, relative: string): string | undefined {
  const normalized = normalizeRelative(relative);
  if (normalized === "") {
    return undefined;
  }

  const resolved = resolve(root, normalized);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolved.startsWith(prefix) ? resolved : undefined;
}

/** Normalize separators, refusing paths with parent-directory segments. */
function normalizeRelative(value: string): string {
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.includes("..")
    ? ""
    : segments.filter((segment) => segment !== "" && segment !== ".").join("/");
}

function encodeRelativePath(relative: string): string {
  return relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }

  const sanitized = sanitizeSourceUrl(trimmed);
  if (sanitized === undefined || !/^https?:\/\//i.test(sanitized)) {
    throw new Error("The media base must be an absolute http or https URL.");
  }
  return sanitized.replace(/\/+$/, "");
}

function summarizeDelivery(
  entries: readonly MediaDeliveryEntry[],
  copies: ReadonlyMap<string, MediaCopy>
): MediaDeliverySummary {
  return {
    planned: true,
    files: entries.length,
    copied: countStatus(entries, "copied"),
    linked: countStatus(entries, "linked"),
    remote: countStatus(entries, "remote"),
    missing: countStatus(entries, "missing"),
    bytes: [...copies.values()].reduce((total, copy) => total + copy.byteSize, 0)
  };
}

function countStatus(entries: readonly MediaDeliveryEntry[], status: MediaDeliveryStatus): number {
  return entries.filter((entry) => entry.status === status).length;
}

/**
 * The strongest delivery one attachment reached, across the paths that use it.
 * The attachment's own file wins over a resized variant that resolved to it,
 * so the inventory reports where the file itself went.
 */
function rollUpAssetDelivery(
  assets: readonly MediaAsset[],
  plan: MediaDeliveryPlan
): ReadonlyMap<string, MediaAssetDelivery> {
  const rank: Readonly<Record<MediaDeliveryStatus, number>> = {
    copied: 4,
    linked: 3,
    remote: 2,
    missing: 1
  };
  const rolled = new Map<string, { readonly delivery: MediaAssetDelivery; readonly ownFile: boolean }>();

  for (const asset of assets) {
    const ownPath = assetSourcePath(asset);
    for (const entry of plan.entries) {
      if (entry.assetId !== asset.id) {
        continue;
      }
      const ownFile = ownPath !== undefined && entry.sourcePath === ownPath;
      const existing = rolled.get(asset.id);
      const stronger =
        existing === undefined ||
        rank[entry.status] > rank[existing.delivery.status] ||
        (rank[entry.status] === rank[existing.delivery.status] && ownFile && !existing.ownFile);
      if (!stronger) {
        continue;
      }
      rolled.set(asset.id, {
        delivery: {
          status: entry.status,
          ...(entry.status === "copied" && entry.outputPath !== undefined
            ? { outputPath: entry.outputPath }
            : {})
        },
        ownFile
      });
    }

    if (!rolled.has(asset.id) && asset.referenceCount > 0) {
      rolled.set(asset.id, { delivery: { status: "missing" }, ownFile: false });
    }
  }

  return new Map([...rolled].map(([id, rolledUp]) => [id, rolledUp.delivery]));
}

/**
 * One finding per content record, matching how the media inventory reports
 * missing alt text and unknown attachments: readable on a site with thousands
 * of uploads, with the per-file detail living in the delivery plan.
 */
function createDeliveryIssues(
  project: MigrationProject,
  plan: MediaDeliveryPlan,
  waived: ReadonlySet<MigrationIssueCode>
): MigrationIssue[] {
  const missing = plan.entries.filter((entry) => entry.status === "missing");
  if (missing.length === 0) {
    return [];
  }

  const issues: MigrationIssue[] = [];
  for (const record of project.records) {
    const referencedPaths = new Set(mediaUrlsInRecord(record).flatMap((url) => mediaPath(url) ?? []));
    const referencedAssets = new Set<string>();
    for (const reference of project.media.references) {
      if (reference.sourceId !== record.sourceId) {
        continue;
      }
      if (reference.path !== undefined) {
        referencedPaths.add(reference.path);
      }
      if (reference.path === undefined && reference.assetId !== undefined) {
        referencedAssets.add(reference.assetId);
      }
    }

    const affected = missing.filter(
      (entry) =>
        referencedPaths.has(entry.sourcePath) ||
        (entry.assetId !== undefined && referencedAssets.has(entry.assetId))
    ).length;
    if (affected === 0) {
      continue;
    }

    const message = `${affected} referenced ${affected === 1 ? "media item has" : "media items have"} no local file in the uploads directory.`;
    issues.push({
      id: `${record.sourceId}:MEDIA_NOT_LOCAL:${record.issues.filter((issue) => issue.code !== "MEDIA_NOT_LOCAL").length + issues.length + 1}`,
      severity: "warning",
      code: "MEDIA_NOT_LOCAL",
      sourceId: record.sourceId,
      ...(waived.has("MEDIA_NOT_LOCAL") ? { ignored: true } : {}),
      ...optionalProperty("route", record.route),
      title: message,
      message,
      requiredAction:
        "Copy the file from the source site into the uploads directory, point --media-base at the host that already serves it, or accept the reference as remote."
    });
  }

  return issues;
}

function summarizeCoverage(
  entries: MigrationProject["coverage"]["entries"],
  previous: MigrationProject["coverage"]["summary"]
): MigrationProject["coverage"]["summary"] {
  return {
    ...previous,
    routed: entries.filter((entry) => entry.status === "routed").length,
    redirected: entries.filter((entry) => entry.status === "redirected").length,
    unresolved: entries.filter((entry) => entry.status === "unresolved").length,
    excluded: entries.filter((entry) => entry.status === "excluded-shape").length,
    externalHosts: entries.filter((entry) => entry.status === "external-host").length,
    invalid: entries.filter((entry) => entry.status === "invalid-url").length,
    uncovered: entries.filter((entry) => entry.status === "uncovered").length
  };
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
