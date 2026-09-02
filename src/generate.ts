import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import type { ContentRecord, MigrationIssue, MigrationNode, MigrationProject } from "./types.js";

const GENERATOR_NAME = "wp-migrate-core";
const GENERATOR_VERSION = "0.1.0-demo";
const SAFE_ELEMENTOR_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

interface GeneratedRecord {
  readonly record: ContentRecord;
  readonly collection: "pages" | "posts";
  readonly fileName: string;
  readonly route: string;
  readonly sourceUrl: string;
}

export async function generateAstroProject(
  project: MigrationProject,
  outDir: string
): Promise<void> {
  const outputDirectory = await prepareOutputDirectory(outDir);
  const records = prepareRecords(project);

  const files = new Map<string, string>([
    ["package.json", renderPackageJson(project)],
    ["astro.config.mjs", renderAstroConfig()],
    ["tsconfig.json", renderTsConfig()],
    ["src/content.config.ts", renderContentConfig()],
    ["src/pages/[...slug].astro", renderCatchAllPage()],
    ["src/layouts/Layout.astro", renderLayout()],
    ["src/styles/global.css", renderStyles()],
    ["public/robots.txt", renderRobotsTxt()],
    ["migration/issues.json", renderIssues(project.issues)],
    ["migration/manifest.json", renderManifest(project, records)],
    ["README.md", renderReadme(project)]
  ]);

  for (const generated of records) {
    files.set(
      `src/content/${generated.collection}/${generated.fileName}`,
      renderContentRecord(generated)
    );
  }

  for (const [relativePath, contents] of files) {
    await writeNewFile(outputDirectory, relativePath, contents);
  }
}

async function prepareOutputDirectory(outDir: string): Promise<string> {
  if (outDir.trim().length === 0) {
    throw new Error("An explicit output directory is required.");
  }

  const outputDirectory = resolve(outDir);
  const root = parse(outputDirectory).root;

  if (outputDirectory === root || outputDirectory === resolve(process.cwd())) {
    throw new Error(`Refusing to generate into unsafe output directory: ${outputDirectory}`);
  }

  try {
    const details = await stat(outputDirectory);
    if (!details.isDirectory()) {
      throw new Error(`Output path exists and is not a directory: ${outputDirectory}`);
    }

    const existing = await readdir(outputDirectory);
    if (existing.length > 0) {
      throw new Error(`Output directory is not empty: ${outputDirectory}`);
    }
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(outputDirectory, { recursive: true });
  }

  return outputDirectory;
}

function prepareRecords(project: MigrationProject): GeneratedRecord[] {
  const usedFileNames = new Set<string>();
  const usedRoutes = new Set<string>();

  return project.records.map((record) => {
    const collection = record.type === "page" ? "pages" : "posts";
    const route = normalizeRoute(record.route ?? `/${record.slug}/`);

    if (usedRoutes.has(route)) {
      throw new Error(`Cannot generate duplicate route: ${route}`);
    }
    usedRoutes.add(route);

    const stem = safeFileStem(record.slug || record.sourceId);
    let fileName = `${stem}.md`;
    let suffix = 2;
    while (usedFileNames.has(`${collection}/${fileName}`)) {
      fileName = `${stem}-${suffix}.md`;
      suffix += 1;
    }
    usedFileNames.add(`${collection}/${fileName}`);

    return {
      record,
      collection,
      fileName,
      route,
      sourceUrl: sourceUrlFor(project, record, route)
    };
  });
}

function renderPackageJson(project: MigrationProject): string {
  const packageName = `${safeFileStem(project.site.title)}-astro`;
  return renderJson({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "astro dev",
      build: "astro build",
      preview: "astro preview"
    },
    dependencies: {
      astro: "^5.13.0"
    }
  });
}

function renderAstroConfig(): string {
  return `import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  trailingSlash: "always"
});
`;
}

function renderTsConfig(): string {
  return renderJson({
    extends: "astro/tsconfigs/strict",
    include: [".astro/types.d.ts", "**/*"],
    exclude: ["dist"]
  });
}

function renderContentConfig(): string {
  return `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const migrationSchema = z.object({
  title: z.string(),
  route: z.string(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  categories: z.array(z.string()).default([])
});

export const collections = {
  pages: defineCollection({
    loader: glob({ base: "./src/content/pages", pattern: "**/*.{md,mdx}" }),
    schema: migrationSchema
  }),
  posts: defineCollection({
    loader: glob({ base: "./src/content/posts", pattern: "**/*.{md,mdx}" }),
    schema: migrationSchema
  })
};
`;
}

