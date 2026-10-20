import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");

async function runCli(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {}
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function startMockAi(): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly authorizations: string[];
}> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      authorizations.push(String(request.headers.authorization ?? ""));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly input?: readonly string[];
        readonly messages?: readonly { readonly content?: string }[];
        readonly response_format?: { readonly json_schema?: { readonly name?: string } };
      };
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/embeddings")) {
        const inputs = body.input ?? [];
        response.end(
          JSON.stringify({
            data: inputs.map((input) => ({
              embedding: /\btap\b/i.test(input) ? [1, 0] : [0, 1]
            }))
          })
        );
        return;
      }

      const name = body.response_format?.json_schema?.name;
      const user = body.messages?.[1]?.content ?? "";
      if (name === "alternative_text_batch") {
        const ids = [...user.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1] as string);
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: ids.map((id) => ({
                      id,
                      altText: "A plumber repairing a leaking tap under a kitchen sink.",
                      decorative: false,
                      confidence: "high",
                      reason: "The surrounding page is about tap repair."
                    }))
                  })
                }
              }
            ]
          })
        );
        return;
      }
      if (name === "shortcode_and_widget_mappings") {
        const keys = [...user.matchAll(/"key":"([^"]+)"/g)].map((match) => match[1] as string);
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    mappings: keys.map((key) => ({
                      key,
                      strategy: "static-fallback",
                      fallbackText: "This form needs to be rebuilt with an approved provider.",
                      reason: "The shortcode executed inside WordPress.",
                      confidence: "medium"
                    }))
                  })
                }
              }
            ]
          })
        );
        return;
      }
      if (name === "content_repair") {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    repairedHtml: "<!-- wp:paragraph -->\n<p>Hello repaired world</p>\n<!-- /wp:paragraph -->",
                    changes: ["Closed the paragraph block."],
                    confidence: "high",
                    reason: "The closing marker was missing."
                  })
                }
              }
            ]
          })
        );
        return;
      }

      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Resolve the form blocker first.",
                  workOrder: [
                    {
                      rank: 1,
                      title: "Replace the contact form",
                      codes: ["SHORTCODE_UNSUPPORTED"],
                      impact: "The contact page cannot launch with a dead form.",
                      action: "Rebuild the form against an approved backend.",
                      effort: "medium",
                      owner: "developer",
                      findingCount: 1,
                      whyFirst: "It is the only blocker."
                    }
                  ],
                  risks: ["The form provider may need DNS changes."],
                  questions: ["Which form backend is approved?"]
                })
              }
            }
          ]
        })
      );
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authorizations
  };
}

