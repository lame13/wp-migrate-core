# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/lame13/wp-migrate-core/compare/v0.6.1...HEAD
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
