# AI assist

`wp-migrate-core assist` is an optional layer for turning the repair queue into
reviewable decisions. It is intentionally separate from the migration engine:
the model proposes, a person accepts, and the deterministic pipeline applies.

The migration commands (`inspect`, `convert`, `report`, `verify`) still read and
write local files only. `assist` is the one command that talks to the network,
and only when you invoke it. The endpoint is an OpenAI-compatible server you
choose; the key belongs to the person running the command.

## The loop

```bash
wp-migrate-core inspect export.xml --out migration-plan
wp-migrate-core assist migration-plan --job triage --ai-config wp-migrate-core.ai.json
# Read migration-plan/ai/triage/review.html and .../brief.md.
wp-migrate-core assist migration-plan --job alt-text --ai-config wp-migrate-core.ai.json
wp-migrate-core assist apply migration-plan/ai/alt-text/suggestions.json
wp-migrate-core convert export.xml --out new-site \
  --uploads ../wordpress/wp-content/uploads \
  --decisions wp-migrate-core.decisions.json
wp-migrate-core verify export.xml --html-dir new-site/dist \
  --decisions wp-migrate-core.decisions.json --fail-on blocker
```

`assist apply` writes only accepted decisions. `convert --decisions` and
`verify --decisions` read that file; `inspect --decisions` and
`report --decisions` use it for a preview. Route decisions are merged before
parsing, with the migration config winning on a key it already decides. A route
for a live URL the export does not contain becomes an explicit redirect rule in
`migration/redirects.json` and the host rule files. Alt text, shortcode
fallbacks and content patches are applied to the parsed project before
generation.

## Configure a provider

Create `wp-migrate-core.ai.json` next to the plan or pass `--ai-config`:

```json
{
  "schemaVersion": "0.1",
  "provider": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "your-chat-model",
    "apiKeyEnv": "OPENAI_API_KEY",
    "embeddingsModel": "your-embedding-model"
  },
  "limits": {
    "maxRequests": 200,
    "maxInputTokens": 300000,
    "maxOutputTokens": 100000
  },
  "privacy": {
    "send": "metadata",
    "redact": ["email", "phone", "url-query"]
  },
  "cache": {
    "enabled": true,
    "directory": ".wp-migrate-core/ai-cache"
  }
}
```

Then:

```bash
export OPENAI_API_KEY="..."
wp-migrate-core assist migration-plan --job triage
```

`apiKeyEnv` names an environment variable. If it is omitted, the provider reads
`WPMC_AI_API_KEY`, then `OPENAI_API_KEY`. The key is never written to the
config, a suggestion, a run record, a decision or a generated site. A literal
`Authorization` header in the config is refused; use `apiKeyEnv`, or reference
an environment variable in a custom header as `${MY_HEADER_VALUE}`.

The same file can point at OpenRouter, Groq, Together, vLLM, Ollama, LM Studio
or another compatible gateway by changing `baseUrl`, `model` and, if needed,
`headers`. Plain `http` is accepted only for localhost endpoints, so a remote
key is not sent in clear text. `schema --ai` prints the full JSON Schema:

```bash
wp-migrate-core schema --ai --out wp-migrate-core.ai.schema.json
```

## Jobs

| Job | Reads | Produces | What it does |
| --- | --- | --- | --- |
| `triage` | `issues.json`, `migration-plan.json` or `migration/issues.json` | `brief.md`, `suggestions.json`, `run.json`, `review.html` | Groups the queue and proposes a ranked work order. It does not read post bodies. |
| `alt-text` | `media.json` and plan record titles/routes | alt-text suggestions | Deduplicates by asset id and only proposes for images with no existing alt text. Text context first. |
| `shortcodes` | the finding queue | type-level mapping suggestions | Proposes a static fallback, a component name, removal or a deliberate block for shortcodes, Elementor widgets and dynamic Gutenberg blocks. |
| `routes` | `coverage.json`, `redirects.json`, `menus.json` and the plan's existing routes | constrained route suggestions | Embeds the old URL and existing routes, then chooses only a route the plan already has, above `minScore`. |
| `repair` | the queue and an export passed with `--export` | content patch suggestions | Fixes malformed Gutenberg/Elementor markup, then sends the patch through the parser. A patch that introduces any new finding code is rejected. |