function renderCatchAllPage(): string {
  return `---
import { getCollection, render } from "astro:content";
import Layout from "../layouts/Layout.astro";

export async function getStaticPaths() {
  const entries = [
    ...(await getCollection("pages")),
    ...(await getCollection("posts"))
  ];

  return entries.map((entry) => ({
    params: {
      slug: entry.data.route === "/"
        ? undefined
        : entry.data.route.replace(/^\\/|\\/$/g, "")
    },
    props: { entry }
  }));
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---

<Layout
  title={entry.data.title}
>
  <Content />
</Layout>
`;
}

function renderLayout(): string {
  return `---
import "../styles/global.css";

interface Props {
  title: string;
}

const { title } = Astro.props;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="generator" content={Astro.generator} />
    <meta name="robots" content="noindex, nofollow" />
    <title>{title}</title>
  </head>
  <body>
    <main>
      <article>
        <slot />
      </article>
    </main>
  </body>
</html>
`;
}

function renderStyles(): string {
  return `:root {
  color: #171717;
  background: #f5f5f3;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body { margin: 0; }
main { width: min(920px, calc(100% - 2rem)); margin: 3rem auto; }
article {
  padding: clamp(1.25rem, 4vw, 3rem);
  background: white;
  border: 1px solid #deded8;
  border-radius: 0.75rem;
}
img { max-width: 100%; height: auto; }
.content-review {
  display: grid;
  gap: 0.35rem;
  margin: 0 0 1rem;
  padding: 1rem;
  border: 1px solid #b98a18;
  border-radius: 0.5rem;
  background: #fff8dc;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
}

function renderRobotsTxt(): string {
  return "User-agent: *\nDisallow: /\n";
}

function renderIssues(issues: readonly MigrationIssue[]): string {
  return renderJson(
    issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      sourceId: issue.sourceId,
      ...(issue.route === undefined ? {} : { route: issue.route }),
      ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
      title: issue.title,
      message: issue.message,
      requiredAction: issue.requiredAction
    }))
  );
}

function renderManifest(project: MigrationProject, records: readonly GeneratedRecord[]): string {
  return renderJson({
    schemaVersion: "0.1",
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
      target: "astro"
    },
    sourceSite: project.site,
    summary: project.summary,
    targets: {
      astro: { enabled: true, label: "Astro" },
      next: { enabled: false, label: "Next.js" },
      nuxt: { enabled: false, label: "Nuxt" }
    },
    records: records.map(({ record, collection, fileName, route, sourceUrl }) => ({
      sourceId: record.sourceId,
      wordpressId: record.wordpressId,
      postType: record.type,
      sourceEditor: record.editor,
      route,
      sourceUrl,
      outputFile: `src/content/${collection}/${fileName}`
    }))
  });
}

function renderReadme(project: MigrationProject): string {
  return `# ${project.site.title} — Astro migration handoff

Generated from ${project.site.url ?? "a WordPress export"} by ${GENERATOR_NAME} ${GENERATOR_VERSION}.

This is a rough migration output, not a production-ready replacement. The generator preserves source content where it can and emits explicit repair markers where it cannot.

## Run locally

\`\`\`bash
npm install
npm run dev
\`\`\`

## Handoff sequence

1. Open \`migration/issues.json\` and resolve every blocker.
2. Review warnings and accepted legacy HTML instead of assuming conversion fidelity.
3. Compare every generated route with the original WordPress route on desktop and mobile.
4. Replace forms, dynamic widgets, shortcodes and plugin behavior deliberately.
5. Run \`npm run build\` only after the repair queue is understood.

Generated content lives in \`src/content/pages\` and \`src/content/posts\`. Route mappings and source IDs live in \`migration/manifest.json\`.

Astro is the only enabled renderer in 0.1.0-demo. Next.js and Nuxt appear in the migration manifest as planned, disabled targets; this output contains no fake compatibility layer for either framework.
`;
}

