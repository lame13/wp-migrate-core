import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactContracts, artifactSchemaVersions } from "../src/contracts.js";
import { parseWxr } from "../src/core.js";
import { generateAstroProject } from "../src/generate.js";
import { parseLiveUrlSource } from "../src/live-urls.js";
import { applyMediaDelivery, planMediaDelivery } from "../src/media.js";
import { generateNextProject } from "../src/next.js";
import { generatePayloadBundle } from "../src/payload.js";
import { generatePruviousBundle } from "../src/pruvious.js";
import { targetRecords } from "../src/targets.js";
import { MIGRATION_ISSUE_CODES } from "../src/types.js";
import { verifySite } from "../src/verify.js";
import { demoFixturePath } from "./fixture-path.js";

/**
 * The corpus matrix.
 *
 * `fixtures/demo-wordpress.xml` is the tour: it shows what the tool does. The
 * corpus is the other half — exports that are in good shape and exports that go
 * wrong in the ordinary ways — and every fixture runs through the whole
 * pipeline: parse, plan, generate all four destinations, and verify against a
 * build that does not exist yet.
 *
 * The per-fixture expectations below are deliberately specific. They are what
 * keeps a fixture honest: if a parser change stops producing the finding the
 * fixture was written to carry, this fails rather than quietly testing less.
 */

const fixturesRoot = join(demoFixturePath, "..");
const corpusRoot = join(fixturesRoot, "corpus");
const repository = process.cwd();

interface Fixture {
  readonly name: string;
  readonly xmlPath: string;
  readonly sitemapPath?: string;
  /** Finding codes this fixture exists to carry. */
  readonly codes: readonly string[];
}

async function fixtures(): Promise<readonly Fixture[]> {
  const directory = await readdir(corpusRoot);
  const corpus = directory
    .filter((file) => file.endsWith(".xml") && !file.endsWith("-sitemap.xml"))
    .sort()
    .map((file) => {
      const name = file.replace(/\.xml$/, "");
      return {
        name,
        xmlPath: join(corpusRoot, file),
        sitemapPath: join(corpusRoot, `${name}-sitemap.xml`)
      };
    });

  return [
    { name: "demo", xmlPath: demoFixturePath, sitemapPath: join(fixturesRoot, "demo-sitemap.xml"), codes: [] },
    ...await Promise.all(
      corpus.map(async (fixture) => {
        const sitemap = await stat(fixture.sitemapPath).then(
          () => fixture.sitemapPath,
          () => undefined
        );
        const expectations = expectationsFor(fixture.name);
        return {
          name: fixture.name,
          xmlPath: fixture.xmlPath,
          ...(sitemap === undefined ? {} : { sitemapPath: sitemap }),
          codes: expectations
        };
      })
    )
  ];
}

function expectationsFor(name: string): readonly string[] {
  if (name === "ordinary-wreckage") {
    return [
      "WXR_ITEM_DUPLICATE_ID",
      "WXR_ITEM_INVALID_ID",
      "SHORTCODE_UNSUPPORTED",
      "MEDIA_MISSING_ALT_TEXT",
      "MENU_TARGET_UNRESOLVED",
      "ARCHIVE_ROUTE_ASSUMED",
      "LINK_TARGET_OUTSIDE_EXPORT"
    ];
  }

  if (name === "publishing-site") {
    return ["GUTENBERG_DYNAMIC_BLOCK", "MENU_TARGET_UNRESOLVED", "ARCHIVE_ROUTE_ASSUMED"];
  }

  return [];
}

async function projectFor(fixture: Fixture) {
  const xml = await readFile(fixture.xmlPath, "utf8");
  const parsed =
    fixture.sitemapPath === undefined
      ? parseWxr(xml)
      : parseWxr(xml, {
          liveUrlSource: parseLiveUrlSource(await readFile(fixture.sitemapPath, "utf8"), {
            sourcePath: fixture.sitemapPath
          })
        });

  return applyMediaDelivery(
    parsed,
    await planMediaDelivery(parsed, { uploadsDirectory: join(fixturesRoot, "uploads") })
  );
}

