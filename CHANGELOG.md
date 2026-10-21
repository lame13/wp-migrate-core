# Changelog

## [Unreleased]

## [1.0.1] - 2026-10-21

- Applies configured redaction to AI metadata and route-matching requests. Repair now requires `privacy.send: "content"`, refuses pages that would be redacted or truncated, and checks for excessive text loss when applying hand-edited patches.
- Separates cached chat responses and embeddings by endpoint. Reads embedding response indexes and rejects inconsistent vector dimensions instead of matching the wrong routes.
- Preserves existing image descriptions and decorative alt text when applying decisions. Keeps unresolved Elementor component mappings in the repair queue.
- Corrects the AI review page’s triage and repair instructions. Highlights the automation workflow in the npm README with new screenshots of the generated reports.

## [1.0.0] - 2026-10-20

The repair queue gets an optional, bring-your-own-key AI path — and the
contract turns stable. The migration engine is unchanged in its central claim:
it reads local files, writes local files, and every change is traceable to the
export or an accepted decision.

- **`assist` is a separate, opt-in command.** It reads the plan artifacts and writes `run.json`, `suggestions.json`, `review.html` and, for triage, `brief.md`. It never edits generated output. `assist apply` writes `wp-migrate-core.decisions.json`; `inspect`, `convert`, `report` and `verify` read it with `--decisions`. The migration commands still make no network requests.
- **Triage reads the finding queue, not the export.** It groups findings, writes a ranked work order and a client-readable brief, and sends no post bodies. This is the first job because it proves the provider, redaction, budgets and artifacts with the smallest possible payload.
- **Alt text is deduplicated per asset and reviewed.** Only an absent `alt` is filled; an existing `alt=""` is left alone. One image referenced from twenty pages gets one suggestion. Text context comes first, so the job does not require a vision-capable endpoint.
- **Shortcode and widget mapping is type-level.** Unsupported shortcodes, Elementor widgets and dynamic Gutenberg blocks get one proposed strategy: static fallback, component, removal or deliberate block. Static fallbacks and removals can be applied by `convert`; component names remain developer work.
- **Route matching uses embeddings, with a hard constraint.** It may only choose a route the plan already has, and only above the configured score. A weak match produces no suggestion rather than an invented URL.
- **Content repair is last and parser-gated.** It requires `--export`, fixes malformed block markup, and rejects any patch that introduces a new finding code or removes too much page text. `convert --decisions` runs the same validation before applying a hand-edited patch.
- **The key stays in the environment.** `wp-migrate-core.ai.json` names an environment variable through `apiKeyEnv`; literal `Authorization` headers and remote plain-http endpoints are refused. The provider is a native-fetch OpenAI-compatible client with JSON-schema handling, capability fallbacks, retries, timeouts, request/token limits and a local response cache. `schema --ai` prints the config schema.
- **The 1.0 promise is now published.** `apiStability` is `stable`. The migration config stays at `0.7`; AI settings and artifacts have their own `0.1` schema versions, so the frozen migration format did not move.
- **New tests cover the seam.** A mock provider exercises config validation, bearer/key handling, triage, alt-text deduplication, shortcode application, route constraints and parser-gated repair. A localhost mock endpoint runs the CLI end to end through `assist`, `assist apply` and `convert --decisions`.

## [0.12.0] - 2026-10-14

Four destinations. The boundary between "the export" and "what the export becomes" is now a public one: a second static renderer arrives, the remaining parked targets say what they are waiting for, and the promises this project makes — its exported names, its file formats, its destinations — are written down and checked by the test suite rather than by the changelog.

