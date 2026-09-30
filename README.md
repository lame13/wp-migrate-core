# wp-migrate-core

Plan a WordPress migration, generate an Astro starting point, and check the result before publishing.

`wp-migrate-core` reads a WordPress XML export (WXR) and helps you see what needs to move: content, images, URLs and links. Add a saved sitemap to find pages the export missed. It can then generate an Astro project with your content, images, a repair queue and redirect rules for Netlify, Vercel, nginx and Apache.

To include images, supply a local copy of `wp-content/uploads` or the URL of a host that already serves them. A migration config lets you save route choices, excluded pages and findings you've reviewed, so you can repeat the migration without patching the output each time.

After a build, `verify` checks for missing or substantially changed content. Add a saved SSRWire audit to check responses, metadata and indexing too.

This is an early tool, and Astro is the only supported output. You'll still need to rebuild your theme, forms and plugin behavior, bring over your media, and review the generated site.

## Try it with the demo

Requires **Node.js 22.12 or later**.

```bash
npm install --save-dev wp-migrate-core
npx wp-migrate-core demo --out wp-migrate-core-demo
```

Open `wp-migrate-core-demo/migration-plan/report.html` in your browser. The fictional Bright Path Plumbing site includes Gutenberg and Elementor content, missing features, and URLs that need attention. Explore the generated project and its checks in `wp-migrate-core-demo/astro-site/`.

The demo includes placeholder images. You'll find the copied files in `astro-site/public/wp-content/uploads/` and their delivery details in `migration/media.json`. Try `--uploads` with your own media library when you're ready to convert a real export.

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
| `migration/media.json` | Find referenced images, matching attachment records, available alt text and dimensions, uploads no included content uses, and where the generated site serves each file from. |
| `migration/redirects.json` | Review old page/post permalinks, proposed routes, path redirect rules, and URLs needing a decision. |
| `migration/links.json` | Check recognized content links, their routes, proposed rewrites, and targets this export cannot vouch for. |
| `migration/coverage.json` | Compare every live URL you supplied with the routes and rules this plan has. |
| `migration/checks/` | Audit WordPress and your preview with matching SSRWire checks. |
| `migration/redirect-rules/` | Publish the redirect rules in the format your host expects: Netlify, Vercel, nginx or Apache. |
| `migration/manifest.json` | Connect WordPress IDs to generated files and routes. |
| `public/sitemap.xml` | List the generated routes, using the configured site URL or the URL from the export. |

The redirect map uses `schemaVersion: "0.2"`, the link inventory uses `"0.3"`, the coverage check uses `"0.4"`, and the verification artefact uses `"0.6"`. The media inventory and the manifest use `"0.7"`. These describe each file's data format separately from the npm package version.

### Images

The inventory reads attachment records from the WXR and looks for images in supported Gutenberg blocks, Elementor image and background settings, Elementor text/HTML widgets, featured images, and `<img>` tags. Matching uses attachment IDs or file paths; resized, scaled, rotated, cropped, and edited filenames are matched when they identify one upload. It does not guess that files from different hosts or folders are the same image.

References are grouped per asset within each page or post. A reference is marked `matched`, `missing-alt-text`, or `not-in-export`. Alt text can come from the content or the attachment metadata; this is an inventory check, not an accessibility audit.

Missing media and alt text create one warning per problem type per content record. Unreferenced uploads stay in the inventory without adding warnings. Trashed attachments are skipped.

An attachment match tells you what the export knows about an image; it doesn't prove the file is available. Supply the files through [media delivery](#media-delivery) to include them in the generated site. Custom widgets and unsupported media formats may need a separate check.

### Media delivery

To move your images along with the content, use one of these options:

```bash
# Copy files from a local WordPress uploads directory
wp-migrate-core convert export.xml --out new-site --uploads ../wordpress/wp-content/uploads

# Keep files on a CDN or another media host
wp-migrate-core convert export.xml --out new-site --media-base https://cdn.example.com/uploads
```

`--uploads` copies referenced files into `public/wp-content/uploads/`, keeping the original upload paths. It also includes uploads listed in `--live-urls`, even if no included page uses them. Add `--copy-unused-media` to copy the other attachments in the export too. `--media-base` points the generated markup at your media host.

Image and picture sources, including `srcset`, are updated to use the delivered files. Missing alt text and dimensions are filled in from the attachment record; an existing `alt=""` is preserved. If a resized file is missing locally, the original can be used in its place. The delivery plan records that substitution.

Without either media option, images stay as repair markers. With media delivery enabled, files that couldn't be delivered keep their source URLs and appear in the inventory for review.

Each file ends up as one of four things:

