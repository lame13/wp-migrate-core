# Destinations

A destination is what the export becomes. Two kinds exist: a **static-site**
destination writes pages, and a **CMS** destination writes a reviewable bundle
— collections, a content and media drop, a generated importer — that you run
inside the destination project.

Four destinations are implemented: Astro and Next.js as static sites, Payload
and Pruvious as CMS bundles. A fifth and sixth are declared and refused with a
reason, so `--target nuxt` says "planned" instead of "unknown".

## The boundary

Five places have to agree about a destination, and they read one registry
(`src/targets.ts`) so they cannot drift:

| Where | What it reads |
| --- | --- |
| The CLI | `--target` validation and the refusal message for a target this release cannot write. |
| The manifest | `targets`, and the destination block naming the structure that was written. |
| The report | The target cards: which destinations this release can write. |
| The delivery checks | The preview origin and the command that serves it, so the generated preview check runs as written. |
| The adapters | `generateForTarget`, the one place a command turns a target name into output. |

## What a destination has to provide

1. **A registry row** in `src/targets.ts`: `target`, `kind`, `enabled`, `label`,
   `description`, `previewOrigin`, `previewCommand`.
2. **A generator** in `src/adapters.ts`: `generate(project, directory, options)`,
   taking `MigrationProject` and `DestinationGenerateOptions`.
3. **The shared artifacts**, written into the handoff with the renderers in
   `src/artifacts.ts`: `migration/issues.json`, `media.json`, `redirects.json`,
   `links.json`, `coverage.json`, `archives.json`, `menus.json`, plus the
   report, the redirect rules and the paired SSRWire checks.
4. **A manifest** with a destination block and its own schema version, added to
   the registry in `src/contracts.ts` and documented in
   [artifacts.md](artifacts.md).
5. **A README** written into the handoff: what it is, how to run it, how to
   check it, and what it does not do.
6. **A structural test** in the default suite, which checks the files and the
   plan they came from.
7. **A round trip** — `npm run test:<target>` — that installs the real
   toolchain, builds the handoff, and points the launch gate at the result.
8. **No new rules in `src/core.ts`.** The parser and the migration model belong
   to every destination. If a destination needs a rule there, the model is
   wrong, not the destination — that is the boundary proving itself.

## The four implemented destinations

| | Astro | Next.js | Payload | Pruvious |
| --- | --- | --- | --- | --- |
| Kind | static site | static site | CMS | CMS |
| Built with | `astro build` | `next build` (static export) | `next build` | `nuxt build` |
| Output | `dist/` | `out/` | `.next/` plus an admin | `.output/` |
| Content | Markdown content collections | JSON plus a route index | Collections and a drop | Collections and a drop |
| Editing after the move | in your editor | in your editor | in the Payload admin | in the Pruvious dashboard |
| `verify --html-dir` | `dist` | `out` | the Next front end you build | — |
| Redirects | host rules | host rules (a static export cannot redirect) | `next.config` plus host rules | Nitro middleware plus host rules |
| Preview origin | `localhost:4321` | `localhost:3000` | `localhost:3000` | `localhost:3000` |
| Round trip | `npm test` | `npm run test:next` | `npm run test:payload` | `npm run test:pruvious` |

## The reference destination

`src/next.ts` is the one to read when adding a destination. It is the first
destination written *against* the boundary rather than inside it:

- it shares the page model with the Astro renderer — `prepareRecords`,
  `prepareListings`, `createMediaRenderer`, `renderRecordBody`, the internal
  link rewriting, the menu, the sitemap, the feed writer and every artifact;
- it decides only what files a Next app is made of;
- it added **no** rule to `src/core.ts`, and the one wording change it did force
  was in shared copy that named a renderer: findings now say "the generated
  site", because the parser serves every destination.

Two properties are worth copying from it:

- **A build output the gate can read.** `output: "export"` writes one HTML file
  per prerendered route, which is exactly what `verify --html-dir` expects.
- **Honesty about what the destination cannot do.** Next cannot serve a
  redirect from a static export, so the handoff says so and publishes the host
  rules instead of shipping a redirect that silently does nothing.

## Parked targets

`nuxt` and `svelte` are registered, disabled, and refuse with a reason. Nuxt is
next, because the Pruvious bundle already integrates with a Nuxt app and the
renderer can share its shape; Svelte follows. Until then the registry keeps
them visible, which is the point: a target that disappears from the list is a
target a script cannot discover.

## Using a destination from code

```js
import { generateForTarget, targetDefinitions, type OutputTarget } from "wp-migrate-core";

const target: OutputTarget = "next";
console.log(targetDefinitions[target].kind, targetDefinitions[target].previewOrigin);
await generateForTarget(target, project, "new-site", { publishReady: true });
```

`assertTargetEnabled(target)` throws the same reason the CLI prints when a
target cannot be written, and `targetRecords()` is the block the manifest
carries.
