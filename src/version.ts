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

/**
 * The Payload release the generated CMS bundle is written against. It is
 * recorded in the manifest the way `ssrwireDependency` is, so a bundle says
 * which version its collections, importer and admin host were built for.
 *
 * It is an exact version on purpose: `@payloadcms/next` declares its `payload`
 * peer as that same exact version, so a bundle that floats the two apart
 * installs with a peer conflict.
 */
export const payloadDependency = "3.90.2";

/**
 * The Next.js and React ranges the generated admin host is written against,
 * from the peer ranges `@payloadcms/next` and `@payloadcms/ui` declare.
 */
export const payloadAdminDependencies: Readonly<Record<string, string>> = {
  "@payloadcms/next": payloadDependency,
  "@payloadcms/richtext-lexical": payloadDependency,
  "@payloadcms/db-sqlite": payloadDependency,
  graphql: "^16.8.1",
  next: "^16.3.3",
  react: "^19.2.1",
  "react-dom": "^19.2.1"
};
