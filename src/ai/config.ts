import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  AiCacheConfig,
  AiConfig,
  AiJob,
  AiJobConfig,
  AiLimits,
  AiPrivacy,
  AiProviderConfig,
  AiStructuredOutput
} from "./types.js";

/** The AI config format this release reads. It moves independently of the package. */
export const aiConfigSchemaVersion = "0.1";

export const aiConfigFileName = "wp-migrate-core.ai.json";

export const AI_CONFIG_KEYS = [
  "schemaVersion",
  "provider",
  "jobs",
  "limits",
  "privacy",
  "cache"
] as const;

export const AI_PROVIDER_KEYS = [
  "baseUrl",
  "model",
  "apiKeyEnv",
  "embeddingsModel",
  "headers",
  "timeoutMs",
  "maxRetries",
  "structuredOutput",
  "maxTokensParameter"
] as const;

export const AI_JOB_KEYS = ["model", "embeddingsModel", "maxItems", "minScore"] as const;
export const AI_LIMIT_KEYS = ["maxRequests", "maxInputTokens", "maxOutputTokens"] as const;
export const AI_PRIVACY_KEYS = ["send", "redact"] as const;
export const AI_CACHE_KEYS = ["enabled", "directory"] as const;
export const AI_JOBS: readonly AiJob[] = ["triage", "alt-text", "shortcodes", "routes", "repair"];
export const AI_REDACTION_RULES = ["email", "phone", "url-query"] as const;

export interface LoadedAiConfig {
  readonly source: string;
  readonly config: AiConfig;
}

/**
 * Read the AI config from disk. The key itself never belongs in this file:
 * `apiKeyEnv` names the environment variable the provider reads at request
 * time, so a committed config cannot carry a secret.
 */
