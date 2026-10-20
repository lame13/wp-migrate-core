import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A local cache keyed by the exact input, prompt version and model. It makes a
 * repeated assist run cheap and, more importantly, stable while a person is
 * reviewing the same suggestions.
 */
export class AiCache {
  readonly #directory: string;
  readonly #enabled: boolean;
  #hits = 0;
  #misses = 0;

  constructor(directory: string, enabled: boolean) {
    this.#directory = directory;
    this.#enabled = enabled;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.#enabled) return undefined;
    try {
      const contents = await readFile(this.#path(key), "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null || !("value" in parsed)) {
        this.#misses += 1;
        return undefined;
      }
      this.#hits += 1;
      return (parsed as { readonly value: T }).value;
    } catch {
      this.#misses += 1;
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.#enabled) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await writeFile(this.#path(key), JSON.stringify({ value }), { encoding: "utf8", mode: 0o600 });
  }

  key(namespace: string, value: unknown): string {
    const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return `${namespace.replace(/[^A-Za-z0-9_-]+/g, "-")}-${hash}`;
  }

  #path(key: string): string {
    return join(this.#directory, `${key}.json`);
  }
}
