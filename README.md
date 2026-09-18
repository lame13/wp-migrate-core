# wp-migrate-core

Moving a WordPress site to Astro? Start by finding out what you can carry over and what you need to rebuild.

`wp-migrate-core` reads a WordPress XML export (WXR) and gives you a local review report, an inventory of referenced images, a map of old URLs to proposed routes, and a link map of what the generated content will actually point at. It can also generate an Astro project with your content and visible reminders where work remains.

This is an early migration tool. Expect a starting point for rebuilding your site: themes, layouts, forms, and plugin behavior still need your attention. Astro is the only supported output target.

## Try it with the demo

Requires **Node.js 20 or later**.

```bash
npm install --save-dev wp-migrate-core
npx wp-migrate-core demo --out wp-migrate-core-demo
```

Open `wp-migrate-core-demo/migration-plan/report.html` in your browser. The fictional Bright Path Plumbing site includes Gutenberg content, Elementor widgets, images, and features that need rebuilding. The generated Astro project is in `wp-migrate-core-demo/astro-site/`.

## Use your own export

Save your WordPress WXR export as `export.xml`, then inspect it:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan
```

Open `migration-plan/report.html` to see the repair queue, media inventory, URL map, and link map. `migration-plan/migration-plan.json` contains the detailed plan if you want to work with it in code.

When you are ready to work on the Astro project:

```bash
npx wp-migrate-core convert export.xml --out new-site
cd new-site
npm install
npm run dev
```

Choose a new output directory for each run. Inspection refuses an existing output path; conversion accepts a new or empty directory and refuses to overwrite files.

The project starts with indexing disabled and placeholders for source images and unsupported behavior. Review the report, bring in your media, rebuild the missing features, and compare the result with WordPress before publishing.

## What you get

Alongside the generated content in `src/content/pages/` and `src/content/posts/`, conversion writes:

| File | Use it to |
| --- | --- |
| `migration/report.html` | Read the findings and work through the repair queue. |
| `migration/issues.json` | Process warnings and blockers in your own tooling. |
| `migration/media.json` | Find referenced images, matching attachment records, available alt text and dimensions, and uploads no included content uses. |
| `migration/redirects.json` | Review old page/post permalinks, proposed routes, path redirect rules, and URLs needing a decision. |
| `migration/links.json` | Check recognized content links, their routes, proposed rewrites, and targets this export cannot vouch for. |
| `migration/manifest.json` | Connect WordPress IDs to generated files and routes. |

The media inventory and redirect map use `schemaVersion: "0.2"`; the manifest and link inventory use `"0.3"`. These describe each file's data format separately from the npm package version.

### Images

The inventory reads attachment records from the WXR and looks for images in supported Gutenberg blocks, Elementor image and background settings, Elementor text/HTML widgets, featured images, and `<img>` tags. Matching uses attachment IDs or file paths; resized, scaled, rotated, cropped, and edited filenames are matched when they identify one upload. It does not guess that files from different hosts or folders are the same image.

References are grouped per asset within each page or post. A reference is marked `matched`, `missing-alt-text`, or `not-in-export`. Alt text can come from the content or the attachment metadata; this is an inventory check, not an accessibility audit.

Missing media and alt text create one warning per problem type per content record. Unreferenced uploads stay in the inventory without adding warnings. Trashed attachments are skipped.

**No media is downloaded, copied, or rewritten.** A match means an attachment record was found in the export; it does not establish that the file is available or ready to publish. Custom widgets and other unsupported media formats may need a separate check.

### URLs and redirects

The map covers page and post permalinks in the export, including items excluded from the scan or skipped because of invalid IDs. It does not discover live-site URLs, attachment pages, custom post types, or archive routes.

For example, an exported `/guides/stop-a-leaking-tap` becomes `/guides/stop-a-leaking-tap/`, so the map includes that redirect. Apply reviewed rules on your hosting platform yourself.

Query-string permalinks such as `?p=123` need a manual decision and never become automatic path redirects. Colliding routes are listed in the map, and conversion refuses to generate duplicate routes. `targetRoute` on an unresolved entry is a proposed path, not an approved mapping for that source URL.

### Links

The link map reads `<a href>` from rendered HTML and from Elementor text and HTML widgets, button settings in Gutenberg and Elementor, and reports one entry per distinct href per page or post.

Each link is one of five things: it already resolves to the generated route, it needs rewriting, the export knows the URL but generates no page for it, it points at a same-site URL no item in this export declares, or it leaves the site. Links are classified against the same route map the redirect inventory uses, so the two always agree.

Conversion rewrites same-site links whose target route differs — a missing trailing slash, a permalink form, an absolute link back to the source domain — so the generated content points at its own routes. It preserves query strings and fragments while doing so, and leaves everything else exactly as the export wrote it. Pass `--keep-source-links` to keep the original targets in the content; the link inventory still lists every rewrite that was skipped.

This is a static check. It does not request any URL, so it cannot tell you whether an external link is alive, whether a target redirects on the live site, or whether a link that resolves today actually serves the page you expect. `outside-export` means the export you provided does not contain that URL, not that the page is gone.

Missing and unverifiable targets create one warning per problem type per content record. Link rewrites do not, because they are a change the tool made and reported rather than work left for you.

## Commands and options

```text
wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro]
wp-migrate-core convert <export.xml> --out <new-site> [--target astro]
wp-migrate-core report <export.xml> [--out migration-report.html]
wp-migrate-core demo [--out wp-migrate-core-demo]
wp-migrate-core --version
wp-migrate-core inspect --help
```

`report` writes just the HTML report. `demo` runs inspection and conversion using the bundled fixture. `--help` / `-h` works after any command; `--version` / `-v` prints the installed version. `next` and `nuxt` are planned targets and currently return an error.

| Option | What it does |
| --- | --- |
| `--include-drafts` | Includes non-published posts and pages, such as drafts, pending, and private items. The default reads published content only. |
| `--keep-source-links` | Keeps exported link targets in the generated content instead of rewriting same-site links to the generated routes. |
| `--json` | Prints one JSON result instead of the terminal summary, with scan settings, counts for every inventory, sanitized issues, output paths, and a `failed` flag. Full inventories are in the output files. |
| `--fail-on none\|warning\|blocker` | Exits unsuccessfully for findings at or above the chosen severity, after writing the output. Defaults to `none`. |

For a CI check that stops on blockers while keeping the report available:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan --json --fail-on blocker
```

