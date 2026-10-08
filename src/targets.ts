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
}

/** Every target, in the order reports and the CLI list them. */
export const SUPPORTED_TARGETS: readonly OutputTarget[] = ["astro", "payload", "next", "nuxt", "svelte"];

export const targetDefinitions: Readonly<Record<OutputTarget, TargetDefinition>> = {
  astro: {
    target: "astro",
    kind: "static-site",
    enabled: true,
    label: "Astro",
    description:
      "A static Astro project with content, navigation and the archive pages WordPress served. Implemented."
  },
  payload: {
    target: "payload",
    kind: "cms",
    enabled: true,
    label: "Payload",
    description:
      "A Payload CMS bundle: collections, a content and media drop, and a generated importer you run inside the destination project. Implemented."
  },
  next: {
    target: "next",
    kind: "static-site",
    enabled: false,
    label: "Next.js",
    description:
      "No standalone Next.js output is included. The Payload bundle integrates with a Next app; its front end is yours to build."
  },
  nuxt: {
    target: "nuxt",
    kind: "static-site",
    enabled: false,
    label: "Nuxt",
    description: "A bare Nuxt target is planned but not implemented; Pruvious is the planned Nuxt destination."
  },
  svelte: {
    target: "svelte",
    kind: "static-site",
    enabled: false,
    label: "Svelte",
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