Set per-job overrides under `jobs`:

```json
{
  "jobs": {
    "triage": { "model": "a-fast-model" },
    "alt-text": { "model": "a-cheaper-model", "maxItems": 200 },
    "routes": { "embeddingsModel": "an-embedding-model", "minScore": 0.6, "maxItems": 100 },
    "repair": { "model": "a-stronger-model", "maxItems": 25 }
  }
}
```

Route matching needs an embeddings model. The other jobs need only the chat
model. A route below `minScore` is omitted rather than guessed, and the
alternatives are recorded for review.

## Artifacts

`assist` writes four files to `--out` (default: `<plan>/ai/<job>`), so a triage
brief and an alt-text review do not overwrite each other:

| File | Version | Meaning |
| --- | --- | --- |
| `run.json` | `0.1` | Endpoint host, model, prompt version, timestamps, token usage, cache counts and rejected items. |
| `suggestions.json` | `0.1` | The typed suggestions the review page renders. |
| `review.html` | — | A local review page with the proposed decisions and confidence. |
| `brief.md` | — | The triage work order and client-facing narrative, when `--job triage` ran. |

`assist apply` writes `wp-migrate-core.decisions.json` at schema `0.1`. Its
sections are `altText`, `routes`, `shortcodes` and `contentPatches`. The file
is hand-editable and is the only AI output the migration commands consume.
`--force` replaces an existing AI output or decisions file; without it, the
command refuses to overwrite one.

`run.json` never includes the key. It records the endpoint host and path, not
credentials, query strings or fragments.

## Privacy and safety

- Triage works from finding metadata, counts and titles. Post bodies are not
  read.
- Alt text sends the asset title, file name, dimensions and the titles/routes
  of the pages that reference it. It does not send page bodies.
- Shortcode mapping sends finding titles, routes and required actions, not the
  full page.
- Route matching sends route paths and titles to the embeddings endpoint.
- Repair is the only job that sends a page body, and only the candidate body
  (up to the prompt limit) with `--export`. Use `--dry-run` to see the job's
  input counts, destination, model and privacy mode before a request.
- Email addresses, phone numbers and URL query strings are redacted by default.
  Keep `privacy.send` at `metadata` unless a job genuinely needs more.
- The cache stores model responses locally under `cache.directory`; set
  `cache.enabled: false` if those responses must not be retained.
- A model response is never trusted as HTML. Suggestions are parsed with the
  job's own validator. Repair patches must pass the WordPress parser and the
  handoff's unsafe-markup checks. The model cannot change severity, waive a
  finding or pass the launch gate.

## Commands

```text
wp-migrate-core assist <plan-dir> --job triage|alt-text|shortcodes|routes [--out <ai-dir>] [--ai-config <file>] [--dry-run] [--force]
wp-migrate-core assist <plan-dir> --job repair --export <export.xml> [--out <ai-dir>] [--ai-config <file>]
wp-migrate-core assist apply <suggestions.json> [--out <decisions.json>] [--accept alt-text,routes,shortcodes,repair] [--force]
```

`assist apply` accepts alt text, routes and shortcode mappings by default.
Content repair is intentionally excluded; pass `--accept repair` after reading
the patch. `--json` prints a machine-readable result for `assist` and
`assist apply`.

## What it does not claim

The AI does not execute WordPress plugins, prove that a redirect is live, or
guarantee that a form backend exists. Component mappings are developer work:
`convert --decisions` applies static fallbacks and removals, while a component
name remains a deliberate integration task. Route matching is a ranked
proposal, not a redirect decision made by the model. Visual, behavioural and
host-level checks still belong to `verify` and to a person.
