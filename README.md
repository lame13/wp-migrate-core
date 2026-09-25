# wp-migrate-core

Moving a WordPress site to Astro? Start by finding out what you can carry over and what you need to rebuild.

`wp-migrate-core` reads a WordPress XML export (WXR) and gives you a local review report, an inventory of referenced images, a map of old URLs to proposed routes, and a link map of what the generated content will actually point at. Save the sitemap of the live site and it also checks every live URL against those routes, so you can see which URLs the new site would stop serving. It can generate an Astro project with your content, visible reminders where work remains, and redirect rules for Netlify, Vercel, nginx and Apache.

This is an early migration tool. Expect a starting point for rebuilding your site: themes, layouts, forms, and plugin behavior still need your attention. Astro is the only supported output target. After you build the project, `verify` compares each planned route with the page that was built for it and reports the ones that arrived empty.

## Try it with the demo

Requires **Node.js 22.12 or later**.

```bash
npm install --save-dev wp-migrate-core
npx wp-migrate-core demo --out wp-migrate-core-demo
```

Open `wp-migrate-core-demo/migration-plan/report.html` in your browser. The fictional Bright Path Plumbing site includes Gutenberg content, Elementor widgets, images, features that need rebuilding, and a sitemap with URLs the export does not carry. The generated Astro project, its coverage check and its redirect rules are in `wp-migrate-core-demo/astro-site/`.

