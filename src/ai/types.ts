/**
 * The assist layer's own vocabulary. Nothing here is part of the migration
 * model: a suggestion is a proposal, and a decision is the file a person
 * accepts before the deterministic pipeline can use it.
 */

export type AiJob = "triage" | "alt-text" | "shortcodes" | "routes" | "repair";

export type AiStructuredOutput = "json_schema" | "json_object" | "text";

export interface AiProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly embeddingsModel?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly structuredOutput: AiStructuredOutput;
  readonly maxTokensParameter?: "max_tokens" | "max_completion_tokens";
}

export interface AiJobConfig {
  readonly model?: string;
  readonly embeddingsModel?: string;
  readonly maxItems?: number;
  readonly minScore?: number;
}

export interface AiLimits {
  readonly maxRequests: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface AiPrivacy {
  readonly send: "metadata" | "excerpts" | "content";
  readonly redact: readonly string[];
}

export interface AiCacheConfig {
  readonly enabled: boolean;
  readonly directory: string;
}

export interface AiConfig {
  readonly schemaVersion: "0.1";
  readonly provider: AiProviderConfig;
  readonly jobs: Readonly<Partial<Record<AiJob, AiJobConfig>>>;
  readonly limits: AiLimits;
  readonly privacy: AiPrivacy;
  readonly cache: AiCacheConfig;
}

export interface AiUsage {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiProviderInfo {
  /** The endpoint's host and path, without credentials, query or fragment. */
  readonly endpoint: string;
  readonly model: string;
  readonly embeddingsModel?: string;
}

export interface AiSuggestionBase {
  readonly id: string;
  readonly status: "suggested" | "rejected";
  readonly reason?: string;
}

export interface TriageWorkItem {
  readonly rank: number;
  readonly title: string;
  readonly codes: readonly string[];
  readonly impact: string;
  readonly action: string;
  readonly effort: "small" | "medium" | "large";
  readonly owner: "content" | "developer" | "editor" | "hosting";
  readonly findingCount: number;
  readonly whyFirst: string;
}

export interface TriageResult {
  readonly summary: string;
  readonly workOrder: readonly TriageWorkItem[];
  readonly risks: readonly string[];
  readonly questions: readonly string[];
}

export interface AltTextSuggestion extends AiSuggestionBase {
  readonly kind: "alt-text";
  readonly assetId: string;
  readonly sourceIds: readonly string[];
  readonly value: string;
  readonly decorative: boolean;
  readonly confidence: "high" | "medium" | "low";
}

export type MappingStrategy = "static-fallback" | "component" | "remove" | "keep-blocked";

export interface MappingSuggestion extends AiSuggestionBase {
  readonly kind: "mapping";
  readonly key: string;
  readonly code: string;
  readonly sourceIds: readonly string[];
  readonly strategy: MappingStrategy;
  readonly component?: string;
  readonly fallbackText?: string;
  readonly confidence: "high" | "medium" | "low";
}

export interface RouteCandidate {
  readonly route: string;
  readonly title: string;
  readonly score: number;
}

export interface RouteSuggestion extends AiSuggestionBase {
  readonly kind: "route";
  readonly source: string;
  readonly targetRoute: string;
  readonly score: number;
  readonly confidence: "high" | "medium" | "low";
  readonly alternatives: readonly RouteCandidate[];
}

export interface RepairSuggestion extends AiSuggestionBase {
  readonly kind: "repair";
  readonly sourceId: string;
  readonly issueCodes: readonly string[];
  readonly repairedHtml: string;
  readonly changes: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}

export type AiSuggestion =
  | AltTextSuggestion
  | MappingSuggestion
  | RouteSuggestion
  | RepairSuggestion;

export interface AiSuggestionsDocument {
  readonly schemaVersion: "0.1";
  readonly generator: {
    readonly name: string;
    readonly version: string;
  };
  readonly job: AiJob;
  readonly provider: AiProviderInfo;
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly triage?: TriageResult;
  readonly items: readonly AiSuggestion[];
}

export interface AiRunDocument {
  readonly schemaVersion: "0.1";
  readonly generator: {
    readonly name: string;
    readonly version: string;
  };
  readonly job: AiJob;
  readonly provider: AiProviderInfo;
  readonly promptVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly usage: AiUsage;
  readonly limits: AiLimits;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly errors: readonly string[];
}

export interface ShortcodeDecision {
  readonly action: "static-fallback" | "remove" | "component" | "keep-blocked";
  readonly text?: string;
  readonly component?: string;
  readonly reason?: string;
}

export interface ContentPatchDecision {
  readonly html: string;
  readonly issueCodes: readonly string[];
  readonly reason?: string;
}

/**
 * The file `assist apply` writes and `convert --decisions` reads. It contains
 * only accepted, human-reviewable decisions: never prompts, model output or a
 * key.
 */
export interface DecisionsDocument {
  readonly schemaVersion: "0.1";
  readonly generator?: {
    readonly name: string;
    readonly version: string;
  };
  readonly altText?: Readonly<Record<string, string>>;
  readonly routes?: Readonly<Record<string, string>>;
  readonly shortcodes?: Readonly<Record<string, ShortcodeDecision>>;
  readonly contentPatches?: Readonly<Record<string, ContentPatchDecision>>;
}