- **Next.js is the fourth destination.** `convert --target next` writes a static-export Next app: the App Router, one JSON file per page plus `content/routes.json`, a catch-all route that prerenders every planned route, the menu as a component, `robots.txt` and a sitemap, and the same `migration/` artifacts every other destination writes. Because it is a static export, `next build` writes `out/` — which is exactly what `verify --html-dir out` reads, so the new destination is checked by the same launch gate as the first. A static export cannot serve a redirect, and the handoff says so: the redirect map is published as host rules in `migration/redirect-rules/`.
- **The Next handoff shares the Astro renderer's page model, not a copy of it.** The record/listing preparation, the body renderer, the media renderer, the internal link rewriting, the menu, the sitemap, the feed writer and every artifact are the same code for both. `test/next.test.ts` asserts the two handoffs render byte-identical HTML for the same record. Adding the destination put no rule into `src/core.ts`.
- **`npm run test:next` is a real round trip.** It installs Next 16 and React 19 into a temporary workspace, type-checks the generated app, runs `next build`, checks that every planned route reached `out/`, that a custom post type and the menu travelled, that delivered media is served from the build, that a publish-ready handoff comes out with no launch blocker, and that a redirect the plan published for the host is not faked by the app.
- **`npm run test:pruvious` closes the last validation gate.** It installs Nuxt and Pruvious, boots the generated app, and imports through the app's own protected route — then imports again and requires every record to come back `unchanged`, which is a claim about the database that only a real second run can make.
- **The contract is written down and enforced.** `src/contracts.ts` is one registry of every generated file and its own `schemaVersion`, and the generators read the versions from there instead of repeating string literals. `test/api-surface.json` freezes all 198 exported names, `test/api-surface.test.ts` fails when the built declarations and that list disagree in either direction, and it also fails when a name has no entry in the new API reference. `docs/compatibility.md` says what is inside the contract — exported names, the config format, the file formats, the destination registry, the no-network rule — and what is deliberately outside it.
- **`wp-migrate-core schema` prints the config schema.** The JSON Schema for `wp-migrate-core.config.json` is generated from the same key lists the parser validates against, so editor help cannot offer a setting the parser refuses. `test/contracts.test.ts` checks the schema against the parser in both directions and generates a handoff for every destination to confirm what the registry declares is what gets written.
- **A corpus, and a matrix over it.** `fixtures/corpus/` adds a healthy publishing site and an export that goes wrong in the ordinary ways — a duplicate WordPress id, an invalid id, an untitled item, a legacy query permalink, an unsafe link, a blocked shortcode, an image with no alt text, a PDF, a trashed item, a nested menu with a target the export does not carry. `test/corpus.test.ts` runs every fixture through parse, plan, all four destinations and a verification against a build that does not exist, and each fixture names the findings it exists to produce, so a parser change that stops producing one fails the test.
- **The round trips have a home in CI.** They install hundreds of megabytes and take minutes, so they run on a weekly schedule, on demand, and as the gate a release is cut against — not on every pull request, where `npm test` covers the same code at the text level. The decision and its reasoning are in `docs/roadmap.md`.
- **Findings stop naming a renderer.** The parser used to say a shortcode "cannot be executed by Astro" and to ask for "an Astro component". It now says "the generated site" and "a component in the destination", because it serves four destinations, and the report's rewrite of that copy is gone with it.
- **Documentation is a first-class part of the release**: [the API reference](docs/api.md), [the artifact catalog](docs/artifacts.md), [the compatibility contract](docs/compatibility.md), [the destination guide](docs/destinations.md) and [the corpus](docs/corpus.md).
- **Two behaviour changes to read before upgrading.** `verify` no longer treats a framework's own files as conflicting build output, and no longer reports a page the plan never mentions as one that "carries no canonical URL" — Next writes `404.html` and `404/index.html`, and neither is part of your migration. A planned route that was built twice still refuses to be guessed at. Second, findings words changed, so a snapshot of `migration/issues.json` text will differ.

## [0.11.1] - 2026-10-12

- Fixes the Pruvious bundle's missing migration command, invalid build command and collision with the built-in `pages` collection. Keeps Nuxt and Pruvious on the same minor version and pins the editor extensions to their compatible core version.
- Requires `WP_MIGRATE_IMPORT_TOKEN` for Pruvious imports. Re-imports preserve dashboard edits, clear removed relationships and count rejected updates as failures. The command exits unsuccessfully when records fail.
- Rewrites delivered images and download links to their served paths, preserves Elementor text in Pruvious, and serves Payload downloads from `public/` as well as importing them into the media library. Download references no longer hide image alt-text findings.
- Prevents Pruvious redirects from redirecting their own destinations. Preserves the full exported menu depth in Payload and checks for missing navigation records during import verification.
- Treats `WP_MIGRATE_IMPORT_REPORT` as a file path in both importers and reports malformed drop arrays instead of crashing without a report.
- Corrects case-sensitive Pruvious test paths. Adds importer execution regressions and extends the real Payload round trip to cover navigation and changed media files. Manually verifies Pruvious 3.9.10 with Nuxt 3.9.3 against a temporary SQLite database, including its production build.

## [0.11.0] - 2026-10-12

0.10 made the Payload destination something you can open and edit. This release makes it a destination, not a Payload script: the second CMS arrives, the first one's re-run promises become true for media as well as text, the menu becomes something you edit in the admin, and the files that are not images — PDFs, price lists, downloads — come along instead of being left on the old host.

