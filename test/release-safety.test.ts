import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import { renderReport, writeReport } from "../src/report.js";
import { demoFixturePath } from "./fixture-path.js";

async function loadDemoProject() {
  return parseWxr(await readFile(demoFixturePath, "utf8"));
}

test("keeps the generated Astro handoff private and removes raw issue evidence", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-handoff-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  await generateAstroProject(await loadDemoProject(), output);

  const [layout, robots, contact, post, issues] = await Promise.all([
    readFile(join(output, "src/layouts/Layout.astro"), "utf8"),
    readFile(join(output, "public/robots.txt"), "utf8"),
    readFile(join(output, "src/content/pages/contact.md"), "utf8"),
    readFile(join(output, "src/content/posts/stop-a-leaking-tap.md"), "utf8"),
    readFile(join(output, "migration/issues.json"), "utf8")
  ]);

  assert.match(layout, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(layout, /sourceUrl|migration\/issues\.json|issueCount|blockerCount/);
  assert.equal(robots, "User-agent: *\nDisallow: /\n");
  assert.match(contact, /<h1>Contact<\/h1>/);
  assert.doesNotMatch(contact, /sourceUrl|wordpressId|migrationRecordId|migrationIssueCount/);
  assert.doesNotMatch(contact, /gravityform id=/);
  assert.doesNotMatch(post, /<img|brightpath\.example\/wp-content/);
  assert.match(post, /verified local asset before publication/);
  assert.match(issues, /ELEMENTOR_IMAGE_REMOTE_MEDIA/);
  assert.match(issues, /GUTENBERG_MEDIA_UNSUPPORTED/);
  assert.doesNotMatch(issues, /gravityform id=/);
});

test("withholds unsafe Elementor links from generated content", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-unsafe-link-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  const fixture = await readFile(demoFixturePath, "utf8");
  const project = parseWxr(fixture.replace('"url":"/contact/"', '"url":"javascript:alert(1)"'));

  assert.ok(project.issues.some((issue) => issue.code === "ELEMENTOR_BUTTON_UNSAFE_URL"));
  await generateAstroProject(project, output);

  const services = await readFile(join(output, "src/content/pages/services.md"), "utf8");
  assert.doesNotMatch(services, /javascript:/i);
  assert.match(services, /This link needs review before publication\./);
});

test("keeps raw source evidence out of reports and refuses to clobber a report", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-report-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  const project = await loadDemoProject();
  const report = renderReport(project);
  const reportPath = join(output, "report.html");

  assert.match(report, /Keep this report local\./);
  assert.doesNotMatch(report, /gravityform id=/);

  await writeFile(reportPath, "existing report", "utf8");
  await assert.rejects(
    writeReport(project, reportPath, { noClobber: true }),
    /Refusing to overwrite existing output/
  );
});
