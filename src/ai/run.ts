import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./inputs.js";

import { parseWxr } from "../core.js";
import { AiBudget } from "./ask.js";
import { runAltText, altTextPromptVersion } from "./alt-text.js";
import { AiCache } from "./cache.js";
import {
  generatorRecord,
  renderBrief,
  renderReview,
  renderRunDocument,
  renderSuggestionsDocument,
  writeAiArtifact
} from "./artifacts.js";
import { loadPlanBundle, type PlanBundle } from "./inputs.js";
import { runMappings, mappingsPromptVersion } from "./mappings.js";
import {
  createOpenAICompatibleProvider,
  type ProviderOptions,
  type AiProvider
} from "./provider.js";
import { runRepair, repairPromptVersion } from "./repair.js";
import { runRoutes, routesPromptVersion } from "./routes.js";
import { runTriage, triagePromptVersion } from "./triage.js";
import type {
  AiConfig,
  AiJob,
  AiRunDocument,
  AiSuggestion,
  AiSuggestionsDocument,
  TriageResult
} from "./types.js";

export interface AssistRunOptions {
  readonly planDirectory: string;
  readonly outputDirectory: string;
  readonly job: AiJob;
  readonly config: AiConfig;
  readonly exportPath?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly provider?: AiProvider;
  readonly providerOptions?: ProviderOptions;
  readonly now?: () => Date;
}