Argument, input, and write errors go to stderr without a JSON result. A successful command with no severity gate does not mean the migration is complete.

## What still needs manual work

The parser supports a limited subset of Gutenberg blocks and Elementor data. It keeps classic HTML for review and flags dynamic blocks, unsupported shortcodes, forms, queries, and unknown widgets. Items with missing, invalid, or duplicate WordPress IDs are skipped and reported.

The tool does not reproduce your theme or responsive layouts, migrate plugin behavior, or replace forms, search, comments, memberships, or ecommerce. It does not compare the generated site with the original, and it never checks a link over the network. Verify content, routes, redirects, links, media, metadata, accessibility, and behavior before deployment.

## Your data stays local

The migration commands read the file you provide and write to your filesystem. They make no network calls, require no WordPress credentials, and do not modify WordPress. Installing the tool or the generated project's dependencies uses npm as usual.

Treat the export and generated files as potentially confidential. They can contain private content, names, source URLs, HTML, and post metadata. The review plan, report, and inventory URL fields omit credentials and query strings; link fields retain fragments. These files are not anonymized. Generated content retains supported source markup and link query strings, with same-site hrefs rewritten by default. Review outputs before committing, sharing, or deploying them.

## Use it from JavaScript

```js
import { readFile } from 'node:fs/promises';
import { linkRewrites, parseWxr } from 'wp-migrate-core';

const xml = await readFile('export.xml', 'utf8');
const project = parseWxr(xml);

console.log(project.media.summary);
console.log(project.routes.redirects);
console.log(project.links.summary);
console.log(linkRewrites(project.links));
```

Pass `{ includeDrafts: true }` as the second argument to include non-published content. `generateAstroProject(project, directory, { rewriteLinks: false })` is the library equivalent of `--keep-source-links`. The library model also retains raw source content, link targets, and metadata; handle it with the same care as the export.

## Development

From a checkout:

```bash
npm ci
npm test
npm run test:package
npm run demo
```

The package check builds a tarball, installs it in a temporary project outside the checkout, and exercises the executable, demo, types, and ESM exports. It cleans up its temporary files afterward.

The bundled fixture contains fictional data only. See the [changelog](CHANGELOG.md) for release history and [GitHub issues](https://github.com/lame13/wp-migrate-core/issues) to report a bug.

## License

[MIT](LICENSE)