function renderContentRecord(generated: GeneratedRecord): string {
  const { record, route } = generated;
  const frontmatter = [
    "---",
    `title: ${yamlString(record.title)}`,
    `route: ${yamlString(route)}`,
    ...(record.author ? [`author: ${yamlString(record.author)}`] : []),
    ...(record.publishedAt ? [`publishedAt: ${yamlString(record.publishedAt)}`] : []),
    `categories: ${JSON.stringify(
      record.terms.filter((term) => term.domain === "category").map((term) => term.name)
    )}`,
    "---"
  ].join("\n");

  const body = ensureTitleH1(renderRecordBody(record), record.title);
  return `${frontmatter}\n\n${body.trim()}\n`;
}

function renderRecordBody(record: ContentRecord): string {
  if (record.rawContent.trim().length > 0) {
    const content = renderSafeRawHtml(record.rawContent);
    if (content === undefined) {
      return renderUnsafeMarkupRepair();
    }
    return record.issues.some((issue) => issue.code === "SHORTCODE_UNSUPPORTED")
      ? replaceUnsupportedShortcodes(content)
      : content;
  }

  const renderedNodes = record.nodes.map(renderNode).filter(Boolean).join("\n\n");
  if (renderedNodes.length > 0) {
    return renderedNodes;
  }

  return renderRepairMarker("No renderable content was exported for this record.");
}

function renderNode(node: MigrationNode): string {
  if (node.rawHtml?.trim()) {
    return renderSafeRawHtml(node.rawHtml) ?? renderUnsafeMarkupRepair();
  }

  if (
    node.source === "elementor" &&
    (node.conversion === "native" || node.conversion === "legacy-html")
  ) {
    const native = renderNativeElementorNode(node);
    if (native !== undefined) {
      return native;
    }
  }

  const children = node.children.map(renderNode).filter(Boolean).join("\n");

  if (node.conversion === "manual" || node.conversion === "blocked") {
    const marker = renderRepairMarker(repairMessageForNode(node));
    return children ? `${marker}\n${children}` : marker;
  }

  if (children) {
    return children;
  }

  return renderRepairMarker(repairMessageForNode(node));
}

function renderNativeElementorNode(node: MigrationNode): string | undefined {
  const children = node.children.map(renderNode).filter(Boolean).join("\n");

  switch (node.sourceType) {
    case "container":
    case "section":
      return `<section>\n${children}\n</section>`;
    case "column":
      return `<div>\n${children}\n</div>`;
    case "heading": {
      const title = getString(node.attributes, "title");
      const requestedLevel = getString(node.attributes, "header_size");
      const level = /^h[1-6]$/.test(requestedLevel ?? "") ? requestedLevel : "h2";
      return title ? `<${level}>${escapeHtml(title)}</${level}>` : undefined;
    }
    case "text-editor": {
      const content = getString(node.attributes, "editor");
      return content === undefined ? undefined : renderSafeRawHtml(content) ?? renderUnsafeMarkupRepair();
    }
    case "button": {
      const text = getString(node.attributes, "text");
      const href = getNestedString(node.attributes, "link", "url");
      const safeHref = href === undefined ? undefined : safeHrefForElementorButton(href);
      return text && safeHref !== undefined
        ? `<p><a href="${escapeHtmlAttribute(safeHref)}">${escapeHtml(text)}</a></p>`
        : renderRepairMarker("This link needs review before publication.");
    }
    case "image":
      return renderRepairMarker("This image needs to be added from a verified local asset before publication.");
    case "divider":
      return "<hr />";
    case "spacer":
      return '<div aria-hidden="true"></div>';
    default:
      return undefined;
  }
}

function renderRepairMarker(message: string): string {
  return `<aside class="content-review">
  <strong>Content review required</strong>
  <span>${escapeHtml(message)}</span>
</aside>`;
}

function renderUnsafeMarkupRepair(): string {
  return renderRepairMarker("This part of the page was withheld pending review.");
}

function repairMessageForNode(node: MigrationNode): string {
  if (node.source === "elementor" && node.sourceType === "image") {
    return "This image needs to be added from a verified local asset before publication.";
  }
  if (node.source === "elementor" && node.sourceType === "button") {
    return "This link needs review before publication.";
  }
  return "This part of the page needs review before publication.";
}

function ensureTitleH1(body: string, title: string): string {
  if (hasH1(body)) {
    return body;
  }

  const heading = title.trim() || "Untitled page";
  return `<h1>${escapeHtml(heading)}</h1>\n\n${body}`;
}

