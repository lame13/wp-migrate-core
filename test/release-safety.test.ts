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
  const project = parseWxr(fixture.replace('"link":{"url":"/contact"}', '"link":{"url":"javascript:alert(1)"}'));

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

test("ships media, redirect and link inventories without source credentials", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-inventory-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  const fixture = (await readFile(demoFixturePath, "utf8"))
    .replaceAll("https://brightpath.example", "https://private-user:private-password@brightpath.example")
    .replace(/(<link>[^<]+)(<\/link>)/g, "$1?private-query=secret#private-fragment$2")
    .replace('[gravityform id="4"', '[gravityform secret="private-evidence" id="4"');
  const project = parseWxr(fixture);
  await generateAstroProject(project, output);
  await writeReport(project, join(output, "migration/report.html"));

  const [media, redirects, links, manifest, report] = await Promise.all([
    readFile(join(output, "migration/media.json"), "utf8"),
    readFile(join(output, "migration/redirects.json"), "utf8"),
    readFile(join(output, "migration/links.json"), "utf8"),
    readFile(join(output, "migration/manifest.json"), "utf8"),
    readFile(join(output, "migration/report.html"), "utf8")
  ]);

  const inventory = JSON.parse(media);
  assert.equal(inventory.schemaVersion, "0.2");
  assert.equal(inventory.summary.assets, 5);
  assert.equal(inventory.summary.notInExport, 1);
  assert.ok(
    inventory.references.some(
      (reference: { status: string; kind: string }) =>
        reference.status === "missing-alt-text" && reference.kind === "elementor-image"
    ),
    "the inventory must keep the per-asset detail the repair queue aggregates"
  );

  const urlMap = JSON.parse(redirects);
  assert.equal(urlMap.summary.generated, 0, "every URL in this export carries a query string");
  assert.equal(
    urlMap.urls.filter((entry: { status: string }) => entry.status === "ambiguous-url").length,
    4
  );

  assert.equal(JSON.parse(manifest).media.file, "migration/media.json");
  assert.equal(JSON.parse(manifest).redirects.file, "migration/redirects.json");
  assert.equal(JSON.parse(manifest).links.file, "migration/links.json");
  assert.equal(JSON.parse(links).schemaVersion, "0.3");
  assert.equal(JSON.parse(links).summary.references, 5);

  for (const generated of [media, redirects, links, manifest, report]) {
    assert.doesNotMatch(generated, /private-user|private-password|private-query|private-fragment|private-evidence/);
  }
  assert.doesNotMatch(media, /gravityform id=/);
  assert.match(report, /Media inventory/);
  assert.match(report, /URL and redirect map/);
  assert.match(report, /Link map/);
});

test("rewrites same-site links and leaves everything it cannot vouch for alone", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-links-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  const project = await loadDemoProject();
  await generateAstroProject(project, output);

  const [home, services, links] = await Promise.all([
    readFile(join(output, "src/content/pages/home.md"), "utf8"),
    readFile(join(output, "src/content/pages/services.md"), "utf8"),
    readFile(join(output, "migration/links.json"), "utf8")
  ]);

  assert.match(home, /href="\/guides\/stop-a-leaking-tap\/"/);
  assert.doesNotMatch(home, /href="\/guides\/stop-a-leaking-tap"/);
  assert.match(home, /href="\/pricing\/"/, "a link this export cannot vouch for is left as written");
  assert.match(home, /href="https:\/\/example\.org\/plumbing-standards"/);
  assert.match(services, /href="\/contact\/"/, "the Elementor button was rewritten too");

  const inventory = JSON.parse(links);
  assert.deepEqual(
    inventory.rewrites.map((rewrite: { href: string; rewritten: string }) => [rewrite.href, rewrite.rewritten]),
    [
      ["/guides/stop-a-leaking-tap", "/guides/stop-a-leaking-tap/"],
      ["/contact", "/contact/"]
    ]
  );
});

test("rewrites every href spelling and preserves queries, fragments and other attributes", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-link-variants-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const markup = `<p>
    <a href="/contact/">Already local</a>
    <a href="/contact">No slash</a>
    <a href="https://brightpath.example/contact">Absolute</a>
    <a href="https://brightpath.example/contact/">Absolute with slash</a>
    <a href="/contact?name=Team&amp;view=Map#Team">Query</a>
    <a href="/contact?name=team&amp;view=map#team">Different query</a>
    <a title='See href="/contact"' href="/guides/stop-a-leaking-tap">Attribute text</a>
    <a title="2 > 1" href="/contact">Quoted angle</a>
    <a href="//private-user:private-password@brightpath.example/contact?private-query=1#Team">Private</a>
  </p>`;
  const fixture = (await readFile(demoFixturePath, "utf8"))
    .replace("<!-- /wp:group -->", `<!-- /wp:group -->${markup}`);
  const project = parseWxr(fixture);
  await generateAstroProject(project, output);

  const home = await readFile(join(output, "src/content/pages/home.md"), "utf8");
  assert.doesNotMatch(home, /<a href="(?:https:\/\/brightpath\.example\/contact\/?|\/contact)"/);
  assert.match(home, /href="\/contact\/\?name=Team&amp;view=Map#Team"/);
  assert.match(home, /href="\/contact\/\?name=team&amp;view=map#team"/);
  assert.ok(home.includes(`title='See href="/contact"' href="/guides/stop-a-leaking-tap/"`));
  assert.ok(home.includes('title="2 > 1" href="/contact/"'));
  assert.match(home, /href="\/contact\/\?private-query=1#Team"/);
  const links = await readFile(join(output, "migration/links.json"), "utf8");
  for (const artifact of [links, renderReport(project)]) {
    assert.doesNotMatch(artifact, /private-user|private-password|private-query|#Team#Team/);
  }
});
