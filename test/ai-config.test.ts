import assert from "node:assert/strict";
import test from "node:test";

import { aiConfigJsonSchema, parseAiConfig } from "../src/ai/config.js";
import { createOpenAICompatibleProvider } from "../src/ai/provider.js";

test("AI config keeps the key in the environment and validates the endpoint", () => {
  const config = parseAiConfig(
    JSON.stringify({
      schemaVersion: "0.1",
      provider: {
        baseUrl: "https://api.example.test/v1",
        model: "mock-model",
        apiKeyEnv: "MY_AI_KEY",
        embeddingsModel: "mock-embedding",
        maxTokensParameter: "max_tokens"
      },
      jobs: { routes: { minScore: 0.62, maxItems: 20 } },
      limits: { maxRequests: 4 },
      privacy: { send: "metadata", redact: ["email"] },
      cache: { enabled: false }
    }),
    { sourcePath: "/tmp/wp-migrate-core.ai.json" }
  );

  assert.equal(config.provider.apiKeyEnv, "MY_AI_KEY");
  assert.equal(config.provider.timeoutMs, 60_000);
  assert.equal(config.jobs.routes?.minScore, 0.62);
  assert.equal(config.limits.maxRequests, 4);
  assert.equal(config.cache.enabled, false);
  assert.equal(config.cache.directory, "/tmp/.wp-migrate-core/ai-cache");
  assert.deepEqual(config.privacy.redact, ["email"]);
  assert.equal(aiConfigJsonSchema.title, "wp-migrate-core AI assist config");
});

test("AI config refuses secrets, plain remote http and unknown settings", () => {
  const base = {
    schemaVersion: "0.1",
    provider: { baseUrl: "https://api.example.test/v1", model: "mock-model" }
  };
  assert.throws(
    () =>
      parseAiConfig(
        JSON.stringify({
          ...base,
          provider: {
            ...base.provider,
            headers: { authorization: "Bearer sk-live-secret" }
          }
        })
      ),
    /cannot carry a literal Authorization header/
  );
  assert.throws(
    () =>
      parseAiConfig(
        JSON.stringify({
          ...base,
          provider: { ...base.provider, baseUrl: "http://api.example.test/v1" }
        })
      ),
    /plain http/
  );
  assert.throws(
    () => parseAiConfig(JSON.stringify({ ...base, surprise: true })),
    /unknown setting/
  );
  assert.throws(
    () =>
      parseAiConfig(
        JSON.stringify({
          ...base,
          provider: { ...base.provider, baseUrl: "https://user:secret@api.example.test/v1" }
        })
      ),
    /must not contain credentials/
  );
});

test("the OpenAI-compatible provider sends a bearer key and reads structured content", async () => {
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  const provider = createOpenAICompatibleProvider(
    {
      baseUrl: "https://api.example.test/v1",
      model: "mock-model",
      apiKeyEnv: "TEST_AI_KEY",
      embeddingsModel: "mock-embedding",
      timeoutMs: 5_000,
      maxRetries: 0,
      structuredOutput: "json_schema",
      maxTokensParameter: "max_tokens"
    },
    {
      env: { TEST_AI_KEY: "sk-test-secret" },
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        if (String(url).endsWith("/embeddings")) {
          return new Response(
            JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            model: "mock-model-2026",
            choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    }
  );

  const result = await provider.chat({
    system: "system",
    user: "user",
    schemaName: "answer",
    schema: { type: "object" },
    maxOutputTokens: 50
  });
  assert.equal(result.text, "{\"answer\":\"ok\"}");
  assert.equal(result.model, "mock-model-2026");
  assert.equal(result.inputTokens, 12);
  const request = calls[0];
  assert.ok(request);
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test-secret");
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "mock-model");
  assert.equal(body.max_tokens, 50);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "answer", strict: true, schema: { type: "object" } }
  });

  const vectors = await provider.embed(["tap repair", "pricing"]);
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);
  assert.equal(calls[1]?.url, "https://api.example.test/v1/embeddings");
});
