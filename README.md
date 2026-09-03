# wp-migrate-core

`wp-migrate-core` is an intentionally limited, local CLI prototype for inspecting a WordPress WXR export and creating an Astro migration handoff. Version `0.1.1` uses npm's `demo` tag.

It can help expose what must be rebuilt. It does not produce a finished or production-ready WordPress replacement.

## Install

Requires Node.js 20 or later.

```bash
npm install --save-dev wp-migrate-core@demo
```

Run the included fictional fixture:

```bash
npx wp-migrate-core demo --out wp-migrate-core-demo
```

The demo writes a migration plan, a local HTML repair report, and an Astro-shaped project to `wp-migrate-core-demo/`. Open `wp-migrate-core-demo/migration-plan/report.html` locally to review the detected work.

## Commands

```text
wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro]
wp-migrate-core convert <export.xml> --out <new-site> [--target astro]
wp-migrate-core report <export.xml> [--out migration-report.html]
wp-migrate-core demo [--out wp-migrate-core-demo]
```

`inspect` validates the WXR file before writing. It creates `migration-plan.json` and a local repair report as a pair in a new output directory: if either output cannot be created, it leaves neither newly created file behind and never overwrites an existing `--out` path. `convert` writes an Astro-shaped project plus its migration manifest and repair report. `report` writes only the repair report. `demo` runs both inspection and conversion against the bundled fixture.

The `astro` target is the only enabled target. `next` and `nuxt` are registered as planned targets and deliberately fail when selected.

## What the demo handles

- Published WordPress pages and posts in a WXR export.
- Routes, authors, dates, taxonomies, source IDs, and post metadata in the migration model.
- A bounded subset of serialized Gutenberg core blocks.
- Elementor `_elementor_data` in WXR post metadata, including simple containers, headings, text, images, buttons, dividers, and spacers.
- An explicit repair queue for dynamic Gutenberg blocks, unsupported shortcodes, Elementor forms and queries, and unknown Elementor widgets.
- Items with missing, invalid, or duplicate `wp:post_id` values are skipped and added to the repair report. Correct the export before relying on the handoff.

Each detected construct is marked as `native`, `legacy-html`, `manual`, or `blocked`. Unsupported behavior stays visible in the generated output and repair queue; it is not counted as a successful conversion.

## Important limits

This package does not perform live-site extraction, authenticate with WordPress, download media, rewrite media URLs, reproduce themes or responsive layouts, compare the generated site visually or behaviorally with the source, or migrate plugin behavior such as forms, search, comments, memberships, or ecommerce.

Before treating an output as a handoff, review every blocker and warning; then verify routes, content, media, forms, dynamic behavior, metadata, accessibility, and visual behavior against the source site. Generated output is a starting point for deliberate engineering work, not a deployment artifact.

## Privacy and local handoff

The CLI reads the WXR file you provide and writes generated content to your local filesystem. It does not modify WordPress. A WXR export and the resulting migration plan, report, and generated project can contain private content, author names, source URLs, raw HTML, and post metadata.

Run it in a trusted local working directory. Treat the input and every generated output as potentially confidential: review and remove sensitive material before committing, uploading, sharing, or deploying it. The default generated directories are ignored by this repository, but that does not make their contents safe to share.

## Demo fixture

`fixtures/demo-wordpress.xml` contains fictional data only. Bright Path Plumbing, its author name, URLs under `brightpath.example`, and the fixture's page and post content exist solely to demonstrate the migration flow.

## Development

From a checkout:

```bash
npm install
npm test
npm run demo
```

## License

[MIT](LICENSE)
