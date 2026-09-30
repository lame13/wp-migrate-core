import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import { applyMediaDelivery, mediaDeliveryRecord, planMediaDelivery } from "../src/media.js";
import { renderReport } from "../src/report.js";
import type { MigrationProject } from "../src/types.js";

function wxrDocument(...items: readonly string[]): string {
  return [
    "<rss><channel>",
    "<title>Example site</title>",
    "<link>https://example.test/</link>",
    ...items,
    "</channel></rss>"
  ].join("");
}

function page(body: string, link = "https://example.test/example-page/"): string {
  return [
    "<item>",
    "<title>Example page</title>",
    `<link>${link}</link>`,
    "<wp:post_id>1</wp:post_id>",
    "<wp:post_type>page</wp:post_type>",
    "<wp:status>publish</wp:status>",
    "<wp:post_name>example-page</wp:post_name>",
    `<content:encoded><![CDATA[${body}]]></content:encoded>`,
    "</item>"
  ].join("");
}

function attachment(id: number, file: string): string {
  return [
    `<item><title>Photo ${id}</title><wp:post_id>${id}</wp:post_id>`,
    "<wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>",
    `<wp:attachment_url>https://example.test/wp-content/uploads/${file}</wp:attachment_url>`,
    `<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>${file}</wp:meta_value></wp:postmeta>`,
    '<wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value>A tap handle</wp:meta_value></wp:postmeta>',
    '<wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value>a:2:{s:5:"width";i:1200;s:6:"height";i:800;}</wp:meta_value></wp:postmeta>',
    "</item>"
  ].join("");
}

const photoPath = "/wp-content/uploads/2026/05/photo.jpg";
const imagePage = page(`<p>Text</p><img src="https://example.test${photoPath}">`);

async function uploadsDirectoryWith(
  root: string,
  files: readonly string[]
): Promise<string> {
  const uploads = join(root, "uploads");
  for (const file of files) {
    const target = join(uploads, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `placeholder bytes for ${file}`);
  }
  return uploads;
}

async function planFor(
  project: MigrationProject,
  uploadsDirectory: string
): Promise<MigrationProject> {
  return applyMediaDelivery(project, await planMediaDelivery(project, { uploadsDirectory }));
}

test("copies referenced uploads and points the generated markup at them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);

  const project = await planFor(parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"))), uploads);
  const output = join(root, "site");
  await generateAstroProject(project, output);

  const copied = await readFile(join(output, "public", "wp-content", "uploads", "2026/05/photo.jpg"), "utf8");
  assert.match(copied, /placeholder bytes/);

  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /<img src="\/wp-content\/uploads\/2026\/05\/photo\.jpg"/);
  assert.doesNotMatch(content, /example\.test\/wp-content/);
  assert.doesNotMatch(content, /verified local asset before publication/);

  assert.equal(project.media.delivery?.summary.copied, 1);
  assert.equal(project.media.delivery?.summary.missing, 0);
  assert.equal(project.summary.media.delivery?.bytes, copied.length);
});

test("adds the alt text and dimensions the export carries but the markup left out", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-alt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);

  const project = await planFor(parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"))), uploads);
  const output = join(root, "site");
  await generateAstroProject(project, output);

  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /alt="A tap handle"/);
  assert.match(content, /width="1200"/);
  assert.match(content, /height="800"/);
});

test("serves a resized variant from the original file the uploads directory carries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-variant-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);

  const project = parseWxr(wxrDocument(
    page('<img src="https://example.test/wp-content/uploads/2026/05/photo-768x512.jpg">'),
    attachment(101, "2026/05/photo.jpg")
  ));
  const delivered = await planFor(project, uploads);

  const entry = delivered.media.delivery?.entries[0];
  assert.equal(entry?.status, "copied");
  assert.equal(entry?.sourcePath, "/wp-content/uploads/2026/05/photo-768x512.jpg");
  assert.equal(entry?.outputPath, photoPath, "the original file stands in for the missing size");

  const output = join(root, "site");
  await generateAstroProject(delivered, output);
  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /<img src="\/wp-content\/uploads\/2026\/05\/photo\.jpg"/);
});

