# Roadmap

## Where this is now

0.7.0 brought media and a migration config. 0.8.x finished the static path
for Astro: content types, navigation, archives, the launch gate. 0.9.0 opened
the CMS path — destinations have a *kind*, and Payload is the first CMS
destination behind that boundary. 0.10.0 made that destination something a
person can actually open: the bundle carries the admin host, images in the
content are media nodes, and the Payload round trip is a check in the package.
0.11.0 proved the boundary with a second CMS: Pruvious joined Payload, the
menu became an editable collection, files that are not images travel too, and
the importer's re-run promises became true for media as well as text. 0.12.0
made the boundary public and proved it a third time with a static renderer:
Next.js arrived, the exported surface and every artifact version became a
frozen, test-enforced contract, the corpus arrived, and the last repeatable
integration check — Pruvious against a real Nuxt app — closed.

1.0.0 adds the optional assist layer without moving the migration contract:
the repair queue becomes a triage brief, alt-text drafts, shortcode mappings,
constrained route suggestions and parser-checked content repairs. The key is
the user's, the endpoint is theirs, and accepted decisions are a local file the
deterministic commands read.

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
| **Next.js** | The framework people leaving WordPress most often already have a project in — and the destination that proved the boundary for a static renderer, not just a CMS. | Shipped in 0.12.0 |
| **Payload** | Next.js plus an integrated CMS. Its official WordPress migration guide already involves custom migration scripts, which this package can standardize. | Shipped in 0.9.0; admin host, body images and a checked round trip in 0.10.0 |
| **Pruvious** | A Nuxt destination with admin, media, collections and editable Vue blocks. | Shipped in 0.11.0 as the second destination — the boundary's second proof |
| **Ghost** | A straightforward destination for blogs and publications. | Later: Ghost already has a WordPress importer, so the advantage has to be better checking, preservation and repair reporting |

Nuxt and Svelte are the parked static targets; they stay
declared in the registry so a caller can see them and get a reason. A bare
Next.js renderer was parked behind the CMS work for two releases because
Payload and Pruvious already deliver a Next and a Nuxt site — 0.12.0 settled
that the shorthand was wrong: a CMS bundle is not a static site, and someone
who wants `out/` to deploy does not want a database.

## The destination boundary

Five places know about targets, and they are generated from one registry now
(`src/targets.ts`), so they cannot drift:

- `OutputTarget` in `src/types.ts`, and `DestinationKind = "static-site" | "cms"`.
- `targetDefinitions` — target, kind, enabled, label, description.
- The preview origin and the command that serves it, so the paired SSRWire
  checks are written for the port the destination actually uses.
- `src/adapters.ts` — `TargetAdapter`, which adds a `generate` function, plus
  `assertTargetEnabled` and `generateForTarget`.
- `src/cli.ts` — the `--target` validator and the command dispatch.
- `src/generate.ts` / `src/next.ts` / `src/payload.ts` / `src/pruvious.ts` —
  the manifest's `targets` block and the report's target cards.

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

## 0.11.0 — shipped

The second CMS destination, and the release that made the first one honest.

- **Pruvious.** A Nuxt + Pruvious bundle with the same drop shape, importer
  report and review artifacts as Payload. The adapter adds no rule to
  `core.ts`, which is the boundary proving itself: the second CMS was a new
  module, not a change to the shared model.
- **Re-runs are honest about media.** The import hash covers the delivered
  file's bytes, so a replaced image re-uploads.
- **The importer always leaves a report.** It writes next to the bundle, and a
  drop file it cannot read is one reported failure, not a run that stops
  before writing anything. `verify --import-report` sees the supporting
  media, author and taxonomy records and flags a summary that disagrees with
  the records it lists.
- **The menu is editable.** Payload and Pruvious write a `navigation`
  collection from the export's menu tree.
- **Files that are not images travel.** A content link to an upload the export
  carries is delivered like an image and, on the CMS path, imported as a media
  record.

## Validation gates

Three of the four are closed, and each one is closed by a command anyone can
re-run:

| Gate | Closed by |
| --- | --- |
| Payload mechanics against real Payload and SQLite | `npm run test:payload` |
| Pruvious against a real Nuxt app: boot, import, repeat import, import gate | `npm run test:pruvious` |
| Next.js: type-check, static build, every route prerendered, media served, launch gate | `npm run test:next` |
| **One real WordPress → CMS migration** — a site with more than two content types, a menu, archives and media | **Open.** No fixture can stand in for it, because its value is the content nobody wrote for this repository. |

## 0.12.0 — shipped

The release that made the promises executable, and added the destination that
proves they are worth making.

- **Next.js is the fourth destination**, written against the boundary instead of
  inside it. It shares Astro's page model — the same record preparation, body
  renderer, media renderer, menu, sitemap, feed writer and artifacts — and
  `test/next.test.ts` asserts the two handoffs render byte-identical HTML for
  the same record. It added no rule to `core.ts`.
- **The `out/` directory is the gate.** A static export writes one HTML file per
  prerendered route, which is exactly what `verify --html-dir` reads. A static
  export cannot serve a redirect, and the handoff says so rather than shipping
  one that does nothing.