- **Pruvious is the second CMS destination.** `convert --target pruvious` writes a Nuxt app with the `pruvious` module: one `collections/<name>.ts` per content type plus `media`, `categories`, `tags`, `authors` and `navigation`, a `nuxt.config.ts`, the drop and a generated importer under `import/` and `server/`, the redirect map as Nitro middleware, and the same `migration/` review artifacts the other targets write. The importer runs inside the app through Pruvious's own collection API and writes the same `migration-import.json`, so `verify --import-report` reads either destination the same way. This is the destination boundary's second proof: the new target adds no rule to `core.ts`.
- **Re-runs are honest about media.** The importer's re-run hash now covers the delivered file's bytes as well as the record's fields, so replacing `hero.jpg` re-uploads it instead of reporting `unchanged` while the CMS keeps the old image. A record's fields are still the only thing that decides a CMS edit is protected.
- **The importer always leaves a report.** `migration-import.json` is written next to the bundle rather than in whatever directory the importer was launched from (`WP_MIGRATE_IMPORT_REPORT` overrides it), and a drop file that cannot be read is one reported failure instead of a run that stops before writing anything. The Pruvious importer behaves the same way.
- **`verify --import-report` sees the supporting records.** Missing media, author and taxonomy records the plan expects are now findings, not silence, and a report whose `summary.planned` disagrees with the records it lists is flagged as `IMPORT_SUMMARY_MISMATCH`.
- **The WordPress menu becomes an editable collection.** The Payload and Pruvious bundles write a `navigation` collection built from the export's menu tree. Payload uses nested array fields; Pruvious stores child entries as JSON in a text field. Unresolved entries keep the reason a human needs. The static target still renders `Nav.astro`.
- **Files that are not images travel too.** A content link to an upload the export carries — a PDF, a price list, a zip — is now tracked as a `linked-file` media reference, delivered with the site the way an image is, and, on the CMS path, imported as a media record. It no longer becomes a link that 404s after migration.
- **The Payload manifest moves to schema `0.11`** for the `navigation` collection in its `collections` block; the Pruvious manifest is `0.11` from the start. The Astro manifest stays `0.9`, and the import report and verification artefact stay `0.9`, because neither changed shape.
- **What this release does not yet claim.** The Pruvious bundle is generated and unit-tested, but it has **not** been run end to end against a live Pruvious install — that round trip is the next validation gate, exactly as the Payload bundle's was before 0.9.1. The Payload bundle is still verified by `npm run test:payload`, which now also covers the re-run media hash and the navigation collection.

## [0.10.1] - 2026-10-10

- Runs the generated importer through Payload's CLI so it reads `.env` consistently with the admin app, including the database URL and secret.
- Converts linked body images and reads actual `src` and `alt` attributes instead of confusing them with `data-src` and `data-alt`.
- Keeps image hosts distinct, prefers exact attachment matches over size variants, and leaves ambiguous variants for review instead of attaching the wrong media record.
- Extends the Payload round trip to check the documented import command with a non-default database in `.env`, linked images, and draft-inclusive verification. Test subprocesses no longer inherit an external database URL or Payload secret.

## [0.10.0] - 2026-10-10

0.9.0 handed you a Payload bundle; this release hands you the app. The bundle now carries the Next + Payload admin host, so `npm install` and `npm run dev` open `/admin` instead of telling you to bring your own project. Images in the body become media nodes rather than notes, and the round trip that was run by hand for 0.9.1 is now a check anyone can re-run.

- **The bundle boots an admin.** `convert --target payload` writes the `app/(payload)` route files, the `tsconfig.json` Payload's own CLI reads, `.env.example`, `.gitignore`, and a `next.config.mjs` that wraps the project in `withPayload`. The generated `package.json` gains `dev`, `build`, `start` and `generate:importmap` scripts. Payload adds its own `users` collection for admin accounts and the first one is created in the browser; WordPress authors are still an `authors` collection rather than logins.
- **Images in the body come along.** When the export ties an image to an upload this run delivered, the converter emits a Payload Lexical upload node that references the media record, carrying the image's own alt text. An image with no delivered upload stays a `contentReview` entry instead of pointing at a record that will never exist. A delivered image is no longer also left in the review queue.
- **The CMS path refuses duplicate routes.** Two records claiming one URL now fail the same way the static target fails, before any output is written.
- **`npm run test:payload` is the round trip.** The check installs Payload 3.90.2 and Next into a temporary workspace, imports a generated bundle into SQLite, re-imports it, proves a source change updates while a CMS edit is protected, asserts the body image is a real populated media node, runs `verify --import-report`, and builds the generated admin app. It is opt-in because it installs packages; the default suite still never boots Payload.
- **The bundle is pinned to a checked release.** Payload and the `@payloadcms/*` packages are written as `3.90.2`, the release the round trip runs against, because `@payloadcms/next` declares its `payload` peer as that exact version. The manifest, the bundle's `package.json` and the README all record it.
- **The Payload config is `payload.config.js`.** Payload's CLI only discovers `payload.config.js` or `payload.config.ts`, so the `.mjs` name meant `payload generate:importmap` and friends could not find the config. A bundle written before this release needs the file renamed.
- **The Payload manifest moves to schema `0.10`** for the `config` and `admin` entries in its destination block. The Astro manifest stays `0.9`, the import report stays `0.9` and the verification artefact stays `0.9`, because none of those changed shape.
- **What this release still does not claim:** a migration of a real WordPress site. The generated app is built and exercised against Payload 3.90.2 and SQLite here, and that real-site round trip remains the gate before the next CMS destination.