test("every corpus fixture parses into a plan that holds together", async () => {
  for (const fixture of await fixtures()) {
    const project = await projectFor(fixture);
    const label = `fixture ${fixture.name}`;

    assert.ok(project.records.length > 0, `${label} carries content`);

    // Findings are a closed set of codes with an action each, and their ids are
    // unique, because an artifact is keyed by them.
    const ids = new Set<string>();
    for (const issue of project.issues) {
      assert.ok(
        (MIGRATION_ISSUE_CODES as readonly string[]).includes(issue.code),
        `${label} reports a known code: ${issue.code}`
      );
      assert.ok(issue.message.length > 0, `${label} ${issue.code} has a message`);
      assert.ok(issue.requiredAction.length > 0, `${label} ${issue.code} has a required action`);
      assert.ok(["warning", "blocker"].includes(issue.severity), `${label} ${issue.code} has a severity`);
      assert.ok(!ids.has(issue.id), `${label} has one issue per id (${issue.id})`);
      ids.add(issue.id);
    }

    assert.equal(
      project.summary.blockers,
      project.issues.filter((issue) => issue.severity === "blocker" && issue.ignored !== true).length,
      `${label} counts every blocker`
    );
    assert.equal(
      project.summary.warnings,
      project.issues.filter((issue) => issue.severity === "warning" && issue.ignored !== true).length,
      `${label} counts every warning`
    );

    for (const code of fixture.codes) {
      assert.ok(
        project.issues.some((issue) => issue.code === code),
        `${label} still carries ${code}`
      );
    }

    // Media references and menu items are the two shapes a destination reads
    // per item, so they have to be complete wherever they appear.
    for (const reference of project.media.references) {
      assert.ok(
        ["matched", "missing-alt-text", "not-in-export", "ambiguous", "unresolved"].includes(reference.status),
        `${label} media reference ${reference.id} has a known status (${reference.status})`
      );
    }
    for (const menu of project.menus.trees) {
      for (const item of menu.items) {
        assert.ok(item.label.length > 0, `${label} menu item ${item.id} has a label`);
      }
    }

    const routes = new Set<string>();
    for (const archive of project.archives.pages) {
      assert.ok(archive.route.startsWith("/") && archive.route.endsWith("/"), `${label} ${archive.route} is a route`);
      routes.add(archive.route);
    }

    if (fixture.sitemapPath !== undefined) {
      assert.equal(project.coverage.summary.checked, true, `${label} ran the coverage check`);
      assert.ok(project.coverage.summary.liveUrls > 0, `${label} compared live URLs`);
    }
  }
});

test("every corpus fixture generates every destination without leaking anything", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-corpus-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  for (const fixture of await fixtures()) {
    const project = await projectFor(fixture);
    const targets = [
      ["astro", generateAstroProject],
      ["next", generateNextProject],
      ["payload", generatePayloadBundle],
      ["pruvious", generatePruviousBundle]
    ] as const;

    for (const [target, generate] of targets) {
      const directory = join(output, fixture.name, target);
      await generate(project, directory);

      // The manifest every destination writes names the registry's targets.
      const manifest = JSON.parse(await readFile(join(directory, "migration/manifest.json"), "utf8"));
      assert.deepEqual(manifest.targets, targetRecords(), `${fixture.name}/${target} manifest targets`);
      assert.equal(manifest.generator.target, target);

      // Every artifact this destination writes carries the declared version.
      for (const artifact of artifactContracts) {
        if (!artifact.destinations.includes(target)) continue;
        const contents = await readFile(join(directory, artifact.file), "utf8");
        if (artifact.schemaVersion === null) continue;
        assert.equal(
          (JSON.parse(contents) as { schemaVersion?: string }).schemaVersion,
          artifact.schemaVersion,
          `${fixture.name}/${target} ${artifact.file}`
        );
      }

      // A redirect that redirects to itself is a loop, and an unsafe scheme or
      // a source credential must never reach a generated file.
      const redirects = JSON.parse(await readFile(join(directory, "migration/redirects.json"), "utf8"));
      for (const redirect of redirects.redirects) {
        assert.notEqual(redirect.sourcePath, redirect.targetRoute, `${fixture.name}/${target} redirect loop`);
      }
    }
  }
});