- **The contract is a file, not a paragraph.** `src/contracts.ts` holds every
  artifact and its schema version, and the generators read them from there.
  `test/api-surface.json` freezes 198 exported names, and
  `test/api-surface.test.ts` fails if the built declarations disagree with it or
  if a name is missing from `docs/api.md`.
- **The corpus is the parser's regression net.**
  `test/corpus.test.ts` runs every fixture through parse, plan, all four
  destinations and a verification, and each fixture names the findings it
  exists to produce.
- **Findings stopped naming a renderer**: "cannot be executed by Astro" became
  "cannot be executed by the generated site".

## 1.0.0 — shipped

The contract release is also the release that gives the repair queue a
reviewable AI path.

- **`assist` is separate on purpose.** It reads plan artifacts, proposes
  decisions, and writes `run.json`, `suggestions.json`, `review.html` and — for
  triage — `brief.md`. It never edits generated output directly. `assist apply`
  writes `wp-migrate-core.decisions.json`; `convert`, `verify`, `inspect` and
  `report` apply it through `--decisions`.
- **Five jobs, narrow scopes.** Triage reads findings, not post bodies. Alt
  text deduplicates by asset id and only fills absent alt text. Shortcodes and
  widgets map by type. Route matching uses embeddings but may only pick routes
  the plan already has. Repair is last, needs `--export`, and a patch is
  rejected if it introduces any new finding code.
- **Bring-your-own-key is real.** The AI config names an environment variable;
  a literal `Authorization` header is refused, remote plain `http` is refused,
  and the key never reaches an artifact. The provider is a small native-fetch
  OpenAI-compatible client with retries, timeouts, capability flags, token and
  request limits, and a local response cache.
- **1.0.0 is stable.** `apiStability` flipped from `pre-release` to `stable`,
  and the assist commands and artifacts carry their own `0.1` schema versions.
  The migration config stays at `0.7`, because the AI settings live in a
  separate file rather than moving a frozen format.

## The CI decision

**The round trips do not run on every pull request.** They run on a weekly
schedule, on demand, and as the gate a release is cut against
(`.github/workflows/round-trips.yml`). The reasoning:

- Between them they install a few hundred megabytes (Nuxt and Pruvious are the
  heaviest) and take minutes per destination, four ways across a matrix.
- What they catch that `npm test` cannot is *integration* drift — a toolchain
  release changing behaviour under a generated project. That drift appears on
  the scale of weeks, not commits, which is the schedule.
- A pull request still gets the text-level suite, the contract checks, the
  destination tests and the corpus matrix. Nothing about a normal change is
  unverified; the round trips are the second opinion, not the first.

If a change touches a destination's generated project — `src/next.ts`,
`src/payload.ts`, `src/pruvious.ts`, the shared renderer or a pinned version —
run the round trip for that destination before merging. A release runs all
three.

## Next — Nuxt, then Svelte

The two declared-but-disabled targets are planned, in this order:

- **Nuxt.** The Pruvious bundle already integrates with a Nuxt app, so
  the renderer has a reference implementation to borrow a shape from: content
  as JSON, a route index, and the same `verify --html-dir` story as Next.
- **Svelte.** A SvelteKit target, last because it is the least likely to
  be someone's destination and, of the four static options, the one whose
  project structure moves most between releases.

Both stay in the registry while they are unwritten, and `assertTargetEnabled`
keeps refusing them with a reason. A target that disappears from the list is a
target a script cannot discover.

**Ghost** comes after that, and it is a different kind of destination: it has
its own importer, so the pitch there is checking, preservation and repair
reporting rather than movement.

## Decisions to review before the next destination

1. **Rich text depth.** 0.9.0 converts headings, paragraphs, lists, quotes,
   code, rules and the common inline formatting, and marks the rest. Revisit
   once a real migration shows what matters.
2. **Where redirects live.** Payload writes `next.config.mjs` and the host rule
   files, Pruvious writes Nitro middleware and the host rules, and the static
   destinations write only the host rules because their builds cannot redirect.
   Confirm the split in practice on a real deployment.
3. **Does a CMS target generate a front end?** 0.9.0 targets Payload plus a
   documented Next structure; the front end stays a rendering concern the user
   owns.
4. **The Next handoff's content format.** JSON keeps the generated project free
   of a Markdown pipeline and makes the shared renderer the single source of
   HTML. Revisit if real users want MDX for hand edits.

## What stays true

- **No network** in migration commands. The bundle is files; the importer is
  the user's program talking to their database. `assist` is the explicit,
  opt-in exception: it talks only to the endpoint the user configures.
- **Reviewable before it runs.** The bundle can be read, diffed and edited
  before anything touches a CMS.
- **No invented content.** Every generated record is traceable to the export, a
  live URL, or a decision in the config.
- **Warnings and gates.** Everything the importer cannot map cleanly stays a
  finding with a severity and a required action.
- **Schema versions per artifact.** Each artifact moves only when its shape
  changes.
