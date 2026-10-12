# The fixture corpus

`fixtures/demo-wordpress.xml` is the tour. It is small, it is fictional, and it
exists so `wp-migrate-core demo` can show what the tool does.

`fixtures/corpus/` is the other half. A parser is only as good as the exports it
has been pointed at, so the corpus carries the shapes a real export brings —
including the ones that go wrong — and `test/corpus.test.ts` runs every fixture
through the whole pipeline: parse, plan, generate all four destinations, and
verify against a build that does not exist yet.

| Fixture | What it is for |
| --- | --- |
| `ordinary-wreckage.xml` | The ordinary failure modes: a duplicate WordPress id, an invalid id, an item with no title, a query permalink, an unsafe `javascript:` link, a blocked shortcode, an image with no alt text, a PDF that is not an image, a trashed item, an empty body, and a menu whose target the export does not carry. |
| `ordinary-wreckage-sitemap.xml` | The live URLs, including the legacy `?p=77` spelling of a post permalink and a page the export no longer carries. |
| `publishing-site.xml` | A site in good shape: two pages, three posts, two authors, nested categories and tags, a nested menu, a custom post type with its own taxonomy, attachments with and without alt text, a scheduled post, a private post, and a GMT publication date. |
| `publishing-site-sitemap.xml` | The live URLs, including one page and one upload the export cannot account for, so the coverage check has something real to report. |

## Rules for a fixture

1. **Fictional hosts only.** Every URL is on `.example` or `example.org`. The
   corpus test fails on a real host, so a fixture cannot quietly become a copy
   of someone's site.
2. **No downloads.** A fixture is a file in this repository. Nothing in this
   project fetches anything at migration time.
3. **The fixture says what it carries.** `test/corpus.test.ts` names the finding
   codes each fixture exists to produce, so a parser change that stops producing
   one fails the test instead of quietly testing less.
4. **Add a fixture with the failure, not after it.** A bug report that arrives
   with a reduced export becomes a fixture here, and the fix becomes a test that
   runs the whole pipeline over it.

The demo fixture is fictional too: the Bright Path Plumbing site, its customers
and its content were written for this repository and describe no real business.
