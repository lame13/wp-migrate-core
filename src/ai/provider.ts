import type { AiProviderConfig, AiProviderInfo } from "./types.js";

export interface AiChatRequest {
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
}

export interface AiChatResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AiProvider {
  readonly info: AiProviderInfo;
  chat(request: AiChatRequest): Promise<AiChatResult>;
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface ProviderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  /** Test seam: a deterministic delay instead of waiting between retries. */
  readonly retryDelayMs?: (attempt: number, retryAfterSeconds: number | undefined) => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class AiHttpError extends Error {
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "AiHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The widest common denominator among "OpenAI-compatible" endpoints is
 * `POST /chat/completions`. This provider deliberately does not use an SDK:
 * one fetch call keeps the dependency surface at zero, and the capability
 * switches in the config cover the places compatible servers differ.
 */
export function createOpenAICompatibleProvider(
  config: AiProviderConfig,
  options: ProviderOptions = {}
): AiProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const endpoint = `${config.baseUrl}/chat/completions`;
  const embeddingsEndpoint = `${config.baseUrl}/embeddings`;
  const info: AiProviderInfo = {
    endpoint: sanitizedEndpoint(config.baseUrl),
    model: config.model,
    ...(config.embeddingsModel === undefined ? {} : { embeddingsModel: config.embeddingsModel })
  };

  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };
  const key = config.apiKeyEnv === undefined
    ? env.WPMC_AI_API_KEY ?? env.OPENAI_API_KEY
    : env[config.apiKeyEnv];
  if (config.apiKeyEnv !== undefined && (key === undefined || key.trim() === "")) {
    throw new Error(
      `The AI config names ${config.apiKeyEnv} for the key, but that environment variable is empty.`
    );
  }
  if (key !== undefined && key.trim() !== "") {
    baseHeaders.authorization = `Bearer ${key}`;
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
      const replacement = env[variable];
      if (replacement === undefined || replacement === "") {
        throw new Error(`The AI config header ${name} references ${variable}, which is empty.`);
      }
      return replacement;
    });
    baseHeaders[name] = resolved;
  }

  return {
    info,
    async chat(request: AiChatRequest): Promise<AiChatResult> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ]
      };
      if (config.maxTokensParameter !== undefined && request.maxOutputTokens !== undefined) {
        body[config.maxTokensParameter] = request.maxOutputTokens;
      }
      if (config.structuredOutput === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: request.schema
          }
        };
      } else if (config.structuredOutput === "json_object") {
        body.response_format = { type: "json_object" };
      }

      let response: Record<string, unknown>;
      try {
        response = await postJson(endpoint, body, config, baseHeaders, fetchImpl, sleep, options.retryDelayMs);
      } catch (error) {
        // A compatibility server may reject a response_format it does not
        // implement. Retry once without it; the parser still validates the
        // answer, so dropping the hint does not loosen the contract.
        if (
          error instanceof AiHttpError &&
          error.status === 400 &&
          body.response_format !== undefined
        ) {
          delete body.response_format;
          response = await postJson(endpoint, body, config, baseHeaders, fetchImpl, sleep, options.retryDelayMs);
        } else {
          throw error;
        }
      }

      const content = readChatContent(response);
      const usage = isRecord(response.usage) ? response.usage : undefined;
      const model = typeof response.model === "string" && response.model.trim() !== ""
        ? response.model
        : config.model;
      return {
        text: content,
        model,
        ...(usage === undefined ? {} : tokenCounts(usage))
      };
    },

    async embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
      if (config.embeddingsModel === undefined) {
        throw new Error(
          "Route matching needs an embeddings model. Set provider.embeddingsModel or jobs.routes.embeddingsModel in the AI config."
        );
      }
      if (inputs.length === 0) return [];
      const body = { model: config.embeddingsModel, input: inputs };
      const response = await postJson(
        embeddingsEndpoint,
        body,
        config,
        baseHeaders,
        fetchImpl,
        sleep,
        options.retryDelayMs
      );
      const data = response.data;
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error("The embeddings endpoint returned a different number of vectors than inputs.");
      }
      const vectors = data.map((entry, index) => {
        if (!isRecord(entry) || !Array.isArray(entry.embedding)) {
          throw new Error(`The embeddings endpoint returned no vector for input ${index + 1}.`);
        }
        const vector = entry.embedding;
        if (
          vector.length === 0 ||
          vector.some((component) => typeof component !== "number" || !Number.isFinite(component))
        ) {
          throw new Error(`The embeddings endpoint returned an invalid vector for input ${index + 1}.`);
        }
        return vector as number[];
      });
      return vectors;
    }
  };
}

async function postJson(
  endpoint: string,
  body: Readonly<Record<string, unknown>>,
  config: AiProviderConfig,
  headers: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  retryDelayMs: ProviderOptions["retryDelayMs"]
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const text = await response.text();
      if (!response.ok) {
        const detail = sanitizeProviderMessage(text);
        if (shouldRetry(response.status) && attempt < config.maxRetries) {
          lastError = new AiHttpError(
            `The AI endpoint returned ${response.status} ${response.statusText}.`,
            response.status,
            detail
          );
          await sleep(delayFor(attempt, response.headers.get("retry-after"), retryDelayMs));
          continue;
        }
        throw new AiHttpError(
          `The AI endpoint returned ${response.status} ${response.statusText}.${detail === undefined ? "" : ` ${detail}`}`,
          response.status,
          detail
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AiHttpError("The AI endpoint returned a response that is not JSON.", response.status);
      }
      if (!isRecord(parsed)) {
        throw new AiHttpError("The AI endpoint returned JSON that is not an object.", response.status);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries || !isRetryableError(error)) {
        break;
      }
      await sleep(delayFor(attempt, undefined, retryDelayMs));
    }
  }

  if (lastError instanceof AiHttpError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`The AI request to ${sanitizedEndpoint(endpoint)} failed: ${sanitizeProviderMessage(message) ?? message}`);
}

function readChatContent(response: Readonly<Record<string, unknown>>): string {
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new Error("The AI endpoint returned no choices.");
  }
  const message = choices[0].message;
  if (!isRecord(message)) {
    throw new Error("The AI endpoint returned no message.");
  }
  const content = message.content;
  if (typeof content === "string") {
    if (content.trim() === "") throw new Error("The AI endpoint returned an empty message.");
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
    if (text.trim() === "") throw new Error("The AI endpoint returned an empty message.");
    return text;
  }
  throw new Error("The AI endpoint returned a message without text.");
}

function tokenCounts(usage: Readonly<Record<string, unknown>>): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0
  };
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof AiHttpError) {
    return error.status !== undefined && shouldRetry(error.status);
  }
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function delayFor(
  attempt: number,
  retryAfter: string | null | undefined,
  override: ProviderOptions["retryDelayMs"]
): number {
  const seconds = retryAfter === null || retryAfter === undefined ? undefined : Number(retryAfter);
  if (override !== undefined) return override(attempt, Number.isFinite(seconds) ? seconds : undefined);
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, 30_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 30_000);
}

function sanitizeProviderMessage(value: string): string | undefined {
  const withoutSecrets = value
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/authorization[^,}\n]*/gi, "authorization [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutSecrets === "" ? undefined : withoutSecrets.slice(0, 400);
}

function sanitizedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "invalid endpoint";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
