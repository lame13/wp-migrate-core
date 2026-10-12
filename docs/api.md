# Programmatic API

The package has one entry point. `src/index.ts` is what `package.json` maps to
`.`, so the names re-exported there are the API and nothing else is: the
internals the destinations share, such as the page model in `src/generate.ts`,
are not reachable from an installed package.

```js
import { parseWxr, generateAstroProject, verifySite } from "wp-migrate-core";
```

Every name on this page is in [the frozen surface](compatibility.md): a minor
release may add one, a removal needs a deprecation release and then a major
release. `test/api-surface.test.ts` fails when this page and the code disagree,
in either direction.

`packageVersion` is the version of the tool you are holding. Artifact files are
versioned separately — see [artifacts.md](artifacts.md).

## Parsing an export

| Name | What it does |
| --- | --- |
| `parseWxr` | Read a WXR document and return a `MigrationProject`: records, media, routes, links, coverage, archives, menus, findings. The one entry point to the migration model. |
| `inspectWxr` | An alias of `parseWxr`, kept because the CLI command is `inspect`. |
| `InspectOptions` | The second argument: `includeDrafts`, `config`, `liveUrlSource`. |
| `MigrationProject` | Everything a run knows. Every artifact and every generator is a projection of it. |
| `MigrationSummary` | The counts the reports open with. |
| `MigrationNode` | One piece of a record's body: its source (`classic`, `gutenberg`, `elementor`), the conversion decision, and the text or HTML it carries. |
| `MigrationNodeKind` | What kind of node it is. |
| `ConversionDisposition` | How the body was mapped: `native`, `legacy-html`, `manual`, `blocked`. The question a CMS adapter answers. |
| `ContentRecord` | One post, page or custom-type item: ids, title, slug, route, dates, author, terms, nodes, issues. |
| `ContentTypeEntry` | One WordPress post type and what the run did with it: how many items, which collection, and the reason when it was left out. |
| `SourceEditor` | Which editor the record came from. |
| `WordPressContentType` | The WordPress post types this build knows by name. |
| `WordPressStatus` | WordPress publication status. |
| `WordPressPostMeta` | One `wp:postmeta` row, when it was read. |
| `WordPressTerm` | One taxonomy term on a record. |
| `MigrationIssue` | One finding: severity, code, where it is, and the action it needs. |
| `MigrationIssueSeverity` | `warning` or `blocker`. |
| `MigrationIssueCode` | The stable code for a finding, from `MIGRATION_ISSUE_CODES`. |
| `MIGRATION_ISSUE_CODES` | Every code this release can report. Grows in minor releases. |
| `contentCollectionName` | The collection a post type maps to. |
| `contentTypeLabel` | A readable label for a post type slug. |
| `normalizeRoute` | The single route a permalink becomes, shared by the plan, the manifest and the redirects. |
| `sanitizeSourceUrl` | Strip credentials, queries and fragments from a URL meant for an artifact. |
| `sanitizeLinkHref` | The same for a link, keeping the fragment. |
| `readHtmlAttribute` | Read one attribute from an HTML tag without parsing the document. |
| `mediaPath` | The path of a media reference, without query or fragment. |
| `stripMediaVariants` | Drop a WordPress size suffix such as `-1024x768`. |
| `linkRewrites` | The rewrites the plan proposes, with reporting-safe hrefs. |

## The migration config

| Name | What it does |
| --- | --- |
| `loadMigrationConfig` | Read and validate a config file. Returns `LoadedMigrationConfig` with the absolute source path and the config. |
| `parseMigrationConfig` | Validate config text you already have. Unknown keys are errors, not silence. |
| `LoadedMigrationConfig` | `{ source, config }`. |
| `MigrationConfig` | The config shape: `site`, `includeDrafts`, `keepSourceLinks`, `failOn`, `routes`, `exclude`, `ignoreIssues`, `postTypes`, `archives`, `media`. |
| `MigrationConfigRecord` | What a config decided, recorded in the plan so a handoff is traceable to it. |
| `FailureThreshold` | `none`, `warning` or `blocker`: the exit-status gate. |
| `defaultMigrationConfigFileName` | `wp-migrate-core.config.json`, the file read beside an export when `--config` is absent. |
| `migrationConfigSchemaVersion` | The config format this release reads. |
| `migrationConfigJsonSchema` | The JSON Schema for that format, built from the parser's own key lists. `wp-migrate-core schema` prints it. |
| `MIGRATION_CONFIG_KEYS` | The top-level settings. |
| `MIGRATION_CONFIG_SITE_KEYS` | The settings under `site`. |
| `MIGRATION_CONFIG_POST_TYPE_KEYS` | The settings under `postTypes`. |
| `MIGRATION_CONFIG_ARCHIVE_KEYS` | The settings under `archives`. |
| `MIGRATION_CONFIG_MEDIA_KEYS` | The settings under `media`. |
| `MIGRATION_CONFIG_FAILURE_THRESHOLDS` | The values `failOn` accepts. |
| `MIGRATION_CONFIG_ATTACHMENT_PAGE_MODES` | The values `archives.attachmentPages` accepts. |