function hasH1(value: string): boolean {
  return (
    /<\s*h1(?:\s|\/?>)/i.test(value) ||
    /^(?: {0,3})#(?!#)\s+\S/m.test(value) ||
    /^(?: {0,3})\S[^\n]*\n(?: {0,3})={3,}\s*$/m.test(value)
  );
}

function renderSafeRawHtml(value: string): string | undefined {
  return hasUnsafeRawMarkup(value) ? undefined : withholdSourceMedia(value);
}

function withholdSourceMedia(value: string): string {
  return value.replace(
    /<(?:img|source)\b[^>]*>/gi,
    () => renderRepairMarker("This source media needs to be added as a verified local asset before publication.")
  );
}

function replaceUnsupportedShortcodes(value: string): string {
  return value
    .replace(
      /\[(?!\/)([a-z][a-z0-9_-]*)(?:\s[^\]]*)?\]/gi,
      (_match, shortcode: string) =>
        renderRepairMarker(`Shortcode [${shortcode}] needs a deliberate replacement before publication.`)
    )
    .replace(/\[\/[a-z][a-z0-9_-]*\]/gi, "");
}

function hasUnsafeRawMarkup(value: string): boolean {
  const decoded = decodeHtmlEntitiesForSafety(value);

  return (
    /<\s*\/?\s*(?:applet|base|embed|form|iframe|input|link|math|meta|object|script|select|style|svg|textarea)\b/i.test(decoded) ||
    /\bon[a-z0-9:_-]+\s*=/i.test(decoded) ||
    /\b(?:href|src|srcset|action|formaction|poster|xlink:href)\s*=\s*["']?\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:/i.test(decoded) ||
    /\bstyle\s*=\s*[^>]*(?:expression\s*\(|url\s*\(\s*["']?\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:)/i.test(decoded) ||
    /\[[^\]]*\]\s*\(\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|f\s*i\s*l\s*e)\s*:/i.test(decoded)
  );
}

function safeHrefForElementorButton(value: string): string | undefined {
  const href = value.trim();
  if (href === "" || /[\u0000-\u001f\u007f-\u009f]/.test(href)) {
    return undefined;
  }

  const decodedHref = decodeHtmlEntitiesForSafety(href).trim();
  if (decodedHref === "" || /[\u0000-\u001f\u007f-\u009f]/.test(decodedHref)) {
    return undefined;
  }
  const normalized = decodedHref.replace(/\s+/g, "");
  if (normalized.startsWith("//") || normalized.startsWith("\\")) {
    return undefined;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return scheme === undefined || SAFE_ELEMENTOR_HREF_SCHEMES.has(scheme) ? decodedHref : undefined;
}

function decodeHtmlEntitiesForSafety(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded
      .replace(/&colon;/gi, ":")
      .replace(/&newline;/gi, "\n")
      .replace(/&tab;/gi, "\t")
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hexadecimal: string) =>
        decodeHtmlCodePoint(hexadecimal, 16)
      )
      .replace(/&#([0-9]+);?/g, (_match, decimal: string) => decodeHtmlCodePoint(decimal, 10))
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");

    if (next === decoded) {
      return next;
    }
    decoded = next;
  }
  return decoded;
}

function decodeHtmlCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : "\ufffd";
}

function getString(values: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedString(
  values: Readonly<Record<string, unknown>>,
  key: string,
  nestedKey: string
): string | undefined {
  const value = values[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nested = Reflect.get(value, nestedKey);
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function normalizeRoute(route: string): string {
  let pathname = route.trim();
  if (/^https?:\/\//i.test(pathname)) {
    pathname = new URL(pathname).pathname;
  }
  pathname = pathname.split(/[?#]/, 1)[0] ?? "/";
  pathname = pathname.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const segments = pathname.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function safeFileStem(value: string): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || "migrated-content";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sourceUrlFor(project: MigrationProject, record: ContentRecord, route: string): string {
  const candidate = record.route ?? route;
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  if (project.site.url !== undefined) {
    try {
      return new URL(candidate, ensureTrailingSlash(project.site.url)).toString();
    } catch {
      // Preserve the route below; malformed source URLs belong in the repair report.
    }
  }
  return candidate;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeNewFile(root: string, relativePath: string, contents: string): Promise<void> {
  const destination = resolve(root, relativePath);
  if (!destination.startsWith(`${root}/`)) {
    throw new Error(`Refusing to write outside output directory: ${relativePath}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, { encoding: "utf8", flag: "wx" });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
