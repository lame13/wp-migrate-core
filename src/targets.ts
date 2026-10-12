import type { DestinationKind, OutputTarget } from "./types.js";

/**
 * What kind of destination a target writes. A static-site target turns the
 * export into pages; a CMS target turns it into collections, a content and
 * media drop, and an importer that runs inside the destination project.
 */
export interface TargetDefinition {
  readonly target: OutputTarget;
  readonly kind: DestinationKind;
  readonly enabled: boolean;
  readonly label: string;
  readonly description: string;
  /**
   * Where the destination's own dev server answers. The paired SSRWire check
   * files list the generated routes at this origin, so a handoff ships a
   * preview check that runs as written instead of one a reader has to edit.
   */
  readonly previewOrigin: string;
  /** The command that serves `previewOrigin`, named in the generated check file. */
  readonly previewCommand: string;
}

/** Every target, in the order reports and the CLI list them. */
export const SUPPORTED_TARGETS: readonly OutputTarget[] = ["astro", "payload", "pruvious", "next", "nuxt", "svelte"];

export const targetDefinitions: Readonly<Record<OutputTarget, TargetDefinition>> = {
  astro: {
    target: "astro",
    kind: "static-site",
    enabled: true,
    label: "Astro",
    previewOrigin: "http://localhost:4321",
    previewCommand: "npm run preview",
    description:
      "A static Astro project with content, navigation and the archive pages WordPress served. Implemented."
  },
  payload: {
    target: "payload",
    kind: "cms",
    enabled: true,
    label: "Payload",
    previewOrigin: "http://localhost:3000",
    previewCommand: "npm run dev",
    description:
      "A Payload CMS bundle: collections, a content and media drop, and a generated importer you run inside the destination project. Implemented."
  },
  pruvious: {
    target: "pruvious",
    kind: "cms",
    enabled: true,
    label: "Pruvious",
    previewOrigin: "http://localhost:3000",
    previewCommand: "npm run dev",
    description:
      "A Pruvious CMS bundle for Nuxt: collections, a content and media drop, and a generated importer you run inside the Nuxt app. Implemented."
  },
  next: {
    target: "next",
    kind: "static-site",
    enabled: true,
    label: "Next.js",
    previewOrigin: "http://localhost:3000",
    previewCommand: "npm run dev",
    description:
      "A static-export Next.js app: content in JSON, routes prerendered at build time, and an out/ directory the launch gate reads. Implemented."
  },
  nuxt: {
    target: "nuxt",
    kind: "static-site",
    enabled: false,
    label: "Nuxt",
    previewOrigin: "http://localhost:3000",
    previewCommand: "npm run dev",
    description: "No standalone Nuxt output is included. The Pruvious bundle integrates with a Nuxt app; its front end is yours to build."
  },
  svelte: {
    target: "svelte",
    kind: "static-site",
    enabled: false,
    label: "Svelte",
    previewOrigin: "http://localhost:5173",
    previewCommand: "npm run dev",
    description: "A real but non-priority static target, planned after the CMS destinations."
  }
};

export function isOutputTarget(value: string): value is OutputTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(value);
}

/**
 * The manifest's `targets` block: what each destination is and whether this
 * release can write it. Kept next to the definitions so the manifest, the
 * report and the CLI cannot disagree about a target.
 */
export function targetRecords(): Record<string, { enabled: boolean; kind: DestinationKind; label: string }> {
  const records: Record<string, { enabled: boolean; kind: DestinationKind; label: string }> = {};
  for (const target of SUPPORTED_TARGETS) {
    const definition = targetDefinitions[target];
    records[target] = { enabled: definition.enabled, kind: definition.kind, label: definition.label };
  }
  return records;
}