## Destinations

| Name | What it does |
| --- | --- |
| `SUPPORTED_TARGETS` | Every target name, implemented or not, in the order the CLI and the report list them. |
| `targetDefinitions` | The registry: target, kind, `enabled`, label, description, preview origin and the command that serves it. |
| `targetAdapters` | The same facts plus the `generate` function that writes the destination. |
| `targetAvailability` | Target, kind, label and `enabled`, without the generator. |
| `targetRecords` | The manifest's `targets` block, derived from the registry. |
| `isOutputTarget` | Narrow a string to `OutputTarget`. |
| `assertTargetEnabled` | Throw the reason a target cannot be written yet. |
| `generateForTarget` | The one place a command turns a target name into output. |
| `OutputTarget` | The target name union. |
| `DestinationKind` | `static-site` or `cms`. |
| `TargetDefinition` | One registry row. |
| `TargetAdapter` | A registry row plus `generate`. |
| `DestinationGenerateOptions` | What every destination understands: `rewriteLinks`, `publishReady`. |

See [destinations.md](destinations.md) for what a destination has to provide and
how the three implemented ones differ.

## Generating a destination

| Name | What it does |
| --- | --- |
| `generateAstroProject` | Write a static Astro project. |
| `generateNextProject` | Write a static-export Next.js app: JSON content, one catch-all route, `content/routes.json`. |
| `generatePayloadBundle` | Write a Payload + Next bundle: collections, drop, admin host, importer. |
| `generatePruviousBundle` | Write a Pruvious + Nuxt bundle with the same drop shape. |
| `GenerateOptions` | `rewriteLinks` and `publishReady` for the Astro handoff. |
| `NextGenerateOptions` | The same pair for the Next handoff. |
| `PayloadGenerateOptions` | Options the Payload bundle accepts. |
| `PruviousGenerateOptions` | Options the Pruvious bundle accepts. |
| `recordBodyHtml` | The HTML a record's body is rendered from, including Elementor widgets rendered back to HTML. |
| `renderPayloadImporter` | The importer file a Payload bundle ships. |
| `renderPruviousImporterRoute` | The Nitro route a Pruvious bundle ships. |
| `pruviousMediaPath` | The media path both the Pruvious bundle and the media module agree on. |
| `htmlToPayloadRichText` | Convert the documented HTML subset to Lexical, and list what needs review. |
| `ContentReviewItem` | One part of the body the conversion would not guess at. |
| `HtmlImage` | The image shape the converter reads: `src`, `alt`, and the attributes it saw. |
| `ImageResolver` | The callback that turns a delivered image into a media reference. |
| `ImageTarget` | What the resolver returns for a matched image. |

## Media

| Name | What it does |
| --- | --- |
| `planMediaDelivery` | Read a local uploads directory and decide what happens to every referenced file. Nothing is fetched; the plan holds the absolute paths it measured. |
| `applyMediaDelivery` | Fold a plan into the project, so the report and the generated markup agree. Writes nothing. |
| `deliverMedia` | Write the files the plan measured into the generated project. |
| `rewriteDeliveredMedia` | Point markup at the delivered path or the media host. |
| `mediaDeliveryRecord` | The plan as an artifact: counts and per-file decisions without this machine's paths. |
| `MigrationMedia` | The media section of a project. |
| `MediaAsset` | One attachment in the export. |
| `MediaReference` | One place an upload is referenced. |
| `MediaReferenceKind` | What referenced it: body image, Elementor widget, featured image, linked file. |
| `MediaReferenceStatus` | Whether alt text, a matching attachment and a delivered file exist. |
| `MediaSummary` | The inventory counts. |
| `MediaDeliveryPlan` | Every measured file and the decision for it. |
| `MediaDeliveryEntry` | One file's decision: `copied`, `linked`, `remote` or `missing`. |
| `MediaDeliveryStatus` | Those four values. |
| `MediaDeliverySummary` | The delivery counts. |
| `MediaDeliveryOptions` | `uploadsDirectory`, `baseUrl`, `copyUnused`. |
| `MediaAssetDelivery` | The delivery decision recorded on an asset. |
| `MediaCopy` | One file the plan will write, with its source and output path. |