## [0.9.1] - 2026-10-08

- Fixes Payload rich-text links rejected by the Local API, preserves nested lists and ordered-list starts, and represents preformatted code using nodes supported by the default editor.
- Keeps private, scheduled and other unpublished WordPress records as Payload drafts. Imports WordPress GMT dates consistently regardless of the machine's timezone.
- Checks the latest CMS draft before re-importing, reports CMS edits even when the source is unchanged, and handles Payload array IDs and added or removed source fields. A saved import snapshot distinguishes source changes from CMS edits; database connections are closed after the import.
- Keeps custom taxonomies in `wordpressTerms` without creating jobs for nonexistent collections. Refuses conflicting collection names before writing a bundle and handles numeric module names and comment delimiters in site titles.
- Escapes literal Next redirect paths and prevents trailing-slash redirect loops. Unresolved imported relationships now produce `IMPORT_REFERENCE_UNRESOLVED` warnings, and unavailable demo targets fail before writing output.
- Adds focused regression tests and validates a generated bundle against Payload 3.90.2 with SQLite: three content types, media, rich text, repeated imports, source updates and CMS draft protection. The real-site migration gate remains open.

## [0.9.0] - 2026-10-08

The tool stops being only an Astro renderer. Destinations now have a *kind* — a static site or a CMS — and the first CMS destination, **Payload**, turns the export into collections, a content and media drop, and a generated importer you run inside the destination project. `verify` can then answer a third question: not just "is the content in the front end?" but "is it in the CMS, and what still needs a human there?".

The direction is yours: people leaving WordPress still need somewhere to edit their website. The WXR parsing, media handling, URL and link inventories, redirects, repair queue and verification all apply across destinations, so the work here is the destination boundary plus the first target behind it. Pruvious and Ghost are planned next; Svelte stays a real but non-priority static target, and a bare Next.js or Nuxt renderer stays parked behind the CMS work.

- **A destination has a kind.** `TargetAdapter` gains `kind: "static-site" | "cms"`, and the CLI, the report and the manifest now say which one a target is instead of implying every target writes a site. `--target payload` is implemented; `next`, `nuxt` and `svelte` are declared and refuse with a reason. The manifest's `targets` block and the report's target cards are generated from one registry, so they cannot disagree.
- **A CMS destination writes a bundle, not a site.** `convert --target payload` writes `payload.config.mjs`, one collection module per content type plus `media`, `categories`, `tags` and `authors`, a content and media drop under `import/`, a generated importer, and a redirect map in the shape a Next front end uses (alongside the Netlify, Vercel, nginx and Apache files). `wp-migrate-core` itself still reads and writes local files and makes no network requests; the importer is the only thing that talks to a database, and it is yours to run.
- **Posts and pages map explicitly.** Title, slug, route, dates, author, taxonomy and the source publication status are all mapped. WordPress `draft`/`pending` become a Payload draft; `future` and `private` keep their own `wordpressStatus`. Authors become an `authors` collection rather than Payload users, because `dc:creator` is a WordPress login and creating login accounts is a deployment decision.
- **The body is native rich text for a documented subset.** Headings, paragraphs, lists, quotes, code, horizontal rules, links and emphasis become Lexical nodes. Images, embeds, forms, tables, shortcodes and layout containers become `contentReview` entries instead of being guessed at, and `sourceHtml` keeps the exact export HTML so nothing is lost.
- **Media goes through the Local API.** Files delivered from a local uploads directory are copied into the bundle, referenced by `{ "$ref": ... }` markers, and uploaded by the importer so Payload owns the file, its sizes and its alt text. A `linked` or `remote` file has no local bytes, so it is left out and any reference to it is reported as unresolved rather than inventing an empty media record.
- **Re-imports are safe.** The importer looks records up by the stable `wordpressSourceId` the manifest already uses (`wp:post:20`), and uses an import hash to tell "the source changed" apart from "somebody edited this in the CMS". A record that changed is updated; a record edited in the CMS is skipped and reported as `record-modified` rather than overwritten.
- **`verify` gains `--import-report`.** Read the `migration-import.json` a generated importer wrote, and the launch gate gains an `import` check: a planned record the report never mentions is `IMPORT_RECORD_MISSING`, a record the importer failed on is a blocker (`IMPORT_RECORD_FAILED`), a skipped record is `IMPORT_RECORD_SKIPPED`, and a content id the plan does not carry is `IMPORT_RECORD_UNKNOWN`. The report can stand alone if you only want to know whether the CMS import landed, or join a build check so one run answers both questions.
- **The manifest moves to schema `0.9`** for the destination block and the new targets, and the verification artefact moves to `0.9` for the import evidence. Media stays `0.7`, links `0.3`, coverage `0.4`, redirects `0.2`, archives and menus `0.8`, because none of those changed shape.
- **What this release does not claim:** the generated Payload config and importer are type-checked, unit-tested at the mapping and hash level, and exercised through the installed package's CLI, but they have not been run against a live Payload database here. That round-trip is the validation gate before the next CMS target: one real WordPress → Payload migration, with more than two content types, a menu, archives and media.