test("an export that goes wrong still generates, and says what it could not do", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-corpus-wreckage-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const fixture = (await fixtures()).find((entry) => entry.name === "ordinary-wreckage") as Fixture;
  const project = await projectFor(fixture);
  const directory = join(output, "next");
  await generateNextProject(project, directory);

  // The duplicate id and the invalid id are reported, not silently merged.
  assert.ok(project.issues.some((issue) => issue.code === "WXR_ITEM_DUPLICATE_ID"));
  assert.ok(project.issues.some((issue) => issue.code === "WXR_ITEM_INVALID_ID"));
  assert.equal(project.summary.media.missingAltText, 1);
  assert.ok(
    project.media.references.some((reference) => reference.kind === "linked-file"),
    "the downloaded file is tracked as a linked file rather than dropped"
  );
  assert.ok(
    project.menus.trees.some((menu) => menu.items.some((item) => item.reason !== undefined)),
    "the menu entry this export cannot resolve keeps its reason"
  );

  // Whatever the export contained, nothing unsafe is copied into the handoff.
  const routes = JSON.parse(await readFile(join(directory, "content/routes.json"), "utf8"));
  for (const entry of routes.routes) {
    const page = await readFile(join(directory, entry.file), "utf8");
    assert.doesNotMatch(page, /javascript:/i, `${entry.route} carries no unsafe scheme`);
  }
  const issues = await readFile(join(directory, "migration/issues.json"), "utf8");
  assert.match(issues, /SHORTCODE_UNSUPPORTED/);
});

test("two records claiming one route stop the run before anything is written", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-corpus-refusal-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const xml = await readFile(join(corpusRoot, "ordinary-wreckage.xml"), "utf8");
  // The same export with the legacy query permalink left as the record's own
  // link: it normalizes to "/", which the home page already claims.
  const project = parseWxr(xml.replace("https://wreckage.example/legacy-post/", "https://wreckage.example/?p=77"));
  assert.ok(project.summary.routes.duplicateRoutes > 0, "the plan reports the collision");

  const directory = join(output, "next");
  await assert.rejects(() => generateNextProject(project, directory), /Cannot generate duplicate route: \//);
  await assert.rejects(() => stat(join(directory, "content/routes.json")), { code: "ENOENT" });
});

test("verifying a build that does not exist yet says so, for every fixture", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "wp-migrate-core-corpus-verify-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const empty = join(output, "empty");
  await mkdir(empty);

  for (const fixture of await fixtures()) {
    const project = await projectFor(fixture);
    const verification = await verifySite(project, {
      htmlDirectory: empty,
      ...(project.site.url === undefined ? {} : { siteUrl: project.site.url })
    });

    assert.ok(verification.routes.length > 0, `${fixture.name} planned routes`);
    assert.equal(verification.summary.verified, 0, `${fixture.name} cannot verify an empty build`);
    assert.ok(
      verification.routes.some((route) => route.status === "route-missing"),
      `${fixture.name} reports the routes the empty build does not answer`
    );
  }
});

test("the corpus fixtures are in the package's own test data, not downloaded", async () => {
  // A fixture that fetched anything would break the no-network rule, and one
  // that mentions a real host would stop being fictional.
  const fictionalHost = /(^|\.)example(\.(com|net|org))?$/;
  const publishingHost = /^(www\.)?(w3\.org|purl\.org|wordpress\.org)$/;

  for (const fixture of await fixtures()) {
    const xml = await readFile(fixture.xmlPath, "utf8");
    const urls = [...xml.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((match) => match[0]);
    assert.ok(urls.length > 0, `${fixture.name} carries URLs`);
    for (const url of urls) {
      const host = new URL(url).hostname;
      assert.ok(
        fictionalHost.test(host) || publishingHost.test(host),
        `${fixture.name} uses a fictional host, not ${host}`
      );
    }
  }

  const licenses = await readFile(join(repository, "docs", "corpus.md"), "utf8").catch(() => undefined);
  assert.ok(licenses !== undefined, "docs/corpus.md documents where the fixtures come from");
});