test("points markup at a media host when the files are not local", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-base-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const parsed = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")));
  const project = applyMediaDelivery(
    parsed,
    await planMediaDelivery(parsed, { baseUrl: "https://media.example.test/uploads/" })
  );
  assert.equal(project.media.delivery?.source, "base-url");
  assert.equal(project.media.delivery?.entries[0]?.status, "linked");

  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /src="https:\/\/media\.example\.test\/uploads\/2026\/05\/photo\.jpg"/);
  await assert.rejects(stat(join(output, "public", "wp-content")));
});

test("reports media with no local file instead of pretending it is there", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/other.jpg"]);

  const project = await planFor(parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"))), uploads);
  assert.equal(project.media.delivery?.entries[0]?.status, "missing");

  const finding = project.issues.find((issue) => issue.code === "MEDIA_NOT_LOCAL");
  assert.equal(finding?.severity, "warning");
  assert.match(finding?.message ?? "", /no local file in the uploads directory/);
  assert.equal(project.summary.warnings, 1);

  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /src="https:\/\/example\.test\/wp-content\/uploads\/2026\/05\/photo\.jpg"/);
  assert.match(content, /alt="A tap handle"/);
});

test("refuses a source path that climbs out of the uploads directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-traversal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);
  await writeFile(join(root, "secret.jpg"), "private bytes");

  // The reference climbs out of the media library by hand, which is exactly
  // what an export can contain and what a plan must never act on.
  const climbing = page('<img src="/wp-content/uploads/../../secret.jpg">');
  const project = await planFor(parseWxr(wxrDocument(climbing)), uploads);
  const plan = project.media.delivery;

  const entry = plan?.entries.find((candidate) => candidate.sourcePath.includes("secret"));
  assert.equal(entry?.status, "remote", "the file cannot be reached, so the source URL is left alone");
  assert.deepEqual(plan?.copies, [], "nothing outside the uploads directory may be copied");
  const output = join(root, "site");
  await generateAstroProject(project, output);
  await assert.rejects(stat(join(output, "public", "secret.jpg")));
});

test("keeps the repair marker when the run was given no place for media to come from", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-none-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const project = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")));
  assert.equal(project.media.delivery, undefined);

  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src", "content", "pages", "example-page.md"), "utf8");
  assert.match(content, /verified local asset before publication/);
  assert.doesNotMatch(content, /<img/);
});

test("requires a source before it plans any delivery", async () => {
  const project = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")));
  await assert.rejects(planMediaDelivery(project, {}), /needs a place for the files to come from/);
});

test("reclassifies a live upload URL as served once the file is copied", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-coverage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);

  const project = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")), {
    liveUrlSource: { urls: [`https://example.test${photoPath}`], sitemapRefs: [] }
  });
  assert.equal(project.coverage.entries[0]?.status, "excluded-shape");
  assert.equal(project.coverage.entries[0]?.shape, "media-file");

  const delivered = await planFor(project, uploads);
  assert.equal(delivered.coverage.entries[0]?.status, "routed");
  assert.equal(delivered.coverage.entries[0]?.shape, "media-file", "it is still an upload, now served");
  assert.match(delivered.coverage.entries[0]?.reason ?? "", /serves this upload/);
  assert.equal(delivered.coverage.summary.routed, 1);
  assert.equal(delivered.coverage.summary.excluded, 0);
});

test("keeps the local uploads path out of the generated artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-privacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);

  const project = await planFor(parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"))), uploads);
  const output = join(root, "site");
  await generateAstroProject(project, output);

  const [media, manifest] = await Promise.all([
    readFile(join(output, "migration", "media.json"), "utf8"),
    readFile(join(output, "migration", "manifest.json"), "utf8")
  ]);
  assert.equal(/"uploadsDirectory"/.test(media), false, "the uploads directory must not reach the artifact");
  assert.equal(media.includes(root), false);
  assert.equal(manifest.includes(root), false);
  assert.match(media, /"sourcePath": "\/wp-content\/uploads\/2026\/05\/photo\.jpg"/);
  assert.match(media, /"outputPath": "\/wp-content\/uploads\/2026\/05\/photo\.jpg"/);
});