| Status | What it means |
| --- | --- |
| `copied` | The uploads directory carries the file, and the copy is written into the handoff. |
| `linked` | The file stays on the media host you named, and the markup points there. |
| `remote` | No local file or media host was available, and the export has no matching attachment. The source URL is kept. |
| `missing` | A matching attachment exists, but the file couldn't be delivered. Referenced missing files produce a `MEDIA_NOT_LOCAL` warning. |

Check `migration/media.json` for the status of each file and the manifest for the totals. Neither records your local uploads directory. Files outside that directory are skipped, including symlinks that point elsewhere. Media is never downloaded: `--uploads` reads local files, and `--media-base` only writes URLs into the output.

### Migration config

Save your migration choices in `wp-migrate-core.config.json` beside the export. For example, this config chooses routes, excludes a page, accepts a reviewed finding and supplies the uploads directory:

```json
{
  "schemaVersion": "0.7",
  "site": { "title": "Bright Path Plumbing", "url": "https://www.brightpath.example" },
  "failOn": "blocker",
  "routes": {
    "?p=123": "/about/",
    "wp:post:82": "/guides/stop-a-leaking-tap/",
    "/old-pricing/": "/pricing/"
  },
  "exclude": ["wp:page:404"],
  "ignoreIssues": ["ELEMENTOR_WIDGET_UNKNOWN"],
  "media": { "uploadsDir": "../wordpress/wp-content/uploads" }
}
```

Use `--config <file>` to load a config from somewhere else. Route and exclusion keys can be content ids (`wp:page:12`), exported paths (`/old-page/`), query permalinks (`?p=123`) or full exported URLs. Relative `media.uploadsDir` paths are resolved from the config file's directory.

Command-line options override the corresponding config settings. Unknown settings and invalid values stop the run with an error. A route or exclusion that matches no item produces a `CONFIG_ENTRY_UNMATCHED` warning.

`ignoreIssues` accepts finding codes you've reviewed. Those findings stay in the plan as `ignored` and appear as waived in the report, but don't count towards warnings, blockers or `--fail-on`.

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

RouteLint measures normalized text; the comparison uses word counts and 64-bit SimHash distances. Records below 12 words are not compared. A page with no words or less than 10% of the source word count is a blocker; less than 60% or a SimHash distance above 12 bits is a warning. These are heuristics: navigation and boilerplate can affect the result, so review both passing pages and findings. `migration-verification.json` (schema version `0.6`) stores counts, fingerprint distances, delivery finding codes and indexing decisions, and never the text of either page. Routes and local file paths remain visible. Layout, media and behavior still need separate review.

### Check responses and metadata