## [0.8.1] - 2026-10-07

- Fixes archive pagination redirecting the first page to a later page, and prevents query-based attachment permalinks from becoming homepage redirects.
- Writes explicit `.xml` feeds as files and includes them in route coverage. Feeds cannot overwrite another generated public file.
- Keeps external URLs, content permalinks and other taxonomy bases out of archive matching. Refuses duplicate content/archive routes and reserves the listings collection so custom content cannot be overwritten.
- Preserves menu query strings, fragments and external destinations, rewrites confirmed internal targets, and reports missing or unsafe targets. Unlabelled menu entries use the linked content's title. Review artifacts still omit query strings and credentials.
- Makes explicit post-type includes work for types normally skipped as internal content; attachments and menu items retain their dedicated handling.
- Includes archives in presence, indexing and SSRWire delivery checks. CLI verification now reads media config and accepts media options; media without a delivery plan is marked unchecked.
- Fixes canonical checks accepting another origin or an invalid URL scheme, encoded download links being reported missing, and robots checks mishandling grouped user agents and matching allow rules.

## [0.8.0] - 2026-10-07

The handoff now carries the parts of a WordPress site it used to leave behind, and `verify` can say whether the result is ready for DNS. Custom post types, navigation menus and archive pages come across instead of being dropped, and the publishing gate reads the build itself: media that never arrived, links that lead nowhere, canonical URLs, robots.txt and the sitemap.

- Brings across every content post type in the export, not just pages and posts. Each becomes its own collection under `src/content/`, and the manifest records what the export carried and what this run did with it. Types that are not content, such as revisions and customizer drafts, are reported rather than passed over, and `postTypes.include` / `postTypes.exclude` decide anything you want decided differently.
- Rebuilds the navigation WordPress served from its menu items, including nesting, custom links, and entries that point at a taxonomy archive. The generated project gets a `Nav.astro` the layout renders, `migration/menus.json` records the tree, and an entry nothing serves is reported (`MENU_TARGET_UNRESOLVED`).
- Generates the archive pages WordPress made from its own settings: term archives for the categories, tags and custom taxonomies the content uses, and author archives for the people who wrote it. Routes come from the live URLs you supply when a sitemap confirms them, and otherwise from a WordPress default that the plan labels as an assumption (`ARCHIVE_ROUTE_ASSUMED`) rather than presenting as fact.
- Adds the listings that need a setting WXR does not carry, each one opt-in through the migration config: a posts index (`archives.postsIndex`), pagination (`archives.perPage`), date archives (`archives.dates`) and RSS feeds (`archives.feeds`). Feeds are written as static files, and the address WordPress served gets a redirect rule to reach them.
- Redirects attachment pages to the upload they describe, using the permalink the export records, and leaves them alone with `archives.attachmentPages: "ignore"`.
- Listing pages are generated as ordinary content entries, so the sitemap, redirect map, coverage check and delivery checks treat them like any other page. Coverage now reports a live archive URL as served instead of explaining why it has no route.
- `verify` gains the launch gate: it checks that every copied media file is present in the build and is not empty (`MEDIA_MISSING_IN_BUILD`, `MEDIA_EMPTY_IN_BUILD`), that internal links resolve to a route, a rule or a build file (`LINK_TARGET_MISSING_IN_BUILD`), that pages carry a canonical URL (`CANONICAL_MISSING`), that `robots.txt` does not disallow crawling (`ROBOTS_BLOCKED`) and that the sitemap lists every generated route (`SITEMAP_INCOMPLETE`).
- Adds `--publish-ready` to `convert` and `demo`: an indexable layout with a canonical URL per page, and a `robots.txt` that allows crawling and names the sitemap. The private default is unchanged.
- The verification artefact records which checks ran and which could not (`checks`), and counts the unchecked ones separately. A check that needs the build output is never reported as passed when only a crawl report was supplied.
- `manifest.json` and the new `archives.json` and `menus.json` use schema `0.8`; the verification artefact moves to `0.8`. Media stays `0.7` and links stay `0.3`, because neither changed shape.