test("delivers unreferenced attachments only when the caller asks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-unused-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg", "2026/05/other.jpg"]);
  const project = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"), attachment(102, "2026/05/other.jpg")));

  const referencedOnly = applyMediaDelivery(project, await planMediaDelivery(project, { uploadsDirectory: uploads }));
  assert.equal(referencedOnly.media.delivery?.summary.files, 1);

  const everything = applyMediaDelivery(
    project,
    await planMediaDelivery(project, { uploadsDirectory: uploads, copyUnusedAssets: true })
  );
  assert.equal(everything.media.delivery?.summary.files, 2);
  assert.equal(everything.media.delivery?.summary.copied, 2);
});

test("delivers an upload the live site serves even when no content points at it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-live-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/other.jpg"]);

  const project = parseWxr(
    wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"), attachment(102, "2026/05/other.jpg")),
    { liveUrlSource: { urls: ["https://example.test/wp-content/uploads/2026/05/other.jpg"], sitemapRefs: [] } }
  );
  const delivered = await planFor(project, uploads);

  const entry = delivered.media.delivery?.entries.find((candidate) =>
    candidate.sourcePath.endsWith("other.jpg")
  );
  assert.equal(entry?.status, "copied", "a live upload URL is a URL the migration must not drop");
  assert.equal(delivered.coverage.entries[0]?.status, "routed");
});

test("retains waived delivery findings and keeps the report counts consistent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-waived-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/other.jpg"]);
  const parsed = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")), {
    config: { ignoreIssues: ["MEDIA_NOT_LOCAL"] }
  });
  const project = await planFor(parsed, uploads);

  const finding = project.issues.find((issue) => issue.code === "MEDIA_NOT_LOCAL");
  assert.equal(finding?.ignored, true);
  assert.ok(project.records[0]?.issues.includes(finding!));
  assert.equal(project.config?.decisions.ignoredIssues, 1);
  assert.equal(project.summary.warnings, 0);
  const report = renderReport(project);
  assert.match(report, /Waived/);
  assert.doesNotMatch(report, /<span class="status-chip status-chip--review"/);

  const reapplied = applyMediaDelivery(project, project.media.delivery!);
  assert.deepEqual(reapplied, project, "applying the same plan twice changes nothing");
});

test("keeps an explicit empty alt attribute", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-decorative-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo.jpg"]);
  const project = await planFor(parseWxr(wxrDocument(
    page(`<img src="https://example.test${photoPath}" alt="">`),
    attachment(101, "2026/05/photo.jpg")
  )), uploads);
  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src/content/pages/example-page.md"), "utf8");
  assert.match(content, /alt=""/);
  assert.equal([...content.matchAll(/\balt=/g)].length, 1);
});

test("delivers every responsive image candidate and source tag", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-srcset-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, [
    "2026/05/photo.jpg", "2026/05/photo-300x200.jpg", "2026/05/photo.webp"
  ]);
  const project = await planFor(parseWxr(wxrDocument(
    page(`<picture><source srcset="https://example.test/wp-content/uploads/2026/05/photo.webp" type="image/webp"><img src="https://example.test${photoPath}" srcset="https://example.test/wp-content/uploads/2026/05/photo-300x200.jpg 300w, https://example.test${photoPath} 1200w"></picture>`),
    attachment(101, "2026/05/photo.jpg")
  )), uploads);
  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src/content/pages/example-page.md"), "utf8");
  assert.doesNotMatch(content, /example\.test\/wp-content/);
  assert.match(content, /photo-300x200\.jpg 300w/);
  await readFile(join(output, "public/wp-content/uploads/2026/05/photo-300x200.jpg"));
  await readFile(join(output, "public/wp-content/uploads/2026/05/photo.webp"));
});

