import {
  MIGRATION_CONFIG_ARCHIVE_KEYS,
  MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES,
  MIGRATION_CONFIG_FAILURE_THRESHOLDS,
  MIGRATION_CONFIG_KEYS,
  MIGRATION_CONFIG_MEDIA_KEYS,
  MIGRATION_CONFIG_POST_TYPE_KEYS,
  MIGRATION_CONFIG_SITE_KEYS,
  defaultMigrationConfigFileName,
  migrationConfigSchemaVersion
} from "./config.js";
import { MIGRATION_ISSUE_CODES } from "./types.js";
import type { OutputTarget } from "./types.js";

/**
 * The 1.0 contract.
 *
 * Everything in this module is a promise the release makes on purpose, in one
 * place, so a caller can read it without reading the source and the test suite
 * can check it without trusting the prose. It covers three things:
 *
 * - **API stability.** The names this package exports are frozen: a minor
 *   release may add a name, and a name is removed or changed only after a
 *   deprecation release and then only in a major release. `apiStability` says
 *   whether that promise is still a pre-release one (`pre-release`) or a
 *   published one (`stable`); 1.0.0 is the release that flips it.
 * - **Artifact versions.** Every generated file carries its own schema
 *   version, independent of the package version, and this registry is the only
 *   place the generators read those versions from. A file's shape moves when
 *   its own number moves, never because the package did.
 * - **The migration config schema.** The config format is frozen at
 *   `migrationConfigSchemaVersion` for the whole 1.x line, and the JSON Schema
 *   below is generated from the same key lists the parser validates against, so
 *   editor help and the parser cannot disagree about a setting name.
 *
 * `test/contracts.test.ts` and `test/api-surface.test.ts` assert all three:
 * that the exported names match a frozen list, that the artifacts a real run
 * writes carry the versions in this registry, and that `docs/artifacts.md`,
 * `docs/api.md` and `docs/compatibility.md` document every entry.
 */

/**
 * What this package promises about its surface. `stable` means the exported
 * names are covered by semantic versioning; the generators' file formats are
 * versioned separately by `artifactContracts`. This release is `pre-release`:
 * the surface is already frozen and test-enforced, and 1.0.0 is what turns the
 * freeze into a published promise.
 */
export const apiStability = "pre-release" as const;

/** The contract revision this release implements: the 1.0 surface, frozen early. */
export const apiContractVersion = "1.0" as const;

/** A generated file this package writes or reads, named for the question it answers. */
export type ArtifactId =
  | "issues"
  | "media"
  | "redirects"
  | "links"
  | "coverage"
  | "archives"
  | "menus"
  | "manifestAstro"
  | "manifestNext"
  | "manifestPayload"
  | "manifestPruvious"
  | "nextRoutes"
  | "payloadDrop"
  | "payloadRedirects"
  | "pruviousDrop"
  | "migrationConfig"
  | "importReport"
  | "verification";

/**
 * One artifact's contract: where it lives, which `schemaVersion` it carries,
 * and which destinations write it. `schemaVersion: null` means the file is an
 * unversioned list whose entries are already sanitized, which is why
 * `migration/issues.json` needs no number of its own.
 */
export interface ArtifactContract {
  readonly id: ArtifactId;
  /** The file, relative to the handoff, the bundle, or the working directory. */
  readonly file: string;
  /** The version the file's own shape carries, or null for an unversioned list. */
  readonly schemaVersion: string | null;
  /**
   * The destinations whose output carries this file. Empty for a file the CLI
   * or a generated importer writes rather than a destination.
   */
  readonly destinations: readonly OutputTarget[];
  /** One line: what the file answers. */
  readonly summary: string;
}

const everyDestination: readonly OutputTarget[] = ["astro", "payload", "pruvious"];

/**
 * Every versioned artifact, in the order the documentation lists them. The
 * generators read the numbers from here, and nothing hard-codes one: a release
 * that changes a file's shape changes one line in this list, and the contract
 * test fails until the documentation says the same thing.
 */
