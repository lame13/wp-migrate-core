import { readFile } from "node:fs/promises";

import { hasUnsafeRawMarkup } from "../generate.js";
import { escapeHtml } from "../render.js";
import {
  MIGRATION_ISSUE_CODES,
  type ContentRecord,
  type MediaAsset,
  type MediaReference,
  type MigrationConfig,
  type MigrationIssue,
  type MigrationIssueCode,
  type MigrationNode,
  type MigrationProject,
  type RedirectEntry
} from "../types.js";
import { packageName, packageVersion } from "../version.js";
import { validateRepairHtml } from "./repair.js";
import type {
  AiSuggestion,
  AiSuggestionsDocument,
  ContentPatchDecision,
  DecisionsDocument,
  ShortcodeDecision
} from "./types.js";

export interface LoadedDecisions {
  readonly source: string;
  readonly decisions: DecisionsDocument;
}

export type AcceptedDecision = "alt-text" | "routes" | "shortcodes" | "repair";

export async function loadDecisions(path: string): Promise<LoadedDecisions> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the decisions file ${path}: ${message}`);
  }
  return { source: path, decisions: parseDecisions(contents, { sourcePath: path }) };
}

export async function loadSuggestionsDocument(path: string): Promise<AiSuggestionsDocument> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the suggestions file ${path}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== "0.1") {
    throw new Error(`${path} is not an AI suggestions document at schema 0.1.`);
  }
  if (
    parsed.job !== "triage" &&
    parsed.job !== "alt-text" &&
    parsed.job !== "shortcodes" &&
    parsed.job !== "routes" &&
    parsed.job !== "repair"
  ) {
    throw new Error(`${path} names an unknown assist job.`);
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error(`${path} has no suggestions array.`);
  }
  for (const [index, entry] of parsed.items.entries()) {
    validateSuggestionItem(entry, `${path} items[${index}]`);
  }
  return parsed as unknown as AiSuggestionsDocument;
}

function validateSuggestionItem(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.status !== "suggested" && value.status !== "rejected") {
    throw new Error(`${label}.status is not recognized.`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`${label}.id must be a non-empty string.`);
  }
  if (value.kind === "alt-text") {
    if (
      typeof value.assetId !== "string" ||
      typeof value.value !== "string" ||
      typeof value.decorative !== "boolean" ||
      value.value.length > 500
    ) {
      throw new Error(`${label} is not a valid alt-text suggestion.`);
    }
  } else if (value.kind === "mapping") {
    if (
      typeof value.key !== "string" ||
      !/^(?:shortcode|elementor-widget|elementor-element|gutenberg-block):[A-Za-z0-9_./-]+$/.test(
        value.key
      ) ||
      (value.strategy !== "static-fallback" &&
        value.strategy !== "component" &&
        value.strategy !== "remove" &&
        value.strategy !== "keep-blocked")
    ) {
      throw new Error(`${label} is not a valid mapping suggestion.`);
    }
  } else if (value.kind === "route") {
    if (
      typeof value.source !== "string" ||
      typeof value.targetRoute !== "string" ||
      !value.targetRoute.startsWith("/") ||
      value.targetRoute.startsWith("//") ||
      typeof value.score !== "number"
    ) {
      throw new Error(`${label} is not a valid route suggestion.`);
    }
  } else if (value.kind === "repair") {
    if (
      typeof value.sourceId !== "string" ||
      typeof value.repairedHtml !== "string" ||
      value.repairedHtml.length > 50_000 ||
      !Array.isArray(value.issueCodes) ||
      value.issueCodes.some((code) => typeof code !== "string")
    ) {
      throw new Error(`${label} is not a valid repair suggestion.`);
    }
  } else {
    throw new Error(`${label}.kind is not recognized.`);
  }
}

export function parseDecisions(
  contents: string,
  options: { readonly sourcePath?: string } = {}
): DecisionsDocument {
  const label = options.sourcePath ?? "wp-migrate-core.decisions.json";
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object.`);
  const known = ["schemaVersion", "generator", "altText", "routes", "shortcodes", "contentPatches"];
  const unknown = Object.keys(parsed).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown settings: ${unknown.join(", ")}.`);
  }
  if (parsed.schemaVersion !== "0.1") {
    throw new Error(`${label} asks for decisions schema ${String(parsed.schemaVersion)}. This release reads 0.1.`);
  }

  const altText =
    parsed.altText === undefined ? undefined : parseStringMap(parsed.altText, `${label} altText`, 500);
  const routes =
    parsed.routes === undefined ? undefined : parseRoutes(parsed.routes, `${label} routes`);
  const shortcodes =
    parsed.shortcodes === undefined
      ? undefined
      : parseShortcodes(parsed.shortcodes, `${label} shortcodes`);
  const contentPatches =
    parsed.contentPatches === undefined
      ? undefined
      : parseContentPatches(parsed.contentPatches, `${label} contentPatches`);

  return {
    schemaVersion: "0.1",
    ...(isRecord(parsed.generator) ? { generator: parseGenerator(parsed.generator, label) } : {}),
    ...(altText === undefined ? {} : { altText }),
    ...(routes === undefined ? {} : { routes }),
    ...(shortcodes === undefined ? {} : { shortcodes }),
    ...(contentPatches === undefined ? {} : { contentPatches })
  };
}

export function decisionsFromSuggestions(
  document: AiSuggestionsDocument,
  accepted: ReadonlySet<AcceptedDecision>
): DecisionsDocument {
  const altText: Record<string, string> = {};
  const routes: Record<string, string> = {};
  const shortcodes: Record<string, ShortcodeDecision> = {};
  const contentPatches: Record<string, ContentPatchDecision> = {};

  for (const item of document.items) {
    if (item.status !== "suggested") continue;
    if (item.kind === "alt-text" && accepted.has("alt-text")) {
      altText[item.assetId] = item.value;
    } else if (item.kind === "route" && accepted.has("routes")) {
      routes[item.source] = item.targetRoute;
    } else if (item.kind === "mapping" && accepted.has("shortcodes")) {
      shortcodes[item.key] = {
        action: item.strategy,
        ...(item.fallbackText === undefined ? {} : { text: item.fallbackText }),
        ...(item.component === undefined ? {} : { component: item.component }),
        ...(item.reason === undefined ? {} : { reason: item.reason })
      };
    } else if (item.kind === "repair" && accepted.has("repair")) {
      contentPatches[item.sourceId] = {
        html: item.repairedHtml,
        issueCodes: item.issueCodes,
        ...(item.reason === undefined ? {} : { reason: item.reason })
      };
    }
  }

  return {
    schemaVersion: "0.1",
    generator: { name: packageName, version: packageVersion },
    ...(Object.keys(altText).length === 0 ? {} : { altText }),
    ...(Object.keys(routes).length === 0 ? {} : { routes }),
    ...(Object.keys(shortcodes).length === 0 ? {} : { shortcodes }),
    ...(Object.keys(contentPatches).length === 0 ? {} : { contentPatches })
  };
}

/**
 * Merge accepted route decisions into the migration config before parsing.
 * The config wins on a key it already decides: a suggestion must not silently
 * replace a choice a person wrote by hand.
 */
export function mergeDecisionRoutes(
  config: MigrationConfig | undefined,
  decisions: DecisionsDocument | undefined
): MigrationConfig | undefined {
  if (decisions?.routes === undefined || Object.keys(decisions.routes).length === 0) {
    return config;
  }
  return {
    ...(config ?? {}),
    routes: { ...decisions.routes, ...(config?.routes ?? {}) }
  };
}

/**
 * Apply decisions to a parsed project without changing the export. This is
 * where an accepted suggestion becomes real output: alt text lands on the
 * media records, shortcode fallbacks replace the shortcode text, and repaired
 * content replaces the record's body.
 */
export function applyDecisionsToProject(
  project: MigrationProject,
  decisions: DecisionsDocument
): MigrationProject {
  const altText = decisions.altText ?? {};
  const shortcodes = decisions.shortcodes ?? {};
  const patches = decisions.contentPatches ?? {};
  const changedAssets = new Set(Object.keys(altText));
  if (
    changedAssets.size === 0 &&
    Object.keys(shortcodes).length === 0 &&
    Object.keys(patches).length === 0 &&
    Object.keys(decisions.routes ?? {}).length === 0
  ) {
    return project;
  }
  const base = applyDecisionRoutesToProject(project, decisions);

  const assets = base.media.assets.map((asset) =>
    changedAssets.has(asset.id) && altText[asset.id] !== undefined && !asset.altText?.trim()
      ? { ...asset, altText: altText[asset.id] as string }
      : asset
  );
  let changedReferences = 0;
  const references = base.media.references.map((reference) => {
    const key = reference.assetId ?? reference.id;
    const value = altText[key];
    if (value === undefined || reference.status !== "missing-alt-text") return reference;
    changedReferences += reference.status === "missing-alt-text" ? 1 : 0;
    return {
      ...reference,
      altText: value,
      ...(reference.status === "missing-alt-text" ? { status: "matched" as const } : {})
    };
  });

  const records = base.records.map((record) =>
    applyRecordDecisions(record, shortcodes, patches, references)
  );
  const media = {
    ...base.media,
    assets,
    references,
    summary: {
      ...project.media.summary,
      matched: base.media.summary.matched + changedReferences,
      missingAltText: Math.max(0, base.media.summary.missingAltText - changedReferences)
    }
  };

  const recordIds = new Set(records.map((record) => record.sourceId));
  const siteIssues = base.issues.filter((issue) => !recordIds.has(issue.sourceId));
  const issues = [...records.flatMap((record) => record.issues), ...siteIssues];
  const warnings = issues.filter((issue) => issue.severity === "warning" && issue.ignored !== true).length;
  const blockers = issues.filter((issue) => issue.severity === "blocker" && issue.ignored !== true).length;

  return {
    ...base,
    records,
    issues,
    media,
    summary: {
      ...base.summary,
      warnings,
      blockers,
      media: media.summary
    }
  };
}

/**
 * Route suggestions can target a live URL the export does not contain. Those
 * become explicit redirect rules; a config route would only match an exported
 * item. Config-matched routes have already been merged before parsing.
 */
function applyDecisionRoutesToProject(
  project: MigrationProject,
  decisions: DecisionsDocument
): MigrationProject {
  const routes = decisions.routes ?? {};
  if (Object.keys(routes).length === 0) return project;

  const redirects: RedirectEntry[] = [...project.routes.redirects];
  const existingPaths = new Set(redirects.map((redirect) => redirect.sourcePath));
  const keys = Object.keys(routes);
  for (let index = 0; index < keys.length; index += 1) {
    const source = keys[index] as string;
    const target = routes[source] as string;
    const sourcePath = decisionSourcePath(source);
    if (
      sourcePath === undefined ||
      sourcePath.startsWith("//") ||
      sourcePath === target ||
      existingPaths.has(sourcePath)
    ) {
      continue;
    }
    existingPaths.add(sourcePath);
    redirects.push({
      id: `decision:route:${index + 1}`,
      sourcePath,
      targetRoute: target,
      reason: "Accepted AI route decision; publish this rule on the host."
    });
  }

  let coverageChanged = false;
  const coverageEntries = project.coverage.entries.map((entry) => {
    if (entry.status !== "uncovered") return entry;
    const target = (entry.url === undefined ? undefined : routes[entry.url]) ??
      (entry.path === undefined ? undefined : routes[entry.path]);
    if (target === undefined) return entry;
    coverageChanged = true;
    return {
      ...entry,
      targetRoute: target,
      status: "redirected" as const,
      reason: "An accepted AI route decision covers this live URL."
    };
  });

  let menuChanged = 0;
  const trees = project.menus.trees.map((menu) => {
    const updated = updateMenuItems(menu.items, routes);
    menuChanged += updated.changed;
    return updated.changed === 0 ? menu : { ...menu, items: updated.items };
  });

  const decisionKeys = new Set(keys);
  const issues = project.issues.filter((issue) => {
    if (issue.code !== "CONFIG_ENTRY_UNMATCHED") return true;
    return ![...decisionKeys].some((key) => issue.message.includes(`"${key}"`));
  });

  const routesSummary = {
    ...project.routes.summary,
    redirects: project.routes.summary.redirects + (redirects.length - project.routes.redirects.length)
  };
  const coverageSummary = coverageChanged
    ? {
        ...project.coverage.summary,
        redirected: coverageEntries.filter((entry) => entry.status === "redirected").length,
        uncovered: coverageEntries.filter((entry) => entry.status === "uncovered").length
      }
    : project.coverage.summary;
  const menusSummary = menuChanged === 0
    ? project.menus.summary
    : {
        ...project.menus.summary,
        unresolved: Math.max(0, project.menus.summary.unresolved - menuChanged)
      };

  return {
    ...project,
    routes: { ...project.routes, redirects, summary: routesSummary },
    coverage: { ...project.coverage, entries: coverageEntries, summary: coverageSummary },
    menus: { ...project.menus, trees, summary: menusSummary },
    issues,
    summary: {
      ...project.summary,
      routes: routesSummary,
      menus: menusSummary
    }
  };
}

function updateMenuItems(
  items: MigrationProject["menus"]["trees"][number]["items"],
  routes: Readonly<Record<string, string>>
): { readonly items: MigrationProject["menus"]["trees"][number]["items"]; readonly changed: number } {
  let changed = 0;
  const updated = items.map((item) => {
    const children = updateMenuItems(item.children, routes);
    changed += children.changed;
    let next = item;
    if (item.targetRoute === undefined && item.url !== undefined) {
      const path = decisionSourcePath(item.url);
      const target = routes[item.url] ?? (path === undefined ? undefined : routes[path]);
      if (target !== undefined) {
        next = { ...item, targetRoute: target, href: target };
        changed += 1;
      }
    }
    if (children.changed > 0) {
      next = { ...next, children: children.items };
    }
    return next;
  });
  return { items: updated, changed };
}

function decisionSourcePath(source: string): string | undefined {
  if (source.startsWith("/")) return source;
  try {
    const url = new URL(source);
    return url.pathname;
  } catch {
    return undefined;
  }
}

function applyRecordDecisions(
  record: ContentRecord,
  shortcodes: Readonly<Record<string, ShortcodeDecision>>,
  patches: Readonly<Record<string, ContentPatchDecision>>,
  references: readonly MediaReference[]
): ContentRecord {
  let rawContent = record.rawContent;
  let nodes = record.nodes;
  let issues = [...record.issues];
  let changed = false;

  const patch = patches[record.sourceId];
  if (patch !== undefined) {
    const codes = patch.issueCodes.filter((code): code is MigrationIssueCode =>
      MIGRATION_ISSUE_CODES.includes(code as MigrationIssueCode)
    );
    const originalCodes = new Set(record.issues.map((issue) => issue.code));
    const unknown = codes.filter((code) => !originalCodes.has(code));
    if (unknown.length > 0) {
      throw new Error(
        `The content patch for ${record.sourceId} names findings this record does not have: ${unknown.join(", ")}.`
      );
    }
    validateRepairHtml(
      patch.html,
      new Set([...originalCodes, ...codes]),
      codes,
      record.rawContent
    );
    rawContent = patch.html;
    issues = issues.filter((issue) => !patch.issueCodes.includes(issue.code));
    changed = true;
  }

  for (const [key, decision] of Object.entries(shortcodes)) {
    if (decision.action !== "static-fallback" && decision.action !== "remove") continue;
    const name = key.startsWith("shortcode:") ? key.slice("shortcode:".length) : undefined;
    if (name !== undefined) {
      const replaced = replaceShortcode(rawContent, name, decision);
      if (replaced.changed) {
        rawContent = replaced.html;
        issues = issues.filter(
          (issue) =>
            !(
              issue.code === "SHORTCODE_UNSUPPORTED" &&
              issue.title.toLowerCase().includes(`[${name.toLowerCase()}]`)
            )
        );
        changed = true;
      }
    }
  }

  // Elementor widgets are nodes rather than shortcode text. A static fallback
  // or removal can be applied safely by giving that node its own raw HTML;
  // component mappings stay a proposal for the destination code.
  const nodeDecision = applyNodeMappings(nodes, shortcodes);
  if (nodeDecision.changed) {
    nodes = nodeDecision.nodes;
    issues = issues.filter((issue) => {
      if (issue.code !== "ELEMENTOR_WIDGET_UNKNOWN" && issue.code !== "ELEMENTOR_FORM_UNSUPPORTED") {
        return true;
      }
      const widget = /Elementor widget ([A-Za-z0-9_/-]+)/i.exec(issue.title)?.[1];
      const element = /Unknown Elementor element type ([A-Za-z0-9_/-]+)/i.exec(issue.title)?.[1];
      const key = widget === undefined ? (element === undefined ? undefined : `elementor-element:${element}`) : `elementor-widget:${widget}`;
      const action = key === undefined ? undefined : shortcodes[key]?.action;
      return action !== "static-fallback" && action !== "remove";
    });
    changed = true;
  }

  const recordReferences = references.filter((reference) => reference.sourceId === record.sourceId);
  const missingAlt = recordReferences.filter((reference) => reference.status === "missing-alt-text").length;
  const withoutAltIssue = issues.filter((issue) => issue.code !== "MEDIA_MISSING_ALT_TEXT");
  if (missingAlt > 0) {
    withoutAltIssue.push(mediaAltIssue(record, missingAlt));
  } else if (withoutAltIssue.length !== issues.length) {
    changed = true;
  }
  issues = withoutAltIssue;

  return changed ? { ...record, rawContent, nodes, issues } : record;
}

function applyNodeMappings(
  nodes: readonly MigrationNode[],
  shortcodes: Readonly<Record<string, ShortcodeDecision>>
): { readonly nodes: readonly MigrationNode[]; readonly changed: boolean } {
  let changed = false;
  const mapped = nodes.map((node) => {
    const keys =
      node.source === "elementor"
        ? [`elementor-widget:${node.sourceType}`, `elementor-element:${node.sourceType}`]
        : [];
    const decision = keys.map((key) => shortcodes[key]).find((entry) => entry !== undefined);
    const children = applyNodeMappings(node.children, shortcodes);
    if (decision !== undefined && (decision.action === "static-fallback" || decision.action === "remove")) {
      changed = true;
      return {
        ...node,
        children: children.nodes,
        conversion: "legacy-html" as const,
        rawHtml: decision.action === "remove" ? "<!-- removed by a reviewed mapping -->" : fallbackMarker(decision.text ?? "")
      };
    }
    if (children.changed) {
      changed = true;
      return { ...node, children: children.nodes };
    }
    return node;
  });
  return { nodes: mapped, changed };
}

function replaceShortcode(
  content: string,
  name: string,
  decision: ShortcodeDecision
): { readonly html: string; readonly changed: boolean } {
  const escaped = escapeRegExp(name);
  const replacement = decision.action === "remove" ? "" : fallbackMarker(decision.text ?? "");
  let changed = false;
  let result = content.replace(
    new RegExp(`\\[${escaped}(?:\\s[^\\]]*)?\\][\\s\\S]*?\\[/${escaped}\\]`, "gi"),
    () => {
      changed = true;
      return replacement;
    }
  );
  result = result.replace(new RegExp(`\\[${escaped}(?:\\s[^\\]]*)?\\]`, "gi"), () => {
    changed = true;
    return replacement;
  });
  return { html: result, changed };
}

function fallbackMarker(text: string): string {
  return `<aside class="content-review"><strong>Content review required</strong><span>${escapeHtml(text)}</span></aside>`;
}

function mediaAltIssue(record: ContentRecord, count: number): MigrationIssue {
  const message = `${count} referenced media ${count === 1 ? "item has" : "items have"} no alternative text.`;
  return {
    id: `${record.sourceId}:MEDIA_MISSING_ALT_TEXT:${record.issues.length + 1}`,
    severity: "warning",
    code: "MEDIA_MISSING_ALT_TEXT",
    sourceId: record.sourceId,
    ...(record.route === undefined ? {} : { route: record.route }),
    title: message,
    message,
    requiredAction: "Write alternative text for each referenced media item; the media inventory in this handoff lists them."
  };
}

function parseGenerator(value: unknown, label: string): { readonly name: string; readonly version: string } {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error(`${label} generator must carry a name and version.`);
  }
  return { name: value.name, version: value.version };
}

function parseStringMap(value: unknown, label: string, maximum: number): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === "") throw new Error(`${label} has an empty key.`);
    if (typeof entry !== "string" || entry.length > maximum) {
      throw new Error(`${label}.${key} must be a string of at most ${maximum} characters.`);
    }
    result[key] = entry;
  }
  return result;
}

function parseRoutes(value: unknown, label: string): Record<string, string> {
  const routes = parseStringMap(value, label, 2_000);
  for (const [key, route] of Object.entries(routes)) {
    if (!route.startsWith("/") || route.startsWith("//")) {
      throw new Error(`${label}.${key} must be a site-relative route such as "/about/".`);
    }
  }
  return routes;
}

function parseShortcodes(
  value: unknown,
  label: string
): Record<string, ShortcodeDecision> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const result: Record<string, ShortcodeDecision> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^(?:shortcode|elementor-widget|elementor-element|gutenberg-block):[A-Za-z0-9_./-]+$/.test(key)) {
      throw new Error(`${label} has an invalid mapping key ${JSON.stringify(key)}.`);
    }
    if (!isRecord(entry)) throw new Error(`${label}.${key} must be an object.`);
    const action = entry.action;
    if (action !== "static-fallback" && action !== "remove" && action !== "component" && action !== "keep-blocked") {
      throw new Error(`${label}.${key}.action is not a recognized mapping action.`);
    }
    const text = entry.text === undefined ? undefined : parseOptionalText(entry.text, `${label}.${key}.text`, 500);
    const component =
      entry.component === undefined
        ? undefined
        : parseOptionalText(entry.component, `${label}.${key}.component`, 120);
    if (component !== undefined && !/^[A-Za-z][A-Za-z0-9_./-]*$/.test(component)) {
      throw new Error(`${label}.${key}.component is not a valid component name.`);
    }
    if (action === "static-fallback" && (text === undefined || text === "")) {
      throw new Error(`${label}.${key} needs text for a static fallback.`);
    }
    if (action === "component" && component === undefined) {
      throw new Error(`${label}.${key} needs a component name.`);
    }
    result[key] = {
      action,
      ...(text === undefined ? {} : { text }),
      ...(component === undefined ? {} : { component }),
      ...(entry.reason === undefined
        ? {}
        : { reason: parseOptionalText(entry.reason, `${label}.${key}.reason`, 500) })
    };
  }
  return result;
}

function parseContentPatches(
  value: unknown,
  label: string
): Record<string, ContentPatchDecision> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const result: Record<string, ContentPatchDecision> = {};
  for (const [sourceId, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.html !== "string" || entry.html.trim() === "") {
      throw new Error(`${label}.${sourceId} needs repaired html.`);
    }
    if (entry.html.length > 50_000 || hasUnsafeRawMarkup(entry.html)) {
      throw new Error(`${label}.${sourceId} contains content the handoff refuses to render.`);
    }
    const codes = Array.isArray(entry.issueCodes)
      ? entry.issueCodes.filter((code): code is string => typeof code === "string")
      : [];
    if (codes.length === 0 || codes.some((code) => !MIGRATION_ISSUE_CODES.includes(code as never))) {
      throw new Error(`${label}.${sourceId}.issueCodes must name the findings the patch resolves.`);
    }
    result[sourceId] = {
      html: entry.html,
      issueCodes: codes,
      ...(entry.reason === undefined
        ? {}
        : { reason: parseOptionalText(entry.reason, `${label}.${sourceId}.reason`, 500) })
    };
  }
  return result;
}

function parseOptionalText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} must be a string of at most ${maximum} characters.`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Small helper for the CLI summary: how many decisions a file carries. */
export function decisionCount(decisions: DecisionsDocument): number {
  return (
    Object.keys(decisions.altText ?? {}).length +
    Object.keys(decisions.routes ?? {}).length +
    Object.keys(decisions.shortcodes ?? {}).length +
    Object.keys(decisions.contentPatches ?? {}).length
  );
}

export type { AiSuggestion };
