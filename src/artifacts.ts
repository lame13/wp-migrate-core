import { linkRewrites, sanitizeLinkHref } from "./core.js";
import { coverageEntryRecords } from "./live-urls.js";
import { mediaDeliveryRecord } from "./media.js";
import { renderJson } from "./render.js";
import type {
  MenuItem,
  MigrationIssue,
  MigrationProject,
  OutputTarget
} from "./types.js";
import { packageVersion } from "./version.js";

/**
 * The migration inventories every destination shares: the repair queue, the
 * media inventory, the URL and redirect map, the link map, the live URL
 * coverage check, the archive inventory and the menu tree.
 *
 * A destination is a rendering decision; these files describe the *export*,
 * so an Astro handoff and a Payload bundle write the same shapes. Only the
 * `generator.target` field differs, which is why each renderer takes the
 * target it is being written for.
 */

export const GENERATOR_NAME = "wp-migrate-core";

function generator(target: OutputTarget): { name: string; version: string; target: OutputTarget } {
  return { name: GENERATOR_NAME, version: packageVersion, target };
}

export function renderIssuesArtifact(issues: readonly MigrationIssue[]): string {
  return renderJson(
    issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      sourceId: issue.sourceId,
      ...(issue.route === undefined ? {} : { route: issue.route }),
      ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
      ...(issue.ignored === undefined ? {} : { ignored: issue.ignored }),
      title: issue.title,
      message: issue.message,
      requiredAction: issue.requiredAction
    }))
  );
}

/**
 * The media inventory is an index of what the export already carries. It is
 * not a download, a copy, or a rewrite: every entry still needs a human to
 * import, describe and verify the asset.
 */
export function renderMediaArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.7",
    generator: generator(target),
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
  });
}

/**
 * The redirect list is what makes the handoff auditable against the live site:
 * every source URL is either served at the same path, given a rule, or
 * explicitly left without a target.
 */
export function renderRedirectsArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.2",
    generator: generator(target),
    summary: project.routes.summary,
    redirects: project.routes.redirects.map((redirect) => ({
      id: redirect.id,
      ...(redirect.sourceId === undefined ? {} : { sourceId: redirect.sourceId }),
      sourcePath: redirect.sourcePath,
      targetRoute: redirect.targetRoute,
      reason: redirect.reason
    })),
    urls: project.routes.entries.map((entry) => ({
      id: entry.id,
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      ...(entry.sourceUrl === undefined ? {} : { sourceUrl: entry.sourceUrl }),
      ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
      ...(entry.targetRoute === undefined ? {} : { targetRoute: entry.targetRoute }),
      status: entry.status,
      reason: entry.reason
    }))
  });
}

/**
 * The link inventory is the answer to "what will not work after this move":
 * every same-site link with the route it resolves to, the hrefs the handoff
 * proposes to rewrite, and every target this export cannot vouch for.
 */
export function renderLinksArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.3",
    generator: generator(target),
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
  });
}

/**
 * The coverage inventory is the result of comparing the live URLs the caller
 * supplied with the routes and rules this plan proposes. Nothing was fetched:
 * a URL is compared by path, and `checked: false` means no live URL source was
 * supplied for this run.
 */
export function renderCoverageArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.4",
    generator: generator(target),
    summary: project.coverage.summary,
    entries: coverageEntryRecords(project.coverage)
  });
}

/** The archives this handoff generates, with the subject each one lists. */
export function renderArchivesArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.8",
    generator: generator(target),
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
  });
}

/** The menus WordPress served, so the new theme can rebuild them deliberately. */
export function renderMenusArtifact(project: MigrationProject, target: OutputTarget): string {
  return renderJson({
    schemaVersion: "0.8",
    generator: generator(target),
    summary: project.menus.summary,
    trees: project.menus.trees.map((menu) => ({
      id: menu.id,
      name: menu.name,
      slug: menu.slug,
      items: menu.items.map(menuItemRecord)
    }))
  });
}

export function menuItemRecord(item: MenuItem): object {
  return {
    id: item.id,
    label: item.label,
    kind: item.kind,
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.targetRoute === undefined ? {} : { targetRoute: item.targetRoute }),
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
    children: item.children.map(menuItemRecord)
  };
}