export const artifactContracts: readonly ArtifactContract[] = [
  {
    id: "issues",
    file: "migration/issues.json",
    schemaVersion: null,
    destinations: everyDestination,
    summary: "The repair queue: every warning and blocker with its required action."
  },
  {
    id: "media",
    file: "migration/media.json",
    schemaVersion: "0.7",
    destinations: everyDestination,
    summary: "Referenced media, matching attachments, alt text, and where each file is served from."
  },
  {
    id: "redirects",
    file: "migration/redirects.json",
    schemaVersion: "0.2",
    destinations: everyDestination,
    summary: "Old permalinks, proposed routes, path rules, and URLs left without a target."
  },
  {
    id: "links",
    file: "migration/links.json",
    schemaVersion: "0.3",
    destinations: everyDestination,
    summary: "Same-site links, the rewrites the handoff proposes, and targets it cannot vouch for."
  },
  {
    id: "coverage",
    file: "migration/coverage.json",
    schemaVersion: "0.4",
    destinations: everyDestination,
    summary: "Every live URL supplied, compared with the routes and rules this plan has."
  },
  {
    id: "archives",
    file: "migration/archives.json",
    schemaVersion: "0.8",
    destinations: everyDestination,
    summary: "The archive and feed pages this run generated, and how each route was decided."
  },
  {
    id: "menus",
    file: "migration/menus.json",
    schemaVersion: "0.8",
    destinations: everyDestination,
    summary: "The navigation WordPress served, including entries nothing generated yet."
  },
  {
    id: "manifestAstro",
    file: "migration/manifest.json",
    schemaVersion: "0.9",
    destinations: ["astro"],
    summary: "WordPress ids, generated files and routes, and the destination block for Astro."
  },
  {
    id: "manifestNext",
    file: "migration/manifest.json",
    schemaVersion: "0.12",
    destinations: ["next"],
    summary: "WordPress ids, generated files and routes, and the destination block for Next.js."
  },
  {
    id: "manifestPayload",
    file: "migration/manifest.json",
    schemaVersion: "0.11",
    destinations: ["payload"],
    summary: "WordPress ids, collections, the drop, and the pinned Payload and admin versions."
  },
  {
    id: "manifestPruvious",
    file: "migration/manifest.json",
    schemaVersion: "0.11",
    destinations: ["pruvious"],
    summary: "WordPress ids, collections, the drop, and the pinned Pruvious and Nuxt versions."
  },
  {
    id: "payloadDrop",
    file: "import/content/index.json",
    schemaVersion: "0.9",
    destinations: ["payload"],
    summary: "The Payload drop's own index: which collection files the importer reads."
  },
  {
    id: "nextRoutes",
    file: "content/routes.json",
    schemaVersion: "0.12",
    destinations: ["next"],
    summary: "The Next app's route index: every prerendered route and the content file behind it."
  },
  {
    id: "payloadRedirects",
    file: "import/redirects.json",
    schemaVersion: "0.9",
    destinations: ["payload"],
    summary: "The redirects a Next front end reads, in the shape its config uses."
  },
  {
    id: "pruviousDrop",
    file: "import/content/index.json",
    schemaVersion: "0.11",
    destinations: ["pruvious"],
    summary: "The Pruvious drop's own index: which collection files the importer reads."
  },
  {
    id: "migrationConfig",
    file: defaultMigrationConfigFileName,
    schemaVersion: migrationConfigSchemaVersion,
    destinations: [],
    summary: "The decisions a run reads: routes, exclusions, waivers, post types, archives and media."
  },
  {
    id: "importReport",
    file: "migration-import.json",
    schemaVersion: "0.9",
    destinations: [],
    summary: "What a generated CMS importer did: created, updated, skipped, failed, unresolved."
  },
  {
    id: "verification",
    file: "migration-verification.json",
    schemaVersion: "0.9",
    destinations: [],
    summary: "The launch gate: content, media, links, canonical, robots, sitemap, delivery and import."
  }
];

/** The artifact versions, keyed by id, so a generator reads one number. */
export const artifactSchemaVersions: Readonly<Record<ArtifactId, string | null>> = Object.freeze(
  Object.fromEntries(artifactContracts.map((artifact) => [artifact.id, artifact.schemaVersion]))
) as Readonly<Record<ArtifactId, string | null>>;

/** The contract for one artifact. Throws rather than returning an unknown id. */
export function artifactContract(id: ArtifactId): ArtifactContract {
  const contract = artifactContracts.find((artifact) => artifact.id === id);
  if (contract === undefined) {
    throw new Error(`No artifact contract is declared for "${id}".`);
  }

  return contract;
}

