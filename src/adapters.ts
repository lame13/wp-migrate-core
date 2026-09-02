import type { MigrationProject, OutputTarget } from "./types.js";

export interface TargetAdapter {
  readonly target: OutputTarget;
  readonly enabled: boolean;
  readonly label: string;
  generate(project: MigrationProject, outputDirectory: string): Promise<void>;
}

export const targetAvailability = {
  astro: { target: "astro", label: "Astro", enabled: true },
  next: { target: "next", label: "Next.js", enabled: false },
  nuxt: { target: "nuxt", label: "Nuxt", enabled: false }
} as const satisfies Record<OutputTarget, Omit<TargetAdapter, "generate">>;

export function assertTargetEnabled(target: OutputTarget): void {
  const availability = targetAvailability[target];
  if (!availability.enabled) {
    throw new Error(`${availability.label} is planned but disabled in 0.1.0-demo. Use --target astro.`);
  }
}
