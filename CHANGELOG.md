# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/lame13/wp-migrate-core/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/lame13/wp-migrate-core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lame13/wp-migrate-core/compare/v0.1.0-demo...v0.1.1
[0.1.0-demo]: https://github.com/lame13/wp-migrate-core/releases/tag/v0.1.0-demo