## [0.7.0] - 2026-10-01

You can now bring images into the generated Astro site. Use `--uploads` with a local copy of your WordPress uploads directory, or `--media-base` if a CDN already serves your files. The migration report shows which files were copied, which stay remote, and which still need attention.

There's also a config file for the decisions you used to make by hand: choosing a route for a `?p=123` permalink, leaving out a page, or accepting a finding you've already reviewed. Keep it beside the export to reuse those decisions on the next run.

- Copies referenced files into `public/wp-content/uploads/`, preserving their upload paths. Uploads listed in `--live-urls` are included too; `--copy-unused-media` adds the remaining attachments.
- Updates image and picture sources, including `srcset`, and fills in missing alt text and dimensions from the export. Decorative images with `alt=""` keep it. If a resized image is unavailable, the original file can stand in for it.
- Reads `wp-migrate-core.config.json` beside the export, or a file passed with `--config`. It supports routes, exclusions, reviewed findings, site details, media sources and the failure threshold.
- Keeps waived findings visible as `ignored`, labels them in the report, and leaves them out of the counts used by `--fail-on`. Unmatched config entries produce a warning.
- Records media delivery and config decisions in the handoff. The media inventory and manifest now use schema `0.7`; local uploads directory paths are omitted.
- Adds missing-file warnings and checks that copied files stay inside the supplied uploads directory. Media base URLs omit credentials, query strings and fragments. No media is fetched over the network.
- Includes placeholder images in the demo so you can try media delivery without supplying your own uploads.

## [0.6.1] - 2026-09-27

