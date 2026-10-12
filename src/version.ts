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

/**
 * The Pruvious release the generated Nuxt bundle is written against. Pruvious
 * tracks the Nuxt minor it integrates with, so both are pinned to the same
 * range: a bundle that floats them apart can install an incompatible pair.
 */
export const pruviousDependency = "~3.9.0";

/**
 * The Nuxt range the generated Pruvious bundle is written against, kept in
 * step with `pruviousDependency`.
 */
export const pruviousNuxtDependency = "~3.9.0";

/** Pruvious 3.9 imports these directly; keep StarterKit's extensions on its core version. */
export const pruviousEditorDependencies: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "core", "extension-blockquote", "extension-bold", "extension-bullet-list", "extension-code",
    "extension-code-block", "extension-document", "extension-dropcursor", "extension-gapcursor",
    "extension-hard-break", "extension-heading", "extension-history", "extension-horizontal-rule",
    "extension-italic", "extension-list-item", "extension-ordered-list", "extension-paragraph",
    "extension-strike", "extension-text"
  ].map((name) => [`@tiptap/${name}`, "2.1.13"])
);
