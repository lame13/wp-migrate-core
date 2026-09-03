# Changelog

## [Unreleased]

- Adds read-only GitHub Actions CI for Node 20 installation, tests, and a dry-run npm package check.

## [0.1.1] - 2026-09-03

This release makes inspection safer when an export or output path is not quite what the CLI expects.

- Writes the inspection plan and repair report as one staged handoff, then moves them into place together.
- Refuses an existing inspection output path without changing its files.
- Skips missing, invalid, and duplicate WordPress post IDs and explains each skipped item in the repair queue.
- Keeps malformed numeric XML entities intact instead of letting them crash WXR parsing.
- Adds regression coverage for the parser edge cases and the CLI's no-clobber behavior.

## [0.1.0-demo] - 2026-09-02

The first public demo: inspect a WordPress WXR export, surface unsupported migration work, and generate a deliberately private Astro handoff for human review.

[Unreleased]: https://github.com/lame13/wp-migrate-core/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/lame13/wp-migrate-core/compare/v0.1.0-demo...v0.1.1
[0.1.0-demo]: https://github.com/lame13/wp-migrate-core/releases/tag/v0.1.0-demo