test("assist runs with a bring-your-own key and applies decisions in convert", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-cli-"));
  const mock = await startMockAi();
  context.after(async () => {
    await new Promise<void>((resolveClose) => mock.server.close(() => resolveClose()));
    await rm(workspace, { recursive: true, force: true });
  });

  const plan = join(workspace, "plan");
  const inspected = await runCli(["inspect", demoFixturePath, "--out", plan], workspace);
  assert.equal(inspected.status, 0, inspected.stderr);
  const aiConfig = join(workspace, "wp-migrate-core.ai.json");
  await writeFile(
    aiConfig,
    JSON.stringify({
      schemaVersion: "0.1",
      provider: {
        baseUrl: mock.baseUrl,
        model: "mock-model",
        apiKeyEnv: "TEST_AI_KEY",
        embeddingsModel: "mock-embedding"
      },
      cache: { enabled: false }
    })
  );

  const triage = await runCli(
    ["assist", plan, "--job", "triage", "--ai-config", aiConfig, "--json"],
    workspace,
    { TEST_AI_KEY: "sk-test-secret" }
  );
  assert.equal(triage.status, 0, triage.stderr);
  assert.equal(mock.authorizations[0], "Bearer sk-test-secret");
  const triageOutput = JSON.parse(triage.stdout) as { readonly brief: string; readonly run: string };
  assert.match(triageOutput.brief, /\/ai\/triage\/brief\.md$/);
  assert.match(await readFile(triageOutput.brief, "utf8"), /Replace the contact form/);
  assert.doesNotMatch(await readFile(triageOutput.run, "utf8"), /sk-test-secret/);

  const altRun = await runCli(
    ["assist", plan, "--job", "alt-text", "--ai-config", aiConfig, "--out", join(workspace, "alt-ai")],
    workspace,
    { TEST_AI_KEY: "sk-test-secret" }
  );
  assert.equal(altRun.status, 0, altRun.stderr);
  const altApply = await runCli(
    ["assist", "apply", join(workspace, "alt-ai", "suggestions.json"), "--out", join(workspace, "alt-decisions.json")],
    workspace
  );
  assert.equal(altApply.status, 0, altApply.stderr);
  const decisions = JSON.parse(await readFile(join(workspace, "alt-decisions.json"), "utf8")) as {
    readonly altText?: Readonly<Record<string, string>>;
  };
  assert.ok(Object.keys(decisions.altText ?? {}).length > 0);

  const converted = await runCli(
    [
      "convert",
      demoFixturePath,
      "--out",
      join(workspace, "site"),
      "--uploads",
      join(process.cwd(), "fixtures", "uploads"),
      "--decisions",
      join(workspace, "alt-decisions.json")
    ],
    workspace
  );
  assert.equal(converted.status, 0, converted.stderr);
  const [services, issues, media] = await Promise.all([
    readFile(join(workspace, "site", "src", "content", "pages", "services.md"), "utf8"),
    readFile(join(workspace, "site", "migration", "issues.json"), "utf8"),
    readFile(join(workspace, "site", "migration", "media.json"), "utf8")
  ]);
  assert.match(services, /A plumber repairing a leaking tap/);
  assert.doesNotMatch(issues, /MEDIA_MISSING_ALT_TEXT/);
  assert.match(media, /A plumber repairing a leaking tap/);
});

test("assist maps a shortcode, apply writes decisions, and convert removes the dead shortcode", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-map-cli-"));
  const mock = await startMockAi();
  context.after(async () => {
    await new Promise<void>((resolveClose) => mock.server.close(() => resolveClose()));
    await rm(workspace, { recursive: true, force: true });
  });

  const plan = join(workspace, "plan");
  const inspected = await runCli(["inspect", demoFixturePath, "--out", plan], workspace);
  assert.equal(inspected.status, 0, inspected.stderr);
  const aiConfig = join(workspace, "wp-migrate-core.ai.json");
  await writeFile(
    aiConfig,
    JSON.stringify({
      schemaVersion: "0.1",
      provider: { baseUrl: mock.baseUrl, model: "mock-model", apiKeyEnv: "TEST_AI_KEY" },
      cache: { enabled: false }
    })
  );
  const mapped = await runCli(
    ["assist", plan, "--job", "shortcodes", "--ai-config", aiConfig, "--out", join(workspace, "map-ai")],
    workspace,
    { TEST_AI_KEY: "sk-test-secret" }
  );
  assert.equal(mapped.status, 0, mapped.stderr);
  const applied = await runCli(
    [
      "assist",
      "apply",
      join(workspace, "map-ai", "suggestions.json"),
      "--out",
      join(workspace, "map-decisions.json"),
      "--accept",
      "shortcodes"
    ],
    workspace
  );
  assert.equal(applied.status, 0, applied.stderr);
  const converted = await runCli(
    [
      "convert",
      demoFixturePath,
      "--out",
      join(workspace, "site"),
      "--uploads",
      join(process.cwd(), "fixtures", "uploads"),
      "--decisions",
      join(workspace, "map-decisions.json")
    ],
    workspace
  );
  assert.equal(converted.status, 0, converted.stderr);
  const contact = await readFile(join(workspace, "site", "src", "content", "pages", "contact.md"), "utf8");
  assert.doesNotMatch(contact, /\[gravityform/);
  assert.match(contact, /needs to be rebuilt with an approved provider/);
});

