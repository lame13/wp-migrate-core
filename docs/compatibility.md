# What 1.0 promises

This is 1.0.0. `apiStability` reports `stable`: the exported names, the migration
config format, the artifact contracts and the destination registry below are
the published guarantee. The assist layer has its own config and artifact
versions, documented in [ai.md](ai.md), and does not move the migration config.

## In the contract

| Surface | What is promised | How it is enforced |
| --- | --- | --- |
| **Exported names** | Every name `src/index.ts` exports — values and types alike. A minor release may add one. A name is deprecated in one release and removed only in a major release. | `test/api-surface.json` is the frozen list, and `test/api-surface.test.ts` fails when the built declarations disagree with it. |
| **Documentation** | Every exported name is documented in [api.md](api.md). | The same test fails when a name has no entry. |
| **The migration config** | Every setting, its type and its meaning. The parser refuses an unknown setting rather than ignoring it, and `migrationConfigSchemaVersion` names the format. | `test/contracts.test.ts` checks the generated JSON Schema against the parser's own key lists. |
| **Artifact files** | Each generated file carries its own `schemaVersion`, listed in [artifacts.md](artifacts.md). The shape only changes when that number changes. | The same test generates a handoff for every static destination and checks what was written. |
| **Destinations** | `targetDefinitions`, `targetAdapters` and `targetRecords` describe every destination — its kind, its label, whether this release can write it, and where its preview server answers. | `src/targets.ts` is the only registry the CLI, the manifest, the report and the checks read. |
| **The no-network rule** | Migration commands read local files. They do not fetch a URL, do not touch a database, and do not modify WordPress. `assist` is an explicit exception: it talks only to the endpoint in `wp-migrate-core.ai.json`, only when invoked, and writes suggestions for review. The generated importer is the only thing that talks to a database, and it is yours to run. | The CLI refuses a URL where it wants a file, the tests exercise migration commands with local files only, and assist tests use a localhost mock endpoint. |

## Outside the contract

Being explicit about this matters as much as the list above:

- **The inside of a generated project.** Collection module shapes, component
  names, the importer's internals and the exact layout of a bundle are written
  for a documented destination, but they are not stable API. A handoff is meant
  to be read, reviewed and edited — after you edit it, it is yours.
- **The rendered HTML of a page.** What arrives depends on the export and on the
  repair decisions the run recorded. `page.html` is evidence of what was
  carried over, not a stable template.
- **Finding codes as a closed set.** `MIGRATION_ISSUE_CODES` grows as the parser
  learns new things to report. New codes arrive in minor releases; a code that
  is removed follows the same deprecation rule as a name.
- **`--json` field-by-field stability beyond the documented fields.** The
  documents are for machines, and they may gain fields. A field that is removed
  or changes meaning follows the same deprecation rule.
- **Prompt text, model choice and suggestion quality.** The assist config and
  suggestion artifacts carry their own `0.1` schema versions, but prompts and
  rankings may improve in a minor release. Accepted decisions are the stable
  input to the migration commands; a decision file that parses keeps applying.

## The deprecation rule

1. A name, flag or artifact field that is going away keeps working, and starts
   saying so, in a minor release.
2. It is removed in a major release, never sooner.
3. An artifact `schemaVersion` moves instead of a name disappearing, because a
   number is how a file says what it is.

## How a change to this contract is made

`test/api-surface.json`, `src/contracts.ts` and this directory are the record.
A change that adds a name updates the baseline and `docs/api.md` in the same
commit, so the diff says exactly what changed and a reviewer can refuse it.