The npm package homepage now points to [wp-migrate-core on NikoCodes](https://nikocodes.com/software/wp-migrate-core/). No changes to migration behavior.

## [0.6.0] - 2026-09-27

Check how your rebuilt site responds to visitors and crawlers before moving DNS. This release adds saved SSRWire audits to the existing content checks, including a comparison with your WordPress site.

- Add `--ssrwire-report <file>` to `verify` alongside `--html-dir` or `--routelint-report` to check response status, metadata and indexing directives. Add `--ssrwire-baseline <file>` to see what changed since the source audit. `verify` reads these files locally.
- Generated Astro projects include matching source and preview check files, plus `npm run check:source` and `npm run check:preview`. Capture the source report while WordPress is still online. The checks cover the first 50 planned routes; you can extend the lists.
- Lost Open Graph and Twitter Card tags are reported by name, such as `og:image`, with the affected routes and crawler profiles. Shared problems are grouped to keep the repair list readable.
- Publishing checks flag blocked indexing, failed or incomplete responses, unmet SSRWire checks and regressions. A report covering no planned routes is a blocker; partial coverage is a warning. Missing or unsuccessful baseline captures are reported without hiding problems in the new site.
- Conversion writes `public/sitemap.xml` and sets Astro's `site` URL when the export provides one. Sitemap dates omit invalid WordPress values and avoid guessing a timezone.
- Verification JSON now uses schema `0.6`, with `delivery` and `launch` sections and publishing blocker/warning counts. It preserves metadata presence and numeric timings without copying page text or metadata values, and keeps differing crawler results separate.
- Adds SSRWire as a dependency and exports helpers for generating checks, reading audits and building publishing findings. Regression tests cover the new checks, saved reports, CLI gates and generated files.

The generated site still starts with `noindex, nofollow` and a `robots.txt` crawl block. Remove both before publishing. `verify` detects the page's indexing directives; review `robots.txt` separately.

## [0.5.0] - 2026-09-25

Once you've built your new site, `verify` helps you check that the WordPress content made it across. Point it at your build folder or a saved RouteLint report; everything is read locally.

- Run `wp-migrate-core verify export.xml --html-dir dist`, or use `--routelint-report report.json` for a site you've already crawled. Both Astro HTML output formats are supported, and crawl reports can use a staging domain.
- Find missing pages, nearly empty pages, and text that has shrunk or changed substantially. Use `--fail-on blocker` to stop on missing content, or `--fail-on warning` to catch changed text too. The results are saved to `migration-verification.json` without copying page text into the report.
- Check Elementor text stored in widget settings as well as regular post content. Short records are left for manual review, but a missing page still gets flagged. Failed crawls and redirects to another page cannot pass the check.
- Catch conflicting build files, duplicate routes and empty exports before they produce a misleading result. The README covers the comparison's limits: passing this check still leaves layout, images and behavior to review.
- Requires **Node.js 22.12 or later**. RouteLint is now a runtime dependency and is installed with the package. The migration commands still make no network requests.

## [0.4.0] - 2026-09-23

This release closes the URL loop. It compares the URLs the live site already serves with the routes this plan generates, and it writes the redirect rules the plan calls for in the formats common hosts expect.

- Adds `--live-urls <file>` to `inspect`, `convert`, `report` and `demo`. It reads a downloaded XML sitemap, a sitemap index, or a plain list with one URL or path per line, and the option can be repeated to check several files at once. It reads local files only: a URL on the command line is refused, and nothing is fetched.
- Adds a live URL coverage inventory at `migration/coverage.json` (schema version `0.4`), a coverage section in the HTML report, a coverage line in the CLI summary, and a `coverage` block in `--json`.
- Classifies every live URL as served by a generated route, covered by a proposed redirect rule that still has to be published, declared by the export without a confirmed route, a WordPress shape no static route serves (feeds, uploads, endpoints, category and tag archives, date archives, author archives, paginated archives and query-string URLs), on another host, unreadable, or uncovered.
- Creates one warning per uncovered URL so `--fail-on warning` can gate a migration that would drop URLs, and one warning when the supplied source lists no page URLs at all, such as a sitemap index passed on its own.
- Keeps a trailing slash part of the URL: a live path is matched exactly against a generated route or a rule, so a route that serves `/guides/tap/` does not silently cover `/guides/tap`.
- Writes redirect configuration from the same redirect map the report shows: `migration/redirect-rules/netlify/_redirects`, `vercel/vercel.json`, `nginx/redirects.conf` and `apache/.htaccess`. Netlify slash-only changes defer to Pretty URLs; Vercel patterns avoid matching their own destinations. nginx and Apache match original request paths, preserving encoded separators and repeated slashes. Configuration delimiters, Unicode, bare percent signs and replacement syntax are escaped per host, and no file is written when the plan needs no rule.
- Updates the manifest to schema version `0.4` with a `coverage` block. Media and the redirect map stay at `0.2`, and the link inventory stays at `0.3`.
- Keeps live URLs out of review artifacts: credentials, query strings and fragments never reach the coverage inventory, the plan, the report or a rule file, and an entry that cannot be read is never echoed.
- Extends the bundled demo with a fictional sitemap, so the packaged install exercises the coverage check and the rule files, and refreshes the README with the coverage and rule-file workflow.
- Reads namespace-prefixed sitemaps, ignores XML comments and extension URLs, preserves literal CDATA and decodes entities once. Rejects truncated XML and invalid UTF-8 instead of checking corrupted or partial input.
- Keeps distinct query URLs during deduplication, normalizes relative paths consistently, and counts generated routes even when an exported query permalink still needs a decision. Warns when every supplied entry is unreadable.
- Prevents the HTML report from claiming complete coverage while excluded or unreadable entries remain, and keeps unsupported URL schemes out of review artifacts.
- Synchronizes the package lockfile with version `0.4.0` and adds screenshots captured from the fictional demo report.

## [0.3.0] - 2026-09-18

- Adds a link inventory to inspection plans, HTML reports, CLI summaries, and generated projects at `migration/links.json`.
- Classifies supported HTML, Gutenberg, and Elementor links against exported URLs and generated routes, with per-record warnings for unresolved same-site targets.
- Rewrites supported same-site hrefs during conversion, preserving query strings and fragments. `--keep-source-links` and the library's `{ rewriteLinks: false }` option retain source hrefs while keeping proposed rewrites visible.
- Preserves distinct hrefs, path case, and encoded separators; leaves ambiguous permalinks and unknown external hosts for review instead of guessing a target.
- Sanitizes credentials and queries in link reporting, including protocol-relative URLs, and sanitizes source URLs in the generated manifest and README.
- Updates the manifest and link inventory to schema version `0.3`; media and redirect inventories remain at `0.2`.

## [0.2.0] - 2026-09-17

This release adds a media inventory and a URL/redirect map to help plan a WordPress-to-Astro migration. Both use only the WXR export; migration commands make no network calls and do not download media or publish redirects.

- Inventories attachment records, available alt text and dimensions, and references from supported Gutenberg blocks, Elementor image/background settings and text/HTML widgets, featured images, and rendered image tags.
- Matches attachments by ID or file path, with unambiguous WordPress filename variants as a fallback. Exact filenames take priority; different hosts, folders, or filename case are not silently merged. Repeated references to one asset are grouped per content record.
- Adds per-record warnings for missing attachment records and missing alt text. Unreferenced uploads remain visible without adding warnings, and trashed attachments are skipped.
- Maps exported page/post permalinks to proposed routes, identifies path redirects, and explains excluded, skipped, colliding, and query-string URLs. Conversion continues to refuse duplicate routes.
- Includes both inventories in the HTML report and inspection plan, and their summary counts in CLI output and `--json`. Generated projects include `migration/media.json` and `migration/redirects.json`; these files and the manifest use schema version `0.2` independently of the package version.
- Preserves encoded source paths and repeated slashes in redirect rules, and sanitizes protocol-relative URLs consistently so credentials cannot leak into review plans, reports, or inventory URL fields.
- Refreshes the npm README with a demo-first walkthrough, output-file guide, library example, and clearer migration and privacy limits.
- Extends parser, CLI, privacy, and installed-package regression coverage, including exact media matching, nested blocks, filename variants, Elementor inline images, and redirect path preservation.

## [0.1.3] - 2026-09-16

This release adds CLI scan controls and machine-readable results for local review and CI.

- Passes `--include-drafts` through to the parser so CLI scans can include drafts, pending, private, and other non-published posts and pages.
- Adds `--json` to `inspect`, `convert`, `report`, and `demo`, reporting generator identity, scan settings, summary counts, sanitized issues, output paths, and failure status without the source URL or raw issue evidence.
- Adds `--fail-on none|warning|blocker` to set a failing exit status for issues at or above the chosen severity after writing output. The default `none` preserves existing behavior.
- Covers draft inclusion, JSON privacy, clean and single-severity scans, and output preservation when a severity gate fails with CLI regression tests.

## [0.1.2] - 2026-09-05

This release improves CLI argument handling and makes the current release the default npm install.

- Changes the default npm publishing tag to `latest` and updates the installation instructions.
- Rejects missing, blank, or option-like values for `--out` and `--target` before reading an export or writing output.
- Adds `--version` / `-v` and supports `--help` / `-h` after a command without requiring an input file.
- Reads the CLI, HTML report, and generated handoff version from the package metadata so they stay in sync.
- Reports unknown commands and options before attempting to read an export.
- Adds CLI regression tests and an installed-tarball check for the executable, bundled fixture, ESM exports, and generated version metadata.
- Adds read-only GitHub Actions CI for Node 20 installation, tests, and npm package checks; publishing also runs the installed-tarball check.

## [0.1.1] - 2026-09-03

This release makes inspection safer when an export or output path is not quite what the CLI expects.

- Writes the inspection plan and repair report as one staged handoff, then moves them into place together.
- Refuses an existing inspection output path without changing its files.
- Skips missing, invalid, and duplicate WordPress post IDs and explains each skipped item in the repair queue.
- Keeps malformed numeric XML entities intact instead of letting them crash WXR parsing.
- Adds regression coverage for the parser edge cases and the CLI's no-clobber behavior.

## [0.1.0-demo] - 2026-09-02

The first public demo: inspect a WordPress WXR export, surface unsupported migration work, and generate a deliberately private Astro handoff for human review.

[Unreleased]: https://github.com/lame13/wp-migrate-core/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/lame13/wp-migrate-core/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/lame13/wp-migrate-core/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/lame13/wp-migrate-core/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/lame13/wp-migrate-core/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/lame13/wp-migrate-core/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/lame13/wp-migrate-core/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/lame13/wp-migrate-core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/lame13/wp-migrate-core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/lame13/wp-migrate-core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lame13/wp-migrate-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lame13/wp-migrate-core/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/lame13/wp-migrate-core/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lame13/wp-migrate-core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lame13/wp-migrate-core/compare/v0.1.0-demo...v0.1.1
[0.1.0-demo]: https://github.com/lame13/wp-migrate-core/releases/tag/v0.1.0-demo
