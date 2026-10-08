# Roadmap

## Where this is now

0.7.0 brought media and a migration config. 0.8.x finished the static path
for Astro: content types, navigation, archives, the launch gate. 0.9.0 opened
the CMS path — destinations have a *kind*, and Payload is the first CMS
destination behind that boundary. 0.10.0 made that destination something a
person can actually open: the bundle carries the admin host, images in the
content are media nodes, and the Payload round trip is a check in the package.

## The CMS destination path

CMS exports solve a migration problem a static handoff does not: people
leaving WordPress still need somewhere to edit their website. An Astro, Next
or Nuxt project gives them a new site foundation; a CMS destination also gives
them an admin, media management and a publishing workflow.

The capabilities this package already has — WXR parsing, media handling, URL
and link inventories, redirects, a repair queue, verification — are useful
across destinations, so the work is a destination boundary and then adapters,
not a rewrite.

Priority:

| Target | Why add it | Priority |
| --- | --- | --- |
| **Payload** | Next.js plus an integrated CMS. Its official WordPress migration guide already involves custom migration scripts, which this package can standardize. | Shipped in 0.9.0; admin host, body images and a checked round trip in 0.10.0 |
| **Pruvious** | A Nuxt destination with admin, media, collections and editable Vue blocks. | Next, if users want Nuxt |
| **Ghost** | A straightforward destination for blogs and publications. | Later: Ghost already has a WordPress importer, so the advantage has to be better checking, preservation and repair reporting |

Svelte stays a real but non-priority static target. A bare Next.js or Nuxt
renderer stays parked behind the CMS work, because Payload and Pruvious
already deliver a Next and a Nuxt site.

## The destination boundary

Five places know about targets, and they are generated from one registry now
(`src/targets.ts`), so they cannot drift:

- `OutputTarget` in `src/types.ts`, and `DestinationKind = "static-site" | "cms"`.
- `targetDefinitions` — target, kind, enabled, label, description.
- `src/adapters.ts` — `TargetAdapter`, which adds a `generate` function, plus
  `assertTargetEnabled` and `generateForTarget`.
- `src/cli.ts` — the `--target` validator and the command dispatch.
- `src/generate.ts` / `src/payload.ts` — the manifest's `targets` block and the
  report's target cards.

Four things changed shape when a destination stopped being a renderer:

- **A destination has a kind.** The CLI, the report and the manifest say which
  one a target is instead of implying every target writes a site.
- **A CMS destination writes two things.** A reviewable bundle — collections,
  configuration, a content and media drop — and a generated importer that runs
  inside the destination project. The bundle is what this tool produces; the
  importer is what touches the database. `wp-migrate-core` itself still reads
  and writes local files and makes no network requests.
- **Editability is already modelled.** `MigrationNode.conversion` is exactly the
  question a CMS adapter answers: `native` becomes native editor structures,
  `legacy-html` becomes a raw block with a marker, `manual` and `blocked`
  become the parts of the page that need a human.
- **Verification gained a third kind of evidence.** `verify --import-report`
  reads the report a generated importer wrote, keyed by the same stable source
  ids the manifest already uses, so one `verify` run can answer whether the
  content arrived in the front end, in the CMS, and in a launchable build.

## 0.9.0 — shipped

- Destination model: `kind`, the target registry, the manifest `targets` block,
  the report target cards. Manifest schema `0.9`.
- Payload bundle: `payload.config.mjs`, one collection module per content type
  plus `media`, `categories`, `tags` and `authors`, the content and media drop,
  the redirect map for a Next front end, and the review artifacts.
- Generated importer: Payload Local API, stable `wordpressSourceId` lookups,
  update-if-unmodified with an import hash, `record-modified` for a record
  edited in the CMS, and a written `migration-import.json`.
- Import report and `verify --import-report`: findings for missing, failed,
  skipped and unexpected records. Verification artefact schema `0.9`.

**Validation so far.** 0.9.1 added a local Payload 3.90.2 / SQLite round-trip
with generated fixtures; 0.10.0 committed it as `npm run test:payload` and
extended it to the admin host: the generated app installs, imports, re-imports,
protects a CMS edit, stores a body image as a media node, and builds with
Next.js. A real-site migration remains the gate below.

## 0.10.0 — shipped

- The bundle is a runnable Payload + Next app: `app/(payload)`, a
  `tsconfig.json` Payload's CLI can read, `.env.example`, `.gitignore`, a
  `withPayload` Next config, and `dev` / `build` / `import` /
  `generate:importmap` scripts. `npm run dev` opens the admin.
- Delivered body images become Payload Lexical upload nodes that reference the
  media record, instead of stopping at a `contentReview` row.
- The CMS path refuses duplicate routes the way the static target already did.
- `npm run test:payload` installs Payload 3.90.2 and Next into a temporary
  workspace, imports into SQLite, re-imports, proves a source change updates
  while a CMS edit is protected, checks the media node, runs the import gate,
  and builds the generated admin app. The bundle is pinned to that release.

## Validation gate before 0.11.0

Run one real WordPress → Payload migration end to end — a site with more than
two content types, a menu, archives and media — and write down what broke.
Pruvious does not start until that list is empty or explicitly deferred. The
package now proves the mechanics against a real Payload and SQLite; the gate is
about a real site's content, not about whether the bundle runs.

## 0.11.0 — Pruvious

The same bundle and importer shape against a Nuxt destination, which is where
the adapter boundary gets its second proof: if the second CMS needs changes in
`core.ts`, the boundary was drawn in the wrong place.

## Later — Ghost, then the parked static targets

Ghost's own importer means the pitch there is checking, preservation and
repair reporting rather than movement, so it is a smaller release. Svelte stays
a real but non-priority static target.

## Decisions to review before 0.11.0

1. **Whether the Payload round trip runs in CI.** 0.10.0 pins Payload `3.90.2`
   across the manifest and the bundle, and `npm run test:payload` runs against
   SQLite on demand. Decide whether CI installs it (network, disk and minutes)
   or whether it stays a release-time check.
2. **Rich text depth.** 0.9.0 converts headings, paragraphs, lists, quotes,
   code, rules and the common inline formatting, and marks the rest. Revisit
   once a real migration shows what matters.
3. **Where redirects live for a Next front end.** 0.9.0 writes both
   `next.config.mjs` and the host rule files. Confirm the split in practice.
4. **Does a CMS target generate a front end?** 0.9.0 targets Payload plus a
   documented Next structure; the front end stays a rendering concern the user
   owns.

## What stays true

- **No network** in migration commands. The bundle is files; the importer is
  the user's program talking to their database.
- **Reviewable before it runs.** The bundle can be read, diffed and edited
  before anything touches a CMS.
- **No invented content.** Every generated record is traceable to the export, a
  live URL, or a decision in the config.
- **Warnings and gates.** Everything the importer cannot map cleanly stays a
  finding with a severity and a required action.
- **Schema versions per artifact.** Each artifact moves only when its shape
  changes.
