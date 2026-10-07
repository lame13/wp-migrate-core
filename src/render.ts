import { mkdir, stat, readdir, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

/**
 * Small helpers every destination generator shares. A static-site handoff and
 * a CMS bundle write different files, but they agree on how a file is named,
 * how JSON is serialized, and how an output directory is opened safely.
 */

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

/** A filesystem- and URL-safe stem, so a title can name a file or a slug. */
export function safeFileStem(value: string): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || "migrated-content";
}

/**
 * Open a destination directory for writing. The directory is created when it
 * is missing and must be empty otherwise, so a generator never merges its
 * output into a directory someone else is using.
 */
export async function prepareOutputDirectory(outDir: string): Promise<string> {
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

export async function writeNewFile(root: string, relativePath: string, contents: string): Promise<void> {
  const destination = resolve(root, relativePath);
  if (!destination.startsWith(`${root}/`)) {
    throw new Error(`Refusing to write outside output directory: ${relativePath}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, { encoding: "utf8", flag: "wx" });
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
