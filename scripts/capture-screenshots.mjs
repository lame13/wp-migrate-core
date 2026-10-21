// Run after npm run build. Uses an already-installed Playwright; no API key
// or network is needed. PLAYWRIGHT_MODULE may point to its index.mjs file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAiConfig } from "../dist/src/ai/config.js";
import { runAssist } from "../dist/src/ai/run.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "wpmc-screenshots-"));
const output = join(repository, "docs/screenshots");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;

// These responses illustrate the real review UI without attributing invented
// output to a live model. Both the UI and README identify them as mock data.
const provider = {
  info: { endpoint: "local demo fixture", model: "Demo responses (mock)" },
  async chat(request) {
    const payload = JSON.parse(request.user.slice(request.user.indexOf("\n") + 1));
    if (request.schemaName === "migration_triage") {
      const tasks = [
        ["SHORTCODE_UNSUPPORTED", "Replace WordPress shortcodes", "Choose a form backend and review static fallbacks for the remaining shortcodes.", "developer", "medium", "Visitor actions depend on working forms."],
        ["ELEMENTOR_QUERY_UNSUPPORTED", "Rebuild dynamic content", "Replace the WordPress post query with a listing in the destination.", "developer", "medium", "The exported layout cannot run a WordPress query."],
        ["MEDIA_MISSING_ALT_TEXT", "Review missing image descriptions", "Run the alt-text job, compare each draft with its image, then accept the useful descriptions.", "editor", "small", "One accepted description can cover repeated uses of an image."]
      ];
      return { model: "demo", text: JSON.stringify({
        summary: "Bright Path Plumbing: fix the interactive blockers, rebuild dynamic listings, then review image descriptions.",
        workOrder: tasks.filter(([code]) => payload.issueGroups.some((group) => group.code === code)).map(([code, title, action, owner, effort, whyFirst], index) => ({
          rank: index + 1, title, codes: [code], impact: whyFirst, action, effort, owner,
          findingCount: payload.issueGroups.find((group) => group.code === code).count, whyFirst
        })),
        risks: ["Forms and dynamic widgets need a working replacement before launch. AI proposals do not resolve these findings by themselves."],
        questions: ["Which form backend should receive enquiries from the new site?"]
      }) };
    }
    assert.equal(request.schemaName, "alternative_text_batch");
    return { model: "demo", text: JSON.stringify({ items: payload.map((asset) => ({
      id: asset.id, altText: "Plumbing repair service", decorative: false, confidence: "low",
      reason: "Draft based on the asset title and service-page context. Check the actual image before accepting."
    })) }) };
  },
  async embed() { throw new Error("This screenshot fixture does not use embeddings."); }
};

try {
  execFileSync(process.execPath, [join(repository, "dist/src/cli.js"), "demo", "--out", join(workspace, "demo")], { cwd: workspace, stdio: "pipe" });
  const plan = join(workspace, "demo/migration-plan");
  const config = parseAiConfig(JSON.stringify({
    schemaVersion: "0.1", provider: { baseUrl: "https://demo.invalid/v1", model: "demo" }, cache: { enabled: false }
  }));
  for (const job of ["triage", "alt-text"]) {
    await runAssist({
      planDirectory: plan, outputDirectory: join(workspace, job), job, config, provider,
      now: () => new Date("2026-10-21T00:00:00.000Z")
    });
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const job of ["triage", "alt-text"]) {
    await page.goto(pathToFileURL(join(workspace, job, "review.html")).href);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.locator("main").screenshot({ path: join(output, `ai-${job}.png`) });
  }
  await page.goto(pathToFileURL(join(plan, "report.html")).href);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.screenshot({ path: join(output, "demo-report.png") });
  assert.deepEqual(errors, []);
  console.log("Captured ai-triage.png, ai-alt-text.png and demo-report.png.");
} finally {
  await browser?.close();
  await rm(workspace, { recursive: true, force: true });
}