export async function loadAiConfig(path: string): Promise<LoadedAiConfig> {
  const source = resolve(path);
  let contents: string;
  try {
    contents = await readFile(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the AI config ${path}: ${message}`);
  }

  return { source, config: parseAiConfig(contents, { sourcePath: source }) };
}

export function parseAiConfig(
  contents: string,
  options: { readonly sourcePath?: string } = {}
): AiConfig {
  const label = options.sourcePath ?? aiConfigFileName;
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
  expectKnownKeys(parsed, AI_CONFIG_KEYS, label);

  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== aiConfigSchemaVersion) {
    throw new Error(
      `${label} asks for AI config schema ${String(parsed.schemaVersion)}. This release reads schema ${aiConfigSchemaVersion}.`
    );
  }

  const providerRecord = expectRecord(parsed.provider, `${label} provider`);
  expectKnownKeys(providerRecord, AI_PROVIDER_KEYS, `${label} provider`);
  const baseUrl = expectHttpBaseUrl(providerRecord.baseUrl, `${label} provider baseUrl`);
  const model = expectNonEmptyString(providerRecord.model, `${label} provider model`);
  const apiKeyEnv =
    providerRecord.apiKeyEnv === undefined
      ? undefined
      : expectEnvironmentName(providerRecord.apiKeyEnv, `${label} provider apiKeyEnv`);
  const embeddingsModel =
    providerRecord.embeddingsModel === undefined
      ? undefined
      : expectNonEmptyString(providerRecord.embeddingsModel, `${label} provider embeddingsModel`);
  const headers =
    providerRecord.headers === undefined
      ? undefined
      : parseHeaders(providerRecord.headers, `${label} provider headers`);
  const timeoutMs =
    providerRecord.timeoutMs === undefined
      ? 60_000
      : expectIntegerInRange(providerRecord.timeoutMs, `${label} provider timeoutMs`, 1_000, 600_000);
  const maxRetries =
    providerRecord.maxRetries === undefined
      ? 2
      : expectIntegerInRange(providerRecord.maxRetries, `${label} provider maxRetries`, 0, 5);
  const structuredOutput =
    providerRecord.structuredOutput === undefined
      ? "json_schema"
      : expectStructuredOutput(providerRecord.structuredOutput, `${label} provider structuredOutput`);
  const maxTokensParameter =
    providerRecord.maxTokensParameter === undefined
      ? undefined
      : expectTokenParameter(providerRecord.maxTokensParameter, `${label} provider maxTokensParameter`);

  const provider: AiProviderConfig = {
    baseUrl,
    model,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(embeddingsModel === undefined ? {} : { embeddingsModel }),
    ...(headers === undefined ? {} : { headers }),
    timeoutMs,
    maxRetries,
    structuredOutput,
    ...(maxTokensParameter === undefined ? {} : { maxTokensParameter })
  };

  const jobs = parseJobs(parsed.jobs, label);
  const limits = parseLimits(parsed.limits, label);
  const privacy = parsePrivacy(parsed.privacy, label);
  const cache = parseCache(parsed.cache, label, options.sourcePath);

  return {
    schemaVersion: aiConfigSchemaVersion,
    provider,
    jobs,
    limits,
    privacy,
    cache
  };
}

function parseJobs(value: unknown, label: string): Readonly<Partial<Record<AiJob, AiJobConfig>>> {
  if (value === undefined) return {};
  const record = expectRecord(value, `${label} jobs`);
  expectKnownKeys(record, AI_JOBS, `${label} jobs`);

  const jobs: Partial<Record<AiJob, AiJobConfig>> = {};
  for (const job of AI_JOBS) {
    const jobValue = record[job];
    if (jobValue === undefined) continue;
    const jobLabel = `${label} jobs.${job}`;
    const jobRecord = expectRecord(jobValue, jobLabel);
    expectKnownKeys(jobRecord, AI_JOB_KEYS, jobLabel);
    jobs[job] = {
      ...(jobRecord.model === undefined
        ? {}
        : { model: expectNonEmptyString(jobRecord.model, `${jobLabel} model`) }),
      ...(jobRecord.embeddingsModel === undefined
        ? {}
        : {
            embeddingsModel: expectNonEmptyString(
              jobRecord.embeddingsModel,
              `${jobLabel} embeddingsModel`
            )
          }),
      ...(jobRecord.maxItems === undefined
        ? {}
        : { maxItems: expectIntegerInRange(jobRecord.maxItems, `${jobLabel} maxItems`, 1, 5_000) }),
      ...(jobRecord.minScore === undefined
        ? {}
        : { minScore: expectNumberInRange(jobRecord.minScore, `${jobLabel} minScore`, 0, 1) })
    };
  }

  return jobs;
}

function parseLimits(value: unknown, label: string): AiLimits {
  if (value === undefined) {
    return { maxRequests: 200, maxInputTokens: 300_000, maxOutputTokens: 100_000 };
  }
  const record = expectRecord(value, `${label} limits`);
  expectKnownKeys(record, AI_LIMIT_KEYS, `${label} limits`);
  return {
    maxRequests:
      record.maxRequests === undefined
        ? 200
        : expectIntegerInRange(record.maxRequests, `${label} limits.maxRequests`, 1, 100_000),
    maxInputTokens:
      record.maxInputTokens === undefined
        ? 300_000
        : expectIntegerInRange(record.maxInputTokens, `${label} limits.maxInputTokens`, 1, 100_000_000),
    maxOutputTokens:
      record.maxOutputTokens === undefined
        ? 100_000
        : expectIntegerInRange(
            record.maxOutputTokens,
            `${label} limits.maxOutputTokens`,
            1,
            10_000_000
          )
  };
}

function parsePrivacy(value: unknown, label: string): AiPrivacy {
  if (value === undefined) {
    return { send: "metadata", redact: [...AI_REDACTION_RULES] };
  }
  const record = expectRecord(value, `${label} privacy`);
  expectKnownKeys(record, AI_PRIVACY_KEYS, `${label} privacy`);
  const send =
    record.send === undefined
      ? "metadata"
      : record.send === "metadata" || record.send === "excerpts" || record.send === "content"
        ? record.send
        : (() => {
            throw new Error(
              `${label} privacy.send must be "metadata", "excerpts", or "content", not ${JSON.stringify(record.send)}.`
            );
          })();
  const redact =
    record.redact === undefined
      ? [...AI_REDACTION_RULES]
      : expectRedactionRules(record.redact, `${label} privacy.redact`);
  return { send, redact };
}

function parseCache(
  value: unknown,
  label: string,
  sourcePath: string | undefined
): AiCacheConfig {
  const record = value === undefined ? {} : expectRecord(value, `${label} cache`);
  expectKnownKeys(record, AI_CACHE_KEYS, `${label} cache`);
  const enabled = record.enabled === undefined ? true : expectBoolean(record.enabled, `${label} cache.enabled`);
  const directory =
    record.directory === undefined
      ? ".wp-migrate-core/ai-cache"
      : expectNonEmptyString(record.directory, `${label} cache.directory`);
  return {
    enabled,
    directory: resolve(sourcePath === undefined ? process.cwd() : dirname(sourcePath), directory)
  };
}

function parseHeaders(value: unknown, label: string): Readonly<Record<string, string>> {
  const record = expectRecord(value, label);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(record)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`${label} has an invalid header name ${JSON.stringify(name)}.`);
    }
    const normalized = name.toLowerCase();
    if (normalized === "authorization" && typeof headerValue === "string" && !headerValue.includes("${")) {
      throw new Error(
        `${label} cannot carry a literal Authorization header. Name an environment variable in apiKeyEnv, or reference one as \${NAME}.`
      );
    }
    headers[name] = expectNonEmptyString(headerValue, `${label}.${name}`);
  }
  return headers;
}

function expectHttpBaseUrl(value: unknown, label: string): string {
  const candidate = expectNonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be an absolute http or https URL, not ${JSON.stringify(candidate)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https, not ${parsed.protocol}.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must not contain credentials. Use apiKeyEnv for the key.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${label} must name a base URL without a query string or fragment.`);
  }
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    throw new Error(
      `${label} uses plain http for ${parsed.hostname}. Use https, or a localhost endpoint for a local model.`
    );
  }
  return candidate.replace(/\/+$/, "");
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function expectEnvironmentName(value: unknown, label: string): string {
  const name = expectNonEmptyString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} must be an environment variable name, not ${JSON.stringify(name)}.`);
  }
  return name;
}

function expectStructuredOutput(value: unknown, label: string): AiStructuredOutput {
  if (value === "json_schema" || value === "json_object" || value === "text") return value;
  throw new Error(`${label} must be "json_schema", "json_object", or "text".`);
}

function expectTokenParameter(
  value: unknown,
  label: string
): "max_tokens" | "max_completion_tokens" {
  if (value === "max_tokens" || value === "max_completion_tokens") return value;
  throw new Error(`${label} must be "max_tokens" or "max_completion_tokens".`);
}

function expectRedactionRules(value: unknown, label: string): readonly string[] {
  const list = expectStringList(value, label);
  const unknown = list.filter((rule) => !AI_REDACTION_RULES.includes(rule as (typeof AI_REDACTION_RULES)[number]));
  if (unknown.length > 0) {
    throw new Error(`${label} lists ${unknown.join(", ")}, which this release does not recognize.`);
  }
  return list;
}

function expectKnownKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string
): void {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has an unknown setting ${unknown.map((key) => JSON.stringify(key)).join(", ")}.`);
  }
}

function expectRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function expectStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((entry) => expectNonEmptyString(entry, `${label} entry`));
}

function expectIntegerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function expectNumberInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

/** A JSON Schema for the AI config, printed by `wp-migrate-core schema --ai`. */
export const aiConfigJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://nikocodes.com/software/wp-migrate-core/wp-migrate-core.ai.schema.json",
  title: "wp-migrate-core AI assist config",
  description:
    "The endpoint, model, budget and privacy settings for the opt-in assist command. The key is named by environment variable, never stored here.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: aiConfigSchemaVersion },
    provider: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl", "model"],
      properties: {
        baseUrl: { type: "string", pattern: "^https?://" },
        model: { type: "string", minLength: 1 },
        apiKeyEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        embeddingsModel: { type: "string", minLength: 1 },
        headers: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1 }
        },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 600_000 },
        maxRetries: { type: "integer", minimum: 0, maximum: 5 },
        structuredOutput: { enum: ["json_schema", "json_object", "text"] },
        maxTokensParameter: { enum: ["max_tokens", "max_completion_tokens"] }
      },
      propertyNames: { enum: AI_PROVIDER_KEYS }
    },
    jobs: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        AI_JOBS.map((job) => [
          job,
          {
            type: "object",
            additionalProperties: false,
            properties: {
              model: { type: "string", minLength: 1 },
              embeddingsModel: { type: "string", minLength: 1 },
              maxItems: { type: "integer", minimum: 1, maximum: 5_000 },
              minScore: { type: "number", minimum: 0, maximum: 1 }
            },
            propertyNames: { enum: AI_JOB_KEYS }
          }
        ])
      ),
      propertyNames: { enum: AI_JOBS }
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRequests: { type: "integer", minimum: 1 },
        maxInputTokens: { type: "integer", minimum: 1 },
        maxOutputTokens: { type: "integer", minimum: 1 }
      },
      propertyNames: { enum: AI_LIMIT_KEYS }
    },
    privacy: {
      type: "object",
      additionalProperties: false,
      properties: {
        send: { enum: ["metadata", "excerpts", "content"] },
        redact: { type: "array", items: { enum: AI_REDACTION_RULES } }
      },
      propertyNames: { enum: AI_PRIVACY_KEYS }
    },
    cache: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        directory: { type: "string", minLength: 1 }
      },
      propertyNames: { enum: AI_CACHE_KEYS }
    }
  },
  propertyNames: { enum: AI_CONFIG_KEYS }
} as const;
