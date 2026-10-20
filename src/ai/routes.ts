import { embedWithCache, type AiBudget } from "./ask.js";
import type { AiCache } from "./cache.js";
import type { MenuItemRecord, PlanBundle } from "./inputs.js";
import { plainText } from "./json.js";
import type { AiProvider } from "./provider.js";
import type { AiConfig, RouteSuggestion } from "./types.js";

export const routesPromptVersion = "routes/1";

interface CandidateRoute {
  readonly route: string;
  readonly title: string;
  readonly kind: string;
}

interface RouteSource {
  readonly source: string;
  readonly label: string;
}

export interface RoutesOptions {
  readonly bundle: PlanBundle;
  readonly config: AiConfig;
  readonly provider: AiProvider;
  readonly cache: AiCache;
  readonly budget: AiBudget;
  readonly maxItems: number;
  readonly minScore: number;
}

/**
 * Route matching is the one job that uses embeddings instead of prose. The
 * model may only rank routes the plan already has; a score below the threshold
 * produces no suggestion at all.
 */
export async function runRoutes(options: RoutesOptions): Promise<readonly RouteSuggestion[]> {
  if (options.provider.info.embeddingsModel === undefined) {
    throw new Error(
      "Route matching needs an embeddings model. Set provider.embeddingsModel or jobs.routes.embeddingsModel in the AI config."
    );
  }

  const candidates = collectCandidates(options.bundle);
  const sources = collectSources(options.bundle).slice(0, options.maxItems);
  if (candidates.length === 0 || sources.length === 0) return [];

  const sourceTexts = sources.map((source) => routeWords(`${source.label} ${source.source}`));
  const candidateTexts = candidates.map((candidate) =>
    routeWords(`${candidate.title} ${candidate.route} ${candidate.kind}`)
  );
  const vectors = await embedWithCache(options.provider, options.cache, [
    ...sourceTexts,
    ...candidateTexts
  ], options.budget);
  const sourceVectors = vectors.slice(0, sources.length);
  const candidateVectors = vectors.slice(sources.length);

  const suggestions: RouteSuggestion[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index] as RouteSource;
    const sourceVector = sourceVectors[index] as readonly number[];
    const ranked = candidates
      .map((candidate, candidateIndex) => ({
        route: candidate.route,
        title: candidate.title,
        score: cosine(sourceVector, candidateVectors[candidateIndex] as readonly number[])
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (best === undefined || best.score < options.minScore) continue;
    suggestions.push({
      id: `route:${source.source}`,
      kind: "route",
      status: "suggested",
      source: source.source,
      targetRoute: best.route,
      score: round(best.score),
      confidence: best.score >= 0.82 ? "high" : best.score >= 0.68 ? "medium" : "low",
      alternatives: ranked.slice(0, 4).map((candidate) => ({
        route: candidate.route,
        title: candidate.title,
        score: round(candidate.score)
      })),
      reason: `The route ${best.route} is semantically closest to ${source.label || source.source}.`
    });
  }

  return suggestions;
}

function collectCandidates(bundle: PlanBundle): CandidateRoute[] {
  const routes = new Map<string, CandidateRoute>();
  const add = (route: string | undefined, title: string | undefined, kind: string): void => {
    if (route === undefined || !route.startsWith("/") || route.startsWith("//")) return;
    if (routes.has(route)) return;
    routes.set(route, {
      route,
      title: plainText(title ?? route.replace(/[/_-]+/g, " "), 200),
      kind
    });
  };

  for (const record of bundle.plan?.records ?? []) {
    add(record.route, record.title, record.type ?? "content");
  }
  for (const page of bundle.plan?.archives?.pages ?? []) {
    add(page.route, page.title ?? page.subject, page.kind ?? "archive");
  }
  for (const entry of bundle.coverage?.entries ?? []) {
    add(entry.status === "routed" ? entry.path : entry.targetRoute, entry.path, "coverage");
  }
  for (const entry of allRedirectEntries(bundle)) {
    add(entry.targetRoute, entry.sourcePath, "redirect");
  }
  for (const menu of bundle.menus?.trees ?? []) {
    for (const item of flattenMenu(menu.items ?? [])) {
      add(item.targetRoute, item.label, "menu");
    }
  }

  return [...routes.values()];
}

function collectSources(bundle: PlanBundle): RouteSource[] {
  const sources = new Map<string, RouteSource>();
  const add = (source: string | undefined, label: string): void => {
    if (source === undefined || source.trim() === "") return;
    const normalized = source.trim();
    if (sources.has(normalized)) return;
    sources.set(normalized, { source: normalized, label: plainText(label, 200) });
  };

  for (const entry of bundle.coverage?.entries ?? []) {
    if (entry.status !== "uncovered") continue;
    add(entry.path ?? entry.url, entry.path ?? "uncovered URL");
  }
  for (const entry of allRedirectEntries(bundle)) {
    if (entry.status !== "unresolved" && entry.status !== "ambiguous-url") continue;
    add(entry.sourcePath ?? entry.sourceUrl, entry.sourceUrl ?? entry.sourcePath ?? "unresolved URL");
  }
  for (const menu of bundle.menus?.trees ?? []) {
    for (const item of flattenMenu(menu.items ?? [])) {
      if (item.targetRoute !== undefined) continue;
      add(item.url, item.label ?? "menu target");
    }
  }

  return [...sources.values()];
}

function allRedirectEntries(bundle: PlanBundle) {
  const artifact = bundle.redirects ?? bundle.plan?.routes ?? bundle.plan?.redirects;
  return [...(artifact?.urls ?? []), ...(artifact?.entries ?? []), ...(artifact?.redirects ?? [])];
}

function flattenMenu(items: readonly MenuItemRecord[]): MenuItemRecord[] {
  return items.flatMap((item) => [item, ...flattenMenu(item.children ?? [])]);
}

function routeWords(value: string): string {
  return value
    .replace(/\bhttps?:\/\//gi, " ")
    .replace(/[/#?&=_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
