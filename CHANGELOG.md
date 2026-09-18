# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/lame13/wp-migrate-core/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lame13/wp-migrate-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lame13/wp-migrate-core/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/lame13/wp-migrate-core/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lame13/wp-migrate-core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lame13/wp-migrate-core/compare/v0.1.0-demo...v0.1.1
[0.1.0-demo]: https://github.com/lame13/wp-migrate-core/releases/tag/v0.1.0-demo