## URLs, links and redirects

| Name | What it does |
| --- | --- |
| `parseLiveUrlSource` | Read a saved sitemap, sitemap index or URL list. Never fetches. |
| `mergeLiveUrlSources` | Combine several sources into the one set a plan is checked against. |
| `coverageEntryRecords` | The sanitized shape coverage entries take in artifacts. |
| `redirectRuleFiles` | Every host rule file for the plan's redirects. |
| `renderNetlifyRedirects` | The Netlify `_redirects` file. |
| `renderVercelRedirects` | The Vercel `vercel.json` file. |
| `renderNginxRedirects` | The nginx snippet. |
| `renderApacheRedirects` | The Apache rules. |
| `RedirectRuleFile` | One generated rule file: path and contents. |
| `MigrationRoutes` | The route map: entries, redirects and their summary. |
| `RouteEntry` | One source URL and what answers it. |
| `RouteStatus` | `routed`, `redirected`, `ambiguous-url`, `unrouted`. |
| `RedirectEntry` | One path rule. |
| `RouteSummary` | The map's counts. |
| `MigrationLinks` | Every recognized link and the proposed rewrites. |
| `LinkReference` | One link in the export. |
| `LinkRewrite` | One proposed rewrite. |
| `LinkSummary` | The link counts. |
| `LinkReferenceKind` | What kind of link it is. |
| `LinkReferenceStatus` | Whether the target is served, rewritten, or needs a decision. |
| `LiveUrlSource` | The URLs a sitemap or list supplied. |
| `LiveUrlCoverage` | Every supplied URL and whether the plan answers it. |
| `LiveUrlEntry` | One URL's verdict. |
| `LiveUrlStatus` | `routed`, `redirected`, `uncovered`, `invalid`. |
| `LiveUrlShape` | What kind of URL it looks like: page, feed, media file. |
| `LiveUrlSummary` | The coverage counts. |

## Archives and menus

| Name | What it does |
| --- | --- |
| `MigrationArchives` | The archive pages and feeds this run generated. |
| `ArchivePage` | One listing page: kind, title, route, subject, and how the route was decided. |
| `ArchiveKind` | Taxonomy, author, date or posts index. |
| `ArchiveRouteSource` | Where the route came from: the export, a live URL, or the tool's own default. |
| `ArchiveSummary` | The archive counts. |
| `FeedFile` | One feed to write, and the records it lists. |
| `MigrationMenus` | The navigation WordPress served. |
| `MenuTree` | One menu. |
| `MenuItem` | One entry, with children, so a menu can nest to any depth. |
| `MenuItemKind` | What the entry points at. |
| `MenuSummary` | The menu counts. |

## Delivery checks

| Name | What it does |
| --- | --- |
| `deliveryCheckFiles` | The two paired SSRWire check files: the site being left, and the one being built. |
| `deliveryCheckTargets` | One target per planned route, in plan order. |
| `deliveryRouteIndex` | The lookups that match a saved report back to the plan. |
| `deliveryCheckTargetLimit` | How many routes a generated check file lists by default — currently 50: an audit of every route is a choice, not a default. |
| `readDeliveryEvidence` | Read a saved SSRWire audit and describe what it says about every planned route. |
| `deliveryLaunchFindings` | What that evidence adds to the publishing gate. |
| `DeliveryCheckFile` | One check file: path and contents. |
| `DeliveryCheckOptions` | `previewOrigin` and `previewCommand`, so a destination's own dev server is named. |
| `DeliveryTarget` | One audit target: id, route, source URL, preview URL. |
| `DeliveryRouteIndex` | Route, path and id lookups for matching a report. |
| `DeliveryReadOptions` | The report, and optionally the baseline to compare against. |
| `DeliveryEvidence` | What the audit said, route by route. |
| `RouteDelivery` | One route's response, metadata and crawler delivery. |
| `DeliveryStatus` | How the response came back. |
| `DeliverySummary` | The counts. |
| `DeliveryChange` | One thing that changed since a baseline. |
| `DeliveryFinding` | One problem the audit reported. |
| `DeliverySeverity` | How serious that problem is. |
| `DeliveryComparison` | Baseline versus current. |
| `RouteComparison` | One route in that comparison. |