![Version 0.4.0 migration report for the fictional Bright Path Plumbing site, showing blockers and the source summary.](https://raw.githubusercontent.com/lame13/wp-migrate-core/v0.4.0/docs/screenshots/demo-report.png)

[View the live URL coverage screenshot.](https://raw.githubusercontent.com/lame13/wp-migrate-core/v0.4.0/docs/screenshots/url-coverage.png)

## Use your own export

Save your WordPress WXR export as `export.xml`, then inspect it:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan
```

Open `migration-plan/report.html` to see the repair queue, media inventory, URL map, and link map. `migration-plan/migration-plan.json` contains the detailed plan if you want to work with it in code.

Then check the URLs your live site already serves. Download the sitemap yourself and pass the local file; the tool never fetches one:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan-with-coverage --live-urls sitemap.xml
```

Repeat `--live-urls` to check several files, such as the child sitemaps of a sitemap index. The report then lists every live URL that no route and no rule accounts for.

When you are ready to work on the Astro project:

```bash
npx wp-migrate-core convert export.xml --out new-site --live-urls sitemap.xml
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
| `migration/coverage.json` | Compare every live URL you supplied with the routes and rules this plan has. |
| `migration/redirect-rules/` | Publish the redirect rules in the format your host expects: Netlify, Vercel, nginx or Apache. |
| `migration/manifest.json` | Connect WordPress IDs to generated files and routes. |

The media inventory and redirect map use `schemaVersion: "0.2"`, the link inventory uses `"0.3"`, the manifest and coverage check use `"0.4"`, and the verification artefact uses `"0.5"`. These describe each file's data format separately from the npm package version.

### Images

The inventory reads attachment records from the WXR and looks for images in supported Gutenberg blocks, Elementor image and background settings, Elementor text/HTML widgets, featured images, and `<img>` tags. Matching uses attachment IDs or file paths; resized, scaled, rotated, cropped, and edited filenames are matched when they identify one upload. It does not guess that files from different hosts or folders are the same image.

References are grouped per asset within each page or post. A reference is marked `matched`, `missing-alt-text`, or `not-in-export`. Alt text can come from the content or the attachment metadata; this is an inventory check, not an accessibility audit.

Missing media and alt text create one warning per problem type per content record. Unreferenced uploads stay in the inventory without adding warnings. Trashed attachments are skipped.

**No media is downloaded, copied, or rewritten.** A match means an attachment record was found in the export; it does not establish that the file is available or ready to publish. Custom widgets and other unsupported media formats may need a separate check.

### URLs and redirects

The map covers page and post permalinks in the export, including items excluded from the scan or skipped because of invalid IDs. It does not discover live-site URLs, attachment pages, custom post types, or archive routes.

For example, an exported `/guides/stop-a-leaking-tap` becomes `/guides/stop-a-leaking-tap/`, so the map includes that redirect. Apply reviewed rules on your hosting platform yourself.

Query-string permalinks such as `?p=123` need a manual decision and never become automatic path redirects. Colliding routes are listed in the map, and conversion refuses to generate duplicate routes. `targetRoute` on an unresolved entry is a proposed path, not an approved mapping for that source URL.

Conversion writes the rules this map describes in the formats hosts expect, under `migration/redirect-rules/`. See [redirect rules](#redirect-rules).

### Links

The link map reads `<a href>` from rendered HTML and from Elementor text and HTML widgets, button settings in Gutenberg and Elementor, and reports one entry per distinct href per page or post.

Each link is one of five things: it already resolves to the generated route, it needs rewriting, the export knows the URL but generates no page for it, it points at a same-site URL no item in this export declares, or it leaves the site. Links are classified against the same route map the redirect inventory uses, so the two always agree.

Conversion rewrites same-site links whose target route differs — a missing trailing slash, a permalink form, an absolute link back to the source domain — so the generated content points at its own routes. It preserves query strings and fragments while doing so, and leaves everything else exactly as the export wrote it. Pass `--keep-source-links` to keep the original targets in the content; the link inventory still lists every rewrite that was skipped.

This is a static check. It does not request any URL, so it cannot tell you whether an external link is alive, whether a target redirects on the live site, or whether a link that resolves today actually serves the page you expect. `outside-export` means the export you provided does not contain that URL, not that the page is gone.

Missing and unverifiable targets create one warning per problem type per content record. Link rewrites do not, because they are a change the tool made and reported rather than work left for you.

### Live URLs and coverage

`--live-urls` reads the file you give it: a downloaded sitemap, a sitemap index, or a plain list with one URL or path per line, and it can be repeated to check several files at once. A sitemap index names child sitemaps this tool does not fetch, so pass those files as well; the report says how many it saw.

Every live URL is then one of six things: served by a generated route, covered by a proposed redirect rule that still has to be published, declared by the export but left without a confirmed route, a WordPress shape no static route serves, on a different host, or uncovered. The shapes listed rather than pursued are feeds, uploads, WordPress endpoints, category and tag archives, date archives, author archives, paginated archives and query-string URLs, each with the reason it has no route.

Every uncovered URL gets its own warning, so `--fail-on warning` can stop a migration that would drop URLs, and a source that lists no readable URLs gets a warning of its own. Excluded WordPress shapes and URLs declared by excluded content still need a decision; the uncovered-URL gate does not cover those categories. Unreadable entries are counted separately without echoing their contents.

A trailing slash is part of the URL. `/guides/tap` and `/guides/tap/` are compared separately, so a route that serves one of them does not cover the other.

The check compares paths against the URLs you supplied. It requests nothing, so it cannot tell you whether a live URL still returns a page, where it redirects today, or what a URL serves that you did not supply. URLs are compared by host and path; credentials, query strings and fragments never reach a report, a plan or an inventory, and an entry that cannot be read is never echoed.

### Redirect rules

Conversion writes the redirect map in four formats under `migration/redirect-rules/`: Netlify `_redirects`, `vercel.json`, an nginx server snippet, and an Apache `.htaccess`. Each file is a starting point to review; nothing is uploaded, and no file is written when the plan needs no rule.

- Netlify normalizes trailing slashes before matching, so slash-only changes are recorded as comments and rely on [Pretty URLs](https://docs.netlify.com/manage/routing/redirects/redirect-options/#trailing-slash). Enable it on the host; a slash-only redirect rule can loop.
- Vercel uses literal path patterns with an explicit end anchor, so a rule cannot also match its trailing-slash destination.
- nginx matches the original request URI, preserving percent-encoded paths and repeated slashes. Include the snippet inside the site's `server` block.
- Apache uses `mod_rewrite` conditions on the original request, with encoded destinations protected against backreference expansion and double encoding. Put the rules in the document root's `.htaccess` or the site's server configuration. URLs containing encoded slashes also require `AllowEncodedSlashes NoDecode` in server configuration.

Check these files alongside any existing redirects and host URL-normalization settings before publishing.

### Verification

`verify` compares the site you built — or a site someone already crawled — with the export, and reports the routes whose content did not arrive. It reads local files only and makes no network request.

```bash
cd new-site
npm install
npm run build
npx wp-migrate-core verify ../export.xml --html-dir dist --out migration-verification.json --fail-on blocker
```

`--html-dir` reads `*.html` from a directory, so point it at the `dist` folder after `astro build`. Both `guides/tap/index.html` and file-style `guides/tap.html` map to the planned `/guides/tap/` content route. This checks content on disk; it does not establish the host's trailing-slash behavior. Conflicting files for one route, duplicate planned routes and exports with no planned routes are rejected.

Pass `--routelint-report` instead when the site is already crawled: [RouteLint](https://www.npmjs.com/package/routelint)'s JSON report carries the same content evidence, so nothing has to be fetched again. Planned routes use the report's origin, allowing staging domains; other origins are excluded. The browser response is preferred when available, otherwise the first response is used. Failed or incomplete responses and redirects to a different URL cannot verify a route. Older compatible reports without content evidence leave the comparison unjudged.

Every planned route is classified as `verified`, `diverged` (substantially less or different text), `missing-content`, `route-missing`, or `skipped` (too little source text or no observed content evidence). Missing pages remain blockers even for short records. `--fail-on blocker` gates on missing pages and nearly empty content; `--fail-on warning` also gates on diverged text. The summary separately counts observed pages without a `<title>` and without an `<h1>`.

RouteLint measures normalized text; the comparison uses word counts and 64-bit SimHash distances. Records below 12 words are not compared. A page with no words or less than 10% of the source word count is a blocker; less than 60% or a SimHash distance above 12 bits is a warning. These are heuristics: navigation and boilerplate can affect the result, so review both passing pages and findings. `migration-verification.json` (schema version `0.5`) stores counts and fingerprint distances, never either side's text. Routes and local file paths remain visible. Layout, media and behavior still need separate review.

## Commands and options

```text
wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro] [--live-urls sitemap.xml]
wp-migrate-core convert <export.xml> --out <new-site> [--target astro] [--live-urls sitemap.xml]
wp-migrate-core report <export.xml> [--out migration-report.html] [--live-urls sitemap.xml]
wp-migrate-core verify <export.xml> --html-dir dist [--out migration-verification.json]
wp-migrate-core verify <export.xml> --routelint-report routelint.json
wp-migrate-core demo [--out wp-migrate-core-demo] [--live-urls sitemap.xml]
wp-migrate-core --version
wp-migrate-core inspect --help
```

`report` writes just the HTML report. `verify` compares a built site, or a saved RouteLint report, with the export. `demo` runs inspection and conversion using the bundled fixture. `--help` / `-h` works after any command; `--version` / `-v` prints the installed version. `next` and `nuxt` are planned targets and currently return an error.

| Option | What it does |
| --- | --- |
| `--include-drafts` | Includes non-published posts and pages, such as drafts, pending, and private items. The default reads published content only. |
| `--keep-source-links` | Keeps exported link targets in the generated content instead of rewriting same-site links to the generated routes. |
| `--live-urls <file>` | Compares a downloaded sitemap, sitemap index, or URL list with the routes and rules in the plan. Repeat it to check several files. It reads local files only and never fetches one. |
| `--html-dir <dir>` | Compares every planned route with the page built for it in a local directory, such as Astro's `dist`. |
| `--routelint-report <file>` | Reads a saved RouteLint JSON report instead of a local build, for a site that is already crawled. |
| `--json` | Prints one JSON result instead of the terminal summary, with scan settings, counts for every inventory, sanitized issues, output paths, and a `failed` flag. Full inventories are in the output files. |
| `--fail-on none\|warning\|blocker` | Exits unsuccessfully for findings at or above the chosen severity, after writing the output. Defaults to `none`. |

For a CI check that stops on blockers while keeping the report available:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan --json --fail-on blocker
```

Argument, input, and write errors go to stderr without a JSON result. A successful command with no severity gate does not mean the migration is complete.

## What still needs manual work

The parser supports a limited subset of Gutenberg blocks and Elementor data. It keeps classic HTML for review and flags dynamic blocks, unsupported shortcodes, forms, queries, and unknown widgets. Items with missing, invalid, or duplicate WordPress IDs are skipped and reported.

The tool does not reproduce your theme or responsive layouts, migrate plugin behavior, or replace forms, search, comments, memberships, or ecommerce. `verify` compares a built site with the export, but only when you point it at a local build or a saved report, and only for text: it does not compare layout, styling, media, or behavior, and it never checks a link or a live URL over the network. Coverage only reflects the URLs you supplied: a sitemap that omits a page hides that page, and a sitemap index has to be expanded by hand. It also does not publish the redirect rules it writes. Verify content, routes, redirects, links, media, metadata, accessibility, and behavior before deployment.

## Your data stays local

The migration commands read the files you provide — the export, for coverage a sitemap or URL list you saved yourself, and for verification a built site directory or a saved RouteLint report — and write to your filesystem. They make no network calls, require no WordPress credentials, and do not modify WordPress or your host configuration. Installing the tool or the generated project's dependencies uses npm as usual.

Treat the export and generated files as potentially confidential. They can contain private content, names, source URLs, HTML, and post metadata. The review plan, report, and inventory URL fields omit credentials and query strings; link fields retain fragments. These files are not anonymized. Generated content retains supported source markup and link query strings, with same-site hrefs rewritten by default. Review outputs before committing, sharing, or deploying them.

## Use it from JavaScript

```js
import { readFile } from 'node:fs/promises';
import { linkRewrites, parseLiveUrlSource, parseWxr, redirectRuleFiles, verifySite } from 'wp-migrate-core';

const xml = await readFile('export.xml', 'utf8');
const liveUrlSource = parseLiveUrlSource(await readFile('sitemap.xml'));
const project = parseWxr(xml, { liveUrlSource });

console.log(project.media.summary);
console.log(project.routes.redirects);
console.log(project.links.summary);
console.log(project.coverage.summary);
console.log(linkRewrites(project.links));
console.log(redirectRuleFiles(project));
console.log((await verifySite(project, { htmlDirectory: 'new-site/dist' })).summary);
```

Pass `{ includeDrafts: true }` as the second argument to include non-published content, and `parseLiveUrlSource(contents, { sourcePath: 'sitemap.xml' })` to name the file in an error message. `mergeLiveUrlSources([...])` combines several files, and `coverageEntryRecords(project.coverage)` is the sanitized shape the CLI writes. `generateAstroProject(project, directory, { rewriteLinks: false })` is the library equivalent of `--keep-source-links`. The library model also retains raw source content, link targets, and metadata; handle it with the same care as the export.

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
