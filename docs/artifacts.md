# Artifacts and their versions

Every file this tool writes carries its **own** schema version, independent of
the npm package version. A package release can change the code and leave every
file shape alone; a file's number only moves when that file's shape moves. The
registry in `src/contracts.ts` holds the numbers, the generators read them from
there, and `test/contracts.test.ts` generates a real handoff and checks that
what was written matches this page.

| Artifact | File | Version | Written by | What it answers |
| --- | --- | --- | --- | --- |
| `issues` | `migration/issues.json` | unversioned | every destination | The repair queue: every warning and blocker, with the action it needs. An unversioned list of sanitized findings, so it needs no number of its own. |
| `media` | `migration/media.json` | `0.7` | every destination | Which uploads the export references, which attachment each one matches, what alt text exists, and where the generated site serves every file from. |
| `redirects` | `migration/redirects.json` | `0.2` | every destination | Every source URL the export carries, the route or rule that answers it, and the URLs left without a target. |
| `links` | `migration/links.json` | `0.3` | every destination | Every same-site link, the rewrite the handoff proposes, and the targets this export cannot vouch for. |
| `coverage` | `migration/coverage.json` | `0.4` | every destination | Every live URL you supplied, compared with the routes and rules this plan has. |
| `archives` | `migration/archives.json` | `0.8` | every destination | The archive and feed pages this run generated, and how each route was decided. |
| `menus` | `migration/menus.json` | `0.8` | every destination | The navigation WordPress served, including entries nothing generated yet. |
| `manifestAstro` | `migration/manifest.json` | `0.9` | Astro | WordPress ids, generated files and routes, and the destination block. |
| `manifestNext` | `migration/manifest.json` | `0.12` | Next.js | The same, plus the app structure the handoff was written for: `app/`, `content/`, the route index and the `out/` build directory. |
| `manifestPayload` | `migration/manifest.json` | `0.11` | Payload | The same, plus the collections, the drop and the pinned Payload and admin versions. |
| `manifestPruvious` | `migration/manifest.json` | `0.11` | Pruvious | The same, plus the collections, the drop and the pinned Pruvious and Nuxt versions. |
| `nextRoutes` | `content/routes.json` | `0.12` | Next.js | The route index the generated app reads: every prerendered route and the content file behind it. |
| `payloadDrop` | `import/content/index.json` | `0.9` | Payload | Which collection files the importer reads. |
| `payloadRedirects` | `import/redirects.json` | `0.9` | Payload | The redirects a Next front end reads, in the shape its config uses. |
| `pruviousDrop` | `import/content/index.json` | `0.11` | Pruvious | Which collection files the importer reads. |
| `migrationConfig` | `wp-migrate-core.config.json` | `0.7` | you — read by every command | The decisions the export cannot make: routes, exclusions, reviewed findings, post types, archives and media. |
| `importReport` | `migration-import.json` | `0.9` | the generated importer | What the import did: created, updated, unchanged, skipped, failed, and every unresolved reference. |
| `verification` | `migration-verification.json` | `0.9` | `verify` | The launch gate: content, media, links, canonical, robots, sitemap, delivery and import evidence. |

## The three numbering lines

1. **The package version.** `wp-migrate-core` itself. Covered by semantic
   versioning for the exported names — see
   [compatibility.md](compatibility.md) — and reported by `--version` and in
   every `generator.version`.
2. **The artifact version.** One number per file above. It moves when that
   file's shape changes, and a reader can accept or refuse a file by its own
   number without knowing which package wrote it.
3. **The config version.** `migrationConfigSchemaVersion`, currently `0.7`,
   which the parser refuses to read past. `wp-migrate-core schema` prints the
   JSON Schema for exactly the settings that version accepts.

## Reading a file safely

- Add fields to a file and leave its version alone only when an older reader
  still means the same thing by what it already reads. Anything else moves the
  number.
- A tool that consumes an artifact should check `schemaVersion` and refuse a
  number it does not know, which is what this package does for the migration
  config and the import report.
- The JSON Schema for the config is generated from the parser's own key lists,
  so a setting cannot be documented in one place and rejected in the other:

  ```bash
  npx wp-migrate-core schema --out wp-migrate-core.config.schema.json
  ```