/** The JSON Schema type a config setting accepts, in the form a JSON Schema file uses. */
interface JsonSchema {
  readonly [key: string]: unknown;
}

/**
 * A JSON Schema for `wp-migrate-core.config.json`, generated from the same key
 * lists `parseMigrationConfig` validates against. Editors and CI can use it to
 * check a config file before a run; the parser stays the authority, and this
 * schema describes exactly the settings it accepts.
 */
export const migrationConfigJsonSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://nikocodes.com/software/wp-migrate-core/wp-migrate-core.config.schema.json",
  title: "wp-migrate-core migration config",
  description:
    "The decisions a WordPress export cannot make on its own: routes, exclusions, reviewed findings, post types, archives and media.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: {
      const: migrationConfigSchemaVersion,
      description: `The config format this release reads. Omit it, or set it to "${migrationConfigSchemaVersion}".`
    },
    site: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, description: "Overrides the title the export carries." },
        url: {
          type: "string",
          pattern: "^https?://",
          description: "The origin the new site answers on, used for canonical URLs and the sitemap."
        }
      },
      propertyNames: { enum: MIGRATION_CONFIG_SITE_KEYS }
    },
    includeDrafts: {
      type: "boolean",
      description: "Also read non-published posts and pages. The default reads published content only."
    },
    keepSourceLinks: {
      type: "boolean",
      description: "Keep exported link targets instead of rewriting same-site links to generated routes."
    },
    failOn: {
      enum: MIGRATION_CONFIG_FAILURE_THRESHOLDS,
      description: "The minimum severity that makes a command exit unsuccessfully. Writes nothing extra."
    },
    routes: {
      type: "object",
      description:
        "Decided routes, keyed by a content id (wp:page:12), an exported path (/old-page/), a query permalink (?p=123) or the exported URL.",
      additionalProperties: { type: "string", pattern: "^/(?!/)" }
    },
    exclude: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Items to leave out of the handoff, by content id or exported URL."
    },
    ignoreIssues: {
      type: "array",
      items: { enum: MIGRATION_ISSUE_CODES },
      description: "Finding codes a reviewer has looked at and accepted, kept in the plan as ignored."
    },
    postTypes: {
      type: "object",
      additionalProperties: false,
      properties: {
        include: { type: "array", items: { type: "string", minLength: 1 } },
        exclude: { type: "array", items: { type: "string", minLength: 1 } }
      },
      propertyNames: { enum: MIGRATION_CONFIG_POST_TYPE_KEYS },
      description: "Which WordPress post types become content, and which to leave out."
    },
    archives: {
      type: "object",
      additionalProperties: false,
      properties: {
        taxonomies: { type: "boolean", description: "Generate the term archives WordPress served. Default on." },
        authors: { type: "boolean", description: "Generate the author archives WordPress served. Default on." },
        dates: { type: "boolean", description: "Generate date archives. Off unless asked for." },
        postsIndex: { type: "string", pattern: "^/(?!/)", description: "Where the posts index lives, such as /blog/." },
        perPage: { type: "integer", minimum: 1, description: "Posts per listing page, which decides the /page/2/ routes." },
        feeds: {
          type: "array",
          items: { type: "string", pattern: "^/(?!/)" },
          description: "Feed paths to write, such as /feed/."
        },
        attachmentPages: {
          enum: MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES,
          description: "What to do with the attachment pages WordPress generated."
        }
      },
      propertyNames: { enum: MIGRATION_CONFIG_ARCHIVE_KEYS },
      description: "The views WordPress generated from settings a WXR file does not carry."
    },
    media: {
      type: "object",
      additionalProperties: false,
      properties: {
        uploadsDir: {
          type: "string",
          minLength: 1,
          description: "A local copy of wp-content/uploads. A relative path is resolved from the config file."
        },
        baseUrl: {
          type: "string",
          pattern: "^https?://",
          description: "A host that already serves the uploads, instead of copying the files."
        },
        copyUnused: {
          type: "boolean",
          description: "Also deliver attachments no included content record references."
        }
      },
      propertyNames: { enum: MIGRATION_CONFIG_MEDIA_KEYS },
      description: "Where the files for the media inventory come from."
    }
  },
  propertyNames: { enum: MIGRATION_CONFIG_KEYS }
};