test("repair runs only with an export and its accepted patch survives convert", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-repair-cli-"));
  const mock = await startMockAi();
  context.after(async () => {
    await new Promise<void>((resolveClose) => mock.server.close(() => resolveClose()));
    await rm(workspace, { recursive: true, force: true });
  });

  const plan = join(workspace, "plan");
  await mkdir(plan, { recursive: true });
  const exportPath = join(workspace, "export.xml");
  await writeFile(exportPath, syntheticWxr("<!-- wp:paragraph -->\n<p>Hello world</p>"), "utf8");
  const aiConfig = join(workspace, "wp-migrate-core.ai.json");
  await writeFile(
    aiConfig,
    JSON.stringify({
      schemaVersion: "0.1",
      provider: { baseUrl: mock.baseUrl, model: "mock-model", apiKeyEnv: "TEST_AI_KEY" },
      cache: { enabled: false }
    })
  );
  const repaired = await runCli(
    [
      "assist",
      plan,
      "--job",
      "repair",
      "--export",
      exportPath,
      "--ai-config",
      aiConfig,
      "--out",
      join(workspace, "repair-ai")
    ],
    workspace,
    { TEST_AI_KEY: "sk-test-secret" }
  );
  assert.equal(repaired.status, 0, repaired.stderr);
  const applied = await runCli(
    [
      "assist",
      "apply",
      join(workspace, "repair-ai", "suggestions.json"),
      "--out",
      join(workspace, "repair-decisions.json"),
      "--accept",
      "repair"
    ],
    workspace
  );
  assert.equal(applied.status, 0, applied.stderr);
  const converted = await runCli(
    [
      "convert",
      exportPath,
      "--out",
      join(workspace, "site"),
      "--decisions",
      join(workspace, "repair-decisions.json")
    ],
    workspace
  );
  assert.equal(converted.status, 0, converted.stderr);
  const page = await readFile(join(workspace, "site", "src", "content", "pages", "test.md"), "utf8");
  assert.match(page, /Hello repaired world/);
});

test("a route decision becomes a published redirect rule", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-ai-route-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const decisions = join(workspace, "route-decisions.json");
  await writeFile(
    decisions,
    JSON.stringify({
      schemaVersion: "0.1",
      routes: { "/old-tap/": "/guides/stop-a-leaking-tap/" }
    })
  );
  const converted = await runCli(
    [
      "convert",
      demoFixturePath,
      "--out",
      join(workspace, "site"),
      "--decisions",
      decisions
    ],
    workspace
  );
  assert.equal(converted.status, 0, converted.stderr);
  const redirects = JSON.parse(
    await readFile(join(workspace, "site", "migration", "redirects.json"), "utf8")
  ) as { readonly redirects: readonly { readonly sourcePath: string; readonly targetRoute: string }[] };
  assert.ok(
    redirects.redirects.some(
      (redirect) =>
        redirect.sourcePath === "/old-tap/" &&
        redirect.targetRoute === "/guides/stop-a-leaking-tap/"
    )
  );
  const netlify = await readFile(
    join(workspace, "site", "migration", "redirect-rules", "netlify", "_redirects"),
    "utf8"
  );
  assert.match(netlify, /\/old-tap\/\s+\/guides\/stop-a-leaking-tap\//);
});

function syntheticWxr(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Test</title>
    <link>https://example.test</link>
    <wp:wxr_version>1.2</wp:wxr_version>
    <item>
      <title>Test page</title>
      <link>https://example.test/test/</link>
      <dc:creator>tester</dc:creator>
      <content:encoded><![CDATA[${content}]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date>2026-01-01 00:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
      <wp:comment_status>closed</wp:comment_status>
      <wp:ping_status>closed</wp:ping_status>
      <wp:post_name>test</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_parent>0</wp:post_parent>
      <wp:menu_order>0</wp:menu_order>
      <wp:post_type>page</wp:post_type>
      <wp:post_password></wp:post_password>
      <wp:is_sticky>0</wp:is_sticky>
    </item>
  </channel>
</rss>`;
}
