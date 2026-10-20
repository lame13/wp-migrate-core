import type { AiCache } from "./cache.js";
import { parseModelJson } from "./json.js";
import type { AiChatResult, AiProvider } from "./provider.js";
import type { AiLimits, AiUsage } from "./types.js";

export class AiBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiBudgetError";
  }
}

export class AiOutputError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = "AiOutputError";
    this.raw = raw;
  }
}

/** A deliberate ceiling on what one assist run may spend. */
export class AiBudget {
  readonly limits: AiLimits;
  #usage: AiUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(limits: AiLimits) {
    this.limits = limits;
  }

  get usage(): AiUsage {
    return this.#usage;
  }

  reserve(inputEstimate: number): void {
    if (this.#usage.requests + 1 > this.limits.maxRequests) {
      throw new AiBudgetError(
        `The assist run reached its request budget (${this.limits.maxRequests}). Lower --job maxItems, or raise limits.maxRequests in the AI config.`
      );
    }
    if (this.#usage.inputTokens + inputEstimate > this.limits.maxInputTokens) {
      throw new AiBudgetError(
        `The assist run reached its input-token budget (${this.limits.maxInputTokens}). Lower --job maxItems, or raise limits.maxInputTokens in the AI config.`
      );
    }
  }

  record(result: AiChatResult, inputEstimate: number): void {
    const input = result.inputTokens ?? inputEstimate;
    const output = result.outputTokens ?? Math.ceil(result.text.length / 4);
    this.#usage = {
      requests: this.#usage.requests + 1,
      inputTokens: this.#usage.inputTokens + input,
      outputTokens: this.#usage.outputTokens + output
    };
    if (this.#usage.outputTokens > this.limits.maxOutputTokens) {
      throw new AiBudgetError(
        `The assist run reached its output-token budget (${this.limits.maxOutputTokens}). Lower --job maxItems, or raise limits.maxOutputTokens in the AI config.`
      );
    }
  }
}

export interface AskJsonOptions<T> {
  readonly provider: AiProvider;
  readonly cache: AiCache;
  readonly budget: AiBudget;
  readonly promptVersion: string;
  readonly schemaName: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly system: string;
  readonly user: string;
  readonly validate: (value: unknown) => T;
  readonly maxOutputTokens?: number;
}

export interface AskJsonResult<T> {
  readonly value: T;
  readonly raw: string;
}

/**
 * Ask for one JSON value, validate it with a job-owned parser, and give the
 * model exactly one chance to repair malformed output. A second failure is
 * reported as data, not thrown through the whole run.
 */
export async function askJson<T>(options: AskJsonOptions<T>): Promise<AskJsonResult<T>> {
  const cacheKey = options.cache.key("chat", {
    prompt: options.promptVersion,
    model: options.provider.info.model,
    schema: options.schemaName,
    system: options.system,
    user: options.user
  });
  const cached = await options.cache.get<string>(cacheKey);
  if (cached !== undefined) {
    try {
      return { value: options.validate(parseModelJson(cached)), raw: cached };
    } catch {
      // A stale cache entry must not make a run fail; ask again.
    }
  }

  const first = await request(options);
  try {
    const value = options.validate(parseModelJson(first.text));
    await options.cache.set(cacheKey, first.text);
    return { value, raw: first.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repair = await request({
      ...options,
      user: `${options.user}\n\nYour previous answer failed validation: ${message}\nReturn the corrected JSON only. Previous answer:\n${first.text.slice(0, 6_000)}`
    });
    try {
      const value = options.validate(parseModelJson(repair.text));
      await options.cache.set(cacheKey, repair.text);
      return { value, raw: repair.text };
    } catch (repairError) {
      const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
      throw new AiOutputError(`The model did not return a valid answer: ${repairMessage}`, repair.text);
    }
  }
}

async function request<T>(options: AskJsonOptions<T>): Promise<AiChatResult> {
  const estimate = Math.ceil((options.system.length + options.user.length) / 4);
  options.budget.reserve(estimate);
  const result = await options.provider.chat({
    system: options.system,
    user: options.user,
    schemaName: options.schemaName,
    schema: options.schema,
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
  });
  options.budget.record(result, estimate);
  return result;
}

/** Embeddings are cached by text so a repeated route run costs only new text. */
export async function embedWithCache(
  provider: AiProvider,
  cache: AiCache,
  inputs: readonly string[],
  budget?: AiBudget
): Promise<readonly (readonly number[])[]> {
  const vectors: (readonly number[])[] = new Array(inputs.length);
  const missing: { readonly index: number; readonly text: string; readonly key: string }[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const text = inputs[index] as string;
    const key = cache.key("embed", { model: provider.info.embeddingsModel, text });
    const cached = await cache.get<readonly number[]>(key);
    if (cached === undefined) {
      missing.push({ index, text, key });
    } else {
      vectors[index] = cached;
    }
  }

  for (let start = 0; start < missing.length; start += 64) {
    const batch = missing.slice(start, start + 64);
    const estimate = Math.ceil(batch.reduce((total, entry) => total + entry.text.length, 0) / 4);
    budget?.reserve(estimate);
    const embedded = await provider.embed(batch.map((entry) => entry.text));
    budget?.record(
      {
        text: "",
        model: provider.info.embeddingsModel ?? provider.info.model,
        inputTokens: estimate,
        outputTokens: 0
      },
      estimate
    );
    for (let offset = 0; offset < batch.length; offset += 1) {
      const entry = batch[offset] as { readonly index: number; readonly key: string };
      const vector = embedded[offset] as readonly number[];
      vectors[entry.index] = vector;
      await cache.set(entry.key, vector);
    }
  }

  return vectors;
}
