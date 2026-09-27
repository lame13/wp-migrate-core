import { createRequire } from "node:module";

// Resolve from dist/src in both the checkout and the installed npm package.
const metadata: {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
} = createRequire(import.meta.url)("../../package.json");

export const packageVersion = metadata.version;

/**
 * The SSRWire range this release is written against, so the check files a
 * handoff generates cannot drift from the dependency this package installs.
 */
export const ssrwireDependency = metadata.dependencies?.["ssrwire"] ?? "^0.5.0";