test("rolls an attachment up to its strongest delivery status", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-status-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/photo-300x200.jpg"]);
  const project = parseWxr(wxrDocument(
    page('<img src="https://example.test/wp-content/uploads/2026/05/photo-300x200.jpg">'),
    attachment(101, "2026/05/photo.jpg")
  ));
  const delivered = applyMediaDelivery(project, await planMediaDelivery(project, {
    uploadsDirectory: uploads, copyUnusedAssets: true
  }));
  assert.equal(delivered.media.delivery?.summary.missing, 1);
  assert.equal(delivered.media.delivery?.summary.copied, 1);
  assert.equal(delivered.media.assets[0]?.delivery?.status, "copied");
  assert.equal(delivered.media.assets[0]?.delivery?.outputPath, "/wp-content/uploads/2026/05/photo-300x200.jpg");
  assert.equal(delivered.summary.warnings, 0, "an unused missing original does not affect this page");
});

test("does not copy a symlink that points outside the supplied uploads directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-symlink-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploads = await uploadsDirectoryWith(root, ["2026/05/other.jpg"]);
  const secret = join(root, "private.jpg");
  await writeFile(secret, "private bytes");
  await symlink(secret, join(uploads, "2026/05/photo.jpg"));
  const project = await planFor(parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg"))), uploads);
  assert.deepEqual(project.media.delivery?.copies, []);
  assert.equal(project.media.delivery?.entries[0]?.status, "missing");
});

test("validates and sanitizes the media base URL", async () => {
  const project = parseWxr(wxrDocument(imagePage, attachment(101, "2026/05/photo.jpg")));
  for (const baseUrl of ["/uploads", "https://", "javascript:alert(1)"]) {
    await assert.rejects(planMediaDelivery(project, { baseUrl }), /http or https URL/);
  }
  const plan = await planMediaDelivery(project, {
    baseUrl: "https://private-user:private-password@media.example.test/uploads/?token=private#fragment"
  });
  assert.equal(plan.entries[0]?.url, "https://media.example.test/uploads/2026/05/photo.jpg");
  assert.doesNotMatch(JSON.stringify(mediaDeliveryRecord(plan)), /private|token|fragment/);
});

test("copies filenames with URL escapes and writes a usable image URL", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-escaped-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = "2026/05/photo #1%.jpg";
  const path = "/wp-content/uploads/2026/05/photo%20%231%25.jpg";
  const uploads = await uploadsDirectoryWith(root, [file]);
  const project = await planFor(parseWxr(wxrDocument(
    page(`<img src="https://example.test${path}">`), attachment(101, file)
  ), { liveUrlSource: { urls: [`https://example.test${path}`], sitemapRefs: [] } }), uploads);
  assert.equal(project.media.delivery?.summary.copied, 1);
  assert.equal(project.coverage.entries[0]?.status, "routed");
  const output = join(root, "site");
  await generateAstroProject(project, output);
  await readFile(join(output, "public/wp-content/uploads", file));
  const content = await readFile(join(output, "src/content/pages/example-page.md"), "utf8");
  assert.ok(content.includes(`src="${path}"`));
});

test("withholds unsafe Elementor image URLs when media delivery is enabled", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wp-migrate-core-media-unsafe-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const widget = { id: "unsafe", elType: "widget", widgetType: "image", settings: { image: { url: "javascript:alert(1)" } } };
  const item = page("").replace("</item>", `<wp:postmeta><wp:meta_key>_elementor_data</wp:meta_key><wp:meta_value><![CDATA[${JSON.stringify([widget])}]]></wp:meta_value></wp:postmeta></item>`);
  const parsed = parseWxr(wxrDocument(item));
  const project = applyMediaDelivery(parsed, await planMediaDelivery(parsed, { baseUrl: "https://media.example.test/uploads" }));
  const output = join(root, "site");
  await generateAstroProject(project, output);
  const content = await readFile(join(output, "src/content/pages/example-page.md"), "utf8");
  assert.doesNotMatch(content, /javascript:|<img/);
  assert.match(content, /Content review required/);
});
