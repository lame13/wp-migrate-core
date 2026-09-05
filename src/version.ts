import { createRequire } from "node:module";

// Resolve from dist/src in both the checkout and the installed npm package.
const metadata: { readonly version: string } = createRequire(import.meta.url)("../../package.json");

export const packageVersion = metadata.version;