export interface AssistRunResult {
  readonly job: AiJob;
  readonly outputDirectory: string;
  readonly run: string;
  readonly suggestions: string;
  readonly review: string;
  readonly brief?: string;
  readonly items: number;
  readonly rejected: number;
  readonly usage: {
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly dryRun: boolean;
  readonly preview?: string;
}

const promptVersions: Readonly<Record<AiJob, string>> = {
  triage: triagePromptVersion,
  "alt-text": altTextPromptVersion,
  shortcodes: mappingsPromptVersion,
  routes: routesPromptVersion,
  repair: repairPromptVersion
};

export async function runAssist(options: AssistRunOptions): Promise<AssistRunResult> {
  const bundle = await loadPlanBundle(options.planDirectory);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const jobConfig = options.config.jobs[options.job];
  const providerConfig = {
    ...options.config.provider,
    model: jobConfig?.model ?? options.config.provider.model,
    ...(jobConfig?.embeddingsModel === undefined
      ? {}
      : { embeddingsModel: jobConfig.embeddingsModel })
  };

  if (options.dryRun === true) {
    return {
      job: options.job,
      outputDirectory: options.outputDirectory,
      run: "",
      suggestions: "",
      review: "",
      items: 0,
      rejected: 0,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      cacheHits: 0,
      cacheMisses: 0,
      dryRun: true,
      preview: preview(bundle, options.job, options.config, providerConfig.model)
    };
  }

  if (options.force !== true) {
    const names = ["run.json", "suggestions.json", "review.html"];
    if (options.job === "triage") names.push("brief.md");
    for (const name of names) {
      const path = join(options.outputDirectory, name);
      if (await pathExists(path)) {
        throw new Error(
          `Refusing to overwrite existing AI output: ${path}. Choose a different --out path, or pass --force.`
        );
      }
    }
  }

  const provider =
    options.provider ??
    createOpenAICompatibleProvider(providerConfig, options.providerOptions);
  const cache = new AiCache(options.config.cache.directory, options.config.cache.enabled);
  const budget = new AiBudget(options.config.limits);
  const maxItems = jobConfig?.maxItems ?? defaultMaxItems[options.job];

  let triage: TriageResult | undefined;
  let items: readonly AiSuggestion[] = [];
  let summary: string;

  if (options.job === "triage") {
    triage = await runTriage({
      bundle,
      config: options.config,
      provider,
      cache,
      budget
    });
    summary = triage.summary;
  } else if (options.job === "alt-text") {
    items = await runAltText({
      bundle,
      config: options.config,
      provider,
      cache,
      budget,
      maxItems
    });
    summary = `${items.filter((item) => item.status === "suggested").length} alternative-text decision${
      items.filter((item) => item.status === "suggested").length === 1 ? "" : "s"
    } proposed for review.`;
  } else if (options.job === "shortcodes") {
    items = await runMappings({
      bundle,
      config: options.config,
      provider,
      cache,
      budget,
      maxItems
    });
    summary = `${items.length} shortcode or widget mapping${items.length === 1 ? "" : "s"} proposed for review.`;
  } else if (options.job === "routes") {
    items = await runRoutes({
      bundle,
      config: options.config,
      provider,
      cache,
      budget,
      maxItems,
      minScore: jobConfig?.minScore ?? 0.55
    });
    summary = `${items.length} route suggestion${items.length === 1 ? "" : "s"} matched against existing plan routes.`;
  } else {
    if (options.exportPath === undefined) {
      throw new Error(
        "Repair reads page bodies, so it needs the export: pass --export <export.xml> with --job repair."
      );
    }
    const exportContents = await readFile(options.exportPath, "utf8");
    const parsed = parseWxr(exportContents);
    items = await runRepair({
      records: parsed.records,
      config: options.config,
      provider,
      cache,
      budget,
      maxItems
    });
    summary = `${items.filter((item) => item.status === "suggested").length} safe content patch${
      items.filter((item) => item.status === "suggested").length === 1 ? "" : "es"
    } proposed for review.`;
  }

  const createdAt = now().toISOString();
  const suggestions: AiSuggestionsDocument = {
    schemaVersion: "0.1",
    generator: generatorRecord(),
    job: options.job,
    provider: provider.info,
    promptVersion: promptVersions[options.job],
    createdAt,
    summary,
    ...(triage === undefined ? {} : { triage }),
    items
  };
  const run: AiRunDocument = {
    schemaVersion: "0.1",
    generator: generatorRecord(),
    job: options.job,
    provider: provider.info,
    promptVersion: promptVersions[options.job],
    startedAt,
    finishedAt: createdAt,
    usage: budget.usage,
    limits: options.config.limits,
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    errors: items
      .filter((item) => item.status === "rejected")
      .map((item) => `${item.id}: ${item.reason ?? "rejected"}`)
  };

  const runPath = await writeAiArtifact(
    options.outputDirectory,
    "run.json",
    renderRunDocument(run)
  );
  const suggestionsPath = await writeAiArtifact(
    options.outputDirectory,
    "suggestions.json",
    renderSuggestionsDocument(suggestions)
  );
  const reviewPath = await writeAiArtifact(
    options.outputDirectory,
    "review.html",
    renderReview(suggestions)
  );
  const briefPath =
    triage === undefined
      ? undefined
      : await writeAiArtifact(
          options.outputDirectory,
          "brief.md",
          renderBrief(bundle.plan?.site?.title ?? "WordPress migration", triage, provider.info)
        );

  return {
    job: options.job,
    outputDirectory: options.outputDirectory,
    run: runPath,
    suggestions: suggestionsPath,
    review: reviewPath,
    ...(briefPath === undefined ? {} : { brief: briefPath }),
    items: items.length,
    rejected: items.filter((item) => item.status === "rejected").length,
    usage: budget.usage,
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    dryRun: false
  };
}

const defaultMaxItems: Readonly<Record<AiJob, number>> = {
  triage: 1,
  "alt-text": 100,
  shortcodes: 40,
  routes: 100,
  repair: 25
};

function preview(
  bundle: PlanBundle,
  job: AiJob,
  config: AiConfig,
  model: string
): string {
  const media = bundle.media;
  const missingAlt = (media?.references ?? []).filter(
    (reference) => reference.status === "missing-alt-text"
  ).length;
  const mappingIssues = bundle.issues.filter((issue) =>
    [
      "SHORTCODE_UNSUPPORTED",
      "ELEMENTOR_WIDGET_UNKNOWN",
      "ELEMENTOR_FORM_UNSUPPORTED",
      "GUTENBERG_DYNAMIC_BLOCK",
      "GUTENBERG_UNKNOWN_BLOCK"
    ].includes(issue.code)
  ).length;
  const uncovered = (bundle.coverage?.entries ?? []).filter((entry) => entry.status === "uncovered").length;
  const repair = bundle.issues.filter((issue) =>
    [
      "GUTENBERG_UNCLOSED_BLOCK",
      "GUTENBERG_UNMATCHED_CLOSE",
      "GUTENBERG_INVALID_ATTRIBUTES",
      "ELEMENTOR_INVALID_DATA"
    ].includes(issue.code)
  ).length;
  const inputs: Record<AiJob, object> = {
    triage: { issues: bundle.issues.length },
    "alt-text": { missingAltReferences: missingAlt },
    shortcodes: { mappingFindings: mappingIssues },
    routes: { uncoveredUrls: uncovered },
    repair: { repairFindings: repair }
  };
  return JSON.stringify(
    {
      job,
      model,
      endpoint: config.provider.baseUrl,
      send: config.privacy.send,
      redact: config.privacy.redact,
      inputs: inputs[job],
      note:
        "Dry run: no request was made and no file was written. The job reads the plan artifacts named in the assist documentation; triage never reads post bodies."
    },
    null,
    2
  );
}

