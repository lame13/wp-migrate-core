import { generateAstroProject } from "./generate.js";
import { generateNextProject } from "./next.js";
import { generatePayloadBundle } from "./payload.js";
import { generatePruviousBundle } from "./pruvious.js";
import { SUPPORTED_TARGETS, isOutputTarget, targetDefinitions } from "./targets.js";
import type { TargetDefinition } from "./targets.js";
import type { MigrationProject, OutputTarget } from "./types.js";

/**
 * A destination generator plus the facts every part of the tool needs about
 * it: what it is called, whether this release can write it, and what kind of
 * destination it is. A CMS target generates a bundle and an importer; a
 * static-site target generates pages.
 */
export interface DestinationGenerateOptions {
  /** Rewrite same-site links to point at the generated routes. */
  readonly rewriteLinks?: boolean;
  /** Write output ready to be indexed, where the destination supports it. */
  readonly publishReady?: boolean;
}

export interface TargetAdapter extends TargetDefinition {
  generate(project: MigrationProject, outputDirectory: string, options?: DestinationGenerateOptions): Promise<void>;
}

/**
 * The enabled targets, as a sentence a refusal can carry. It is derived from
 * the registry so a target that is implemented in a later release joins the
 * hint without anyone remembering to edit the message.
 */
function enabledTargetsHint(): string {
  const names = SUPPORTED_TARGETS.filter((target) => targetDefinitions[target].enabled);
  const flags = names.map((target) => `--target ${target}`);
  if (flags.length === 1) return flags[0] as string;
  return `${flags.slice(0, -1).join(", ")} or ${flags[flags.length - 1]}`;
}

/**
 * A target this release cannot write yet. It is registered rather than left
 * out so the CLI, the manifest and the report can say it is planned, and so
 * `assertTargetEnabled` refuses it with a reason instead of an unknown name.
 */
function plannedOnly(
  target: OutputTarget
): (project: MigrationProject, outputDirectory: string, options?: DestinationGenerateOptions) => Promise<void> {
  return async () => {
    throw new Error(
      `${targetDefinitions[target].label} is planned but not available in this release. Use ${enabledTargetsHint()}.`
    );
  };
}

export const targetAdapters: Readonly<Record<OutputTarget, TargetAdapter>> = {
  astro: { ...targetDefinitions.astro, generate: generateAstroProject },
  next: { ...targetDefinitions.next, generate: generateNextProject },
  payload: { ...targetDefinitions.payload, generate: generatePayloadBundle },
  pruvious: { ...targetDefinitions.pruvious, generate: generatePruviousBundle },
  nuxt: { ...targetDefinitions.nuxt, generate: plannedOnly("nuxt") },
  svelte: { ...targetDefinitions.svelte, generate: plannedOnly("svelte") }
};

/**
 * The public shape callers have always used: target, label, enabled. It is
 * derived from the adapters so the two cannot drift.
 */
export const targetAvailability = Object.fromEntries(
  SUPPORTED_TARGETS.map((target) => {
    const adapter = targetAdapters[target];
    return [target, { target: adapter.target, kind: adapter.kind, label: adapter.label, enabled: adapter.enabled }];
  })
) as unknown as Readonly<
  Record<OutputTarget, { target: OutputTarget; kind: TargetDefinition["kind"]; label: string; enabled: boolean }>
>;

export function assertTargetEnabled(target: OutputTarget): void {
  const availability = targetAdapters[target];
  if (!availability.enabled) {
    throw new Error(`${availability.label} is planned but not available in this release. Use ${enabledTargetsHint()}.`);
  }
}

/**
 * The one place a command turns a target name into output. The boundary is
 * deliberately small: a caller names a target, this checks it can be written,
 * and the adapter decides what files that means.
 */
export async function generateForTarget(
  target: OutputTarget,
  project: MigrationProject,
  outputDirectory: string,
  options?: DestinationGenerateOptions
): Promise<void> {
  assertTargetEnabled(target);
  await targetAdapters[target].generate(project, outputDirectory, options);
}

export { isOutputTarget };