## Launch gate and verification

| Name | What it does |
| --- | --- |
| `verifySite` | Compare a built site, a saved crawl report or a CMS import report with the export, and return the content result plus the publishing findings. |
| `sourceContentEvidence` | The text a record is expected to carry, so a comparison has something to look for. |
| `launchFindings` | Combine indexing evidence and delivery evidence into publishing findings. |
| `indexingFromSignals` | Read robots directives that a document or a response header carries. |
| `absoluteOnOrigin` | An absolute URL for a path on an origin. |
| `siteOrigin` | The origin the plan answers on, when the export names one. |
| `VerifyOptions` | `htmlDirectory`, `routelintReportPath`, `ssrwireReportPath`, `ssrwireBaselinePath`, `importReportPath`. |
| `SiteVerification` | The whole result: summary, routes, evidence and launch findings. |
| `VerifiedRoute` | One planned route and what verification found for it. |
| `VerificationSummary` | The content counts: verified, different, no content, no page, not judged. |
| `VerificationStatus` | Those verdicts. |
| `VerificationCheck` | One check the run was able to take, or a reason it could not. |
| `VerificationCheckId` | `content`, `media`, `links`, `canonical`, `robots`, `sitemap`, `delivery`, `import`. |
| `LaunchFinding` | One publishing problem, with the action it needs. |
| `LaunchFindingCode` | The stable code for a publishing problem. |
| `LaunchEvidenceSource` | Where that evidence came from. |
| `ContentIndexing` | The robots evidence collected for one route. |
| `IndexingEvidence` | The directives that were found. |
| `IndexingStatus` | Whether indexing is allowed, blocked or unknown for a route. |
| `IndexingSource` | Whether the evidence came from a document or a header. |

## CMS import evidence

| Name | What it does |
| --- | --- |
| `readImportEvidence` | Read the `migration-import.json` a generated importer wrote. |
| `importLaunchFindings` | What that report adds to the publishing gate: missing, failed, skipped and unexpected records. |
| `importReportSchemaVersion` | The import report format this release reads. |
| `ImportEvidence` | The report: summary and records. |
| `ImportRecord` | One record's outcome. |
| `ImportAction` | `created`, `updated`, `unchanged`, `skipped`, `failed`. |
| `ImportSummary` | The report's counts. |

## Reports and contracts

| Name | What it does |
| --- | --- |
| `renderReport` | The standalone HTML report. |
| `writeReport` | Write it, optionally refusing to replace an existing file. |
| `WriteReportOptions` | `noClobber`. |
| `apiStability` | `pre-release` until 1.0.0 declares the surface stable. |
| `apiContractVersion` | The contract revision this release implements. |
| `artifactContracts` | Every generated file, its `schemaVersion`, and which destinations write it. |
| `artifactSchemaVersions` | The same, keyed by artifact id. |
| `artifactContract` | One contract by id. |
| `ArtifactContract` | One row of that registry. |
| `ArtifactId` | The artifact ids. |

## Versions the generated projects are written against

| Name | What it means |
| --- | --- |
| `packageName` | `wp-migrate-core`. |
| `packageVersion` | The installed version, also written into every `generator.version`. |
| `supportedNodeRange` | The Node.js range this release supports, read from `engines`. |
| `ssrwireDependency` | The SSRWire range the generated checks are written against. |
| `nextDependency` | The Next.js range every generated front end is written against. |
| `reactDependency` | The React range that goes with it. |
| `reactDomDependency` | The React DOM range. |
| `payloadDependency` | The exact Payload release the generated bundle installs. |
| `payloadAdminDependencies` | The admin host's dependency block. |
| `pruviousDependency` | The Pruvious range the generated bundle installs. |
| `pruviousNuxtDependency` | The Nuxt range kept in step with it. |
| `pruviousEditorDependencies` | The editor extensions pinned to Pruvious's own core version. |