A build folder tells you what was generated. To check what your server actually sends, save an [SSRWire](https://www.npmjs.com/package/ssrwire) audit and pass it to `verify` alongside `--html-dir` or `--routelint-report`.

The generated Astro project includes two check files under `migration/checks/`. One targets the WordPress URLs; the other targets your preview at `http://localhost:4321`. They use matching IDs so the reports can compare the same pages across different domains.

Capture the WordPress site **before moving DNS**:

```bash
cd new-site
npm install
npm run check:source
```

Then build and start your preview:

```bash
npm run build
npm run preview
```

In another terminal, from `new-site`, capture the preview and compare both reports:

```bash
npm run check:preview
npx wp-migrate-core verify ../export.xml --html-dir dist \
  --ssrwire-report ssrwire-preview.json --ssrwire-baseline ssrwire-source.json
```

The scripts write `ssrwire-source.json` and `ssrwire-preview.json`. They save findings without failing on them, but still fail if the audit cannot complete. `verify --fail-on` controls which findings stop your migration check. You can omit `--ssrwire-baseline` if you only have a preview audit.

Both checks ask for a title, description, canonical URL, H1, main text, Open Graph tags and Twitter Card tags. If WordPress served `og:image` and the new page loses it, the report names that tag and the affected routes. A shared layout problem is grouped into one finding where possible.

| Finding | What needs attention |
| --- | --- |
| `INDEXING_BLOCKED` | A meta robots tag or `X-Robots-Tag` header tells search engines not to index the page. |
| `DELIVERY_FAILED` | At least one request returned an unsuccessful status. |
| `DELIVERY_INCOMPLETE` | A request timed out, was truncated, or otherwise failed to finish. |
| `DELIVERY_CONTRACT` | The response failed a configured SSRWire check, such as a required canonical URL. |
| `DELIVERY_REGRESSION` | The comparison found a new problem, slower delivery or lost social metadata. |
| `DELIVERY_UNOBSERVED` | Some routes have no audit evidence, or their source audit is unusable. |

The generated checks cover the **first 50 planned routes**. Edit both files to cover more pages or point the preview check at a deployed site. Partial coverage produces a warning; a report that covers none of the plan is a blocker. A missing or unsuccessful source capture produces a warning and cannot establish a regression. Problems observed on the new site still count.

`--fail-on blocker` fails on missing content or pages, blocked indexing, failed responses and delivery findings marked as blockers. `--fail-on warning` also includes changed content, contract warnings, timing regressions, lost social tags and incomplete audit coverage.

The generated site starts with `noindex, nofollow` in its layout and `Disallow: /` in `public/robots.txt`. Remove both before publishing. **`verify` detects page and response indexing directives; it does not check `robots.txt`.**

`verify` reads saved files and never runs a browser or requests a URL. Keep the original SSRWire reports for full timings and metadata values; the migration report includes only the details needed to review the findings.

## Commands and options

```text
wp-migrate-core inspect <export.xml> [--out migration-plan] [--target astro] [--live-urls sitemap.xml]
wp-migrate-core convert <export.xml> --out <new-site> [--target astro] [--live-urls sitemap.xml]
wp-migrate-core convert <export.xml> --out <new-site> --uploads ../wordpress/wp-content/uploads
wp-migrate-core convert <export.xml> --out <new-site> --media-base https://cdn.example.com/uploads
wp-migrate-core report <export.xml> [--out migration-report.html] [--live-urls sitemap.xml]
wp-migrate-core verify <export.xml> --html-dir dist [--out migration-verification.json]
wp-migrate-core verify <export.xml> --routelint-report routelint.json
wp-migrate-core verify <export.xml> --html-dir dist --ssrwire-report ssrwire-preview.json
wp-migrate-core verify <export.xml> --html-dir dist --ssrwire-report ssrwire-preview.json --ssrwire-baseline ssrwire-source.json
wp-migrate-core demo [--out wp-migrate-core-demo] [--live-urls sitemap.xml]
wp-migrate-core --version
wp-migrate-core inspect --help
```

`report` writes just the HTML report. `verify` compares a built site, or a saved RouteLint report, with the export, and adds delivery evidence when you give it an SSRWire audit. `demo` runs inspection and conversion using the bundled fixture, including its small uploads directory. `--config` applies a migration config to any command; `--uploads`, `--media-base` and `--copy-unused-media` belong to `convert` and `demo`, because they write files into a generated project. `--help` / `-h` works after any command; `--version` / `-v` prints the installed version. `next` and `nuxt` are planned targets and currently return an error.

| Option | What it does |
| --- | --- |
| `--include-drafts` | Includes non-published posts and pages, such as drafts, pending, and private items. The default reads published content only. |
| `--keep-source-links` | Keeps exported link targets in the generated content instead of rewriting same-site links to the generated routes. |
| `--config <file>` | Reads a migration config that decides routes, excludes items, waives reviewed findings, and supplies the media source. Without it, a `wp-migrate-core.config.json` next to the export is used. |
| `--uploads <dir>` | Copies referenced uploads from a local copy of the media library into the generated site. Nothing is fetched: the directory has to exist on this machine. |
| `--media-base <url>` | Points the generated markup at a host that already serves the uploads, such as a CDN origin, instead of copying files. |
| `--copy-unused-media` | Also delivers attachments no included content record references, for uploads whose URLs still have to resolve. |
| `--live-urls <file>` | Compares a downloaded sitemap, sitemap index, or URL list with the routes and rules in the plan. Repeat it to check several files. It reads local files only and never fetches one. |
| `--html-dir <dir>` | Compares every planned route with the page built for it in a local directory, such as Astro's `dist`. |
| `--routelint-report <file>` | Reads a saved RouteLint JSON report instead of a local build, for a site that is already crawled. |
| `--ssrwire-report <file>` | Adds delivery evidence from a saved SSRWire JSON audit: response status, metadata and crawler delivery per planned route. |
| `--ssrwire-baseline <file>` | Compares that audit with one taken before the migration. The two reports pair up on their target ids. |
| `--json` | Prints one JSON result instead of the terminal summary, with scan settings, counts for every inventory, sanitized issues, output paths, and a `failed` flag. Full inventories are in the output files. |
| `--fail-on none\|warning\|blocker` | Exits unsuccessfully for findings at or above the chosen severity, after writing the output. Defaults to `none`. |

For a CI check that stops on blockers while keeping the report available:

```bash
npx wp-migrate-core inspect export.xml --out migration-plan --json --fail-on blocker
```

Argument, input, and write errors go to stderr without a JSON result. A successful command with no severity gate does not mean the migration is complete.

## What still needs manual work

The parser supports a limited subset of Gutenberg blocks and Elementor data. It keeps classic HTML for review and flags dynamic blocks, unsupported shortcodes, forms, queries, and unknown widgets. Items with missing, invalid, or duplicate WordPress IDs are skipped and reported.

You'll need to rebuild the theme, responsive layouts and features such as forms, search, comments, memberships and ecommerce. Media delivery copies files or updates their URLs; it doesn't recreate missing images or the original design. Content verification compares text, so review layout, images and behavior yourself. URL coverage is limited to the files you supply; include every relevant sitemap.

SSRWire audits capture one point in time using crawler user-agent strings. They don't prove what a real search engine will receive or how a shared link will look. Repeat the preview audit after changing your layout or host, and check browser behavior, accessibility and social previews manually. Review and publish the generated redirect rules on your host.

## Your data stays local

The migration commands read your export, migration config, saved sitemaps, uploads directory, build output and reports, then write local files. They make no network requests and don't change WordPress or your hosting configuration: a media base URL is written into the generated markup, never fetched. Installing dependencies uses npm, and running the generated SSRWire scripts makes requests to the sites listed in their check files.

Exports and generated files can contain private content, names, URLs and post metadata. Review them before committing, sharing or deploying them. Plan, report and inventory URLs omit credentials and query strings; link fields retain fragments. Generated content can still contain source markup and link query strings, so these files are not anonymized. Media delivery omits local directory paths, but preserves the files themselves, including any embedded metadata.

The verification JSON stores content counts, fingerprint distances, finding codes, field names, crawler profiles, metadata presence and numeric timings. It does not copy page text or the metadata values compared by SSRWire. Keep the original audits locally if you need those details.

## Use it from JavaScript

```js
import { readFile } from 'node:fs/promises';
import {
  applyMediaDelivery,
  deliveryCheckFiles,
  deliveryLaunchFindings,
  generateAstroProject,
  linkRewrites,
  loadMigrationConfig,
  planMediaDelivery,
  parseLiveUrlSource,
  parseWxr,
  readDeliveryEvidence,
  redirectRuleFiles,
  verifySite
} from 'wp-migrate-core';

const xml = await readFile('export.xml', 'utf8');
const liveUrlSource = parseLiveUrlSource(await readFile('sitemap.xml'));
const { config } = await loadMigrationConfig('wp-migrate-core.config.json');
const parsed = parseWxr(xml, { config, liveUrlSource });

console.log(parsed.media.summary);
console.log(parsed.routes.redirects);
console.log(parsed.links.summary);
console.log(parsed.coverage.summary);
console.log(linkRewrites(parsed.links));
console.log(redirectRuleFiles(parsed));
console.log(deliveryCheckFiles(parsed).map((file) => file.path));

// Decide what the generated site does with every referenced image, then write it.
const mediaPlan = await planMediaDelivery(parsed, { uploadsDirectory: '../wordpress/wp-content/uploads' });
const project = applyMediaDelivery(parsed, mediaPlan);
console.log(project.media.delivery.summary);
await generateAstroProject(project, 'new-site');

// The same check the CLI runs: content evidence plus both audits.
const verification = await verifySite(project, {
  htmlDirectory: 'new-site/dist',
  ssrwireReportPath: 'ssrwire-preview.json',
  ssrwireBaselinePath: 'ssrwire-source.json'
});
console.log(verification.summary);
console.log(verification.launch);

// Or read the delivery evidence on its own.
const delivery = await readDeliveryEvidence(project, { reportPath: 'ssrwire-preview.json' });
console.log(delivery.summary);
console.log(deliveryLaunchFindings(delivery));
```

Pass `{ includeDrafts: true }` as the second argument to include non-published content, and `parseLiveUrlSource(contents, { sourcePath: 'sitemap.xml' })` to name the file in an error message. `mergeLiveUrlSources([...])` combines several files, and `coverageEntryRecords(project.coverage)` is the sanitized shape the CLI writes. `generateAstroProject(project, directory, { rewriteLinks: false })` is the library equivalent of `--keep-source-links`. The library model also retains raw source content, link targets, and metadata; handle it with the same care as the export.

`loadMigrationConfig(path)` reads a config file and `parseMigrationConfig(text)` validates one you already have; either way it is the `config` option for `parseWxr`. `planMediaDelivery(project, { uploadsDirectory })` reads the files and measures them, `applyMediaDelivery(project, plan)` folds the decisions into the project, and `generateAstroProject()` then writes the copies along with the rewritten markup. `mediaDeliveryRecord(plan)` is the sanitized shape the artifacts use. A plan holds the absolute paths it read, so keep it out of anything you publish; `applyMediaDelivery` never copies a file itself, which is what lets a caller inspect the plan before anything is written.

`verifySite()` requires either `htmlDirectory` or `routelintReportPath`; the SSRWire report and baseline are optional additions. Its `launch` list contains the publishing findings. Use `readDeliveryEvidence()` and `deliveryLaunchFindings()` when you only need the audit results. For custom integrations, `deliveryCheckTargets()` maps routes to audit targets, and `launchFindings({ indexing, delivery })` combines audit results with indexing evidence from `indexingFromSignals()`.

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
