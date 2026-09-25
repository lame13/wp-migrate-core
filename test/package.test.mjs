import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("the npm tarball installs and runs outside the checkout", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-package-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check with npm run test:package.");

  const env = {
    ...process.env,
    npm_config_cache: join(workspace, "npm-cache"),
    // The local pack/install check must also run during npm publish --dry-run.
    npm_config_dry_run: "false",
    npm_config_update_notifier: "false"
  };

  function runNpm(args, cwd) {
    return execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000
    });
  }

  const metadata = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8"));
  assert.equal(lockfile.version, metadata.version);
  assert.equal(lockfile.packages[""].version, metadata.version);
  const [packed] = JSON.parse(runNpm(["pack", "--json", "--pack-destination", workspace], repository));
  assert.equal(packed.name, metadata.name);
  assert.equal(packed.version, metadata.version);

  const consumer = join(workspace, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // The dependency is resolved from the registry: the tarball no longer stands
  // alone, so this install cannot be offline.
  runNpm([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    join(workspace, packed.filename)
  ], consumer);

  const installed = join(consumer, "node_modules", metadata.name);
  const installedMetadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedMetadata.version, metadata.version);
  assert.ok((await readFile(join(installed, installedMetadata.types), "utf8")).length > 0);
  assert.equal(
    runNpm(["exec", "--offline", "--", "wp-migrate-core", "--version"], consumer),
    `${metadata.version}\n`
  );

  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import {
      parseWxr,
      generateAstroProject,
      renderReport,
      parseLiveUrlSource,
      mergeLiveUrlSources,
      redirectRuleFiles,
      verifySite
    } from "wp-migrate-core";
    assert.equal(typeof parseWxr, "function");
    assert.equal(typeof generateAstroProject, "function");
    assert.equal(typeof renderReport, "function");
    assert.equal(typeof parseLiveUrlSource, "function");
    assert.equal(typeof mergeLiveUrlSources, "function");
    assert.equal(typeof redirectRuleFiles, "function");
    assert.equal(typeof verifySite, "function");
  `], { cwd: consumer, env, encoding: "utf8", timeout: 30_000 });

  const help = runNpm(["exec", "--offline", "--", "wp-migrate-core", "--help"], consumer);
  assert.match(help, /wp-migrate-core verify <export\.xml> --html-dir/);

  const verificationText = "This migrated page contains enough original words to verify that its content arrived in the built site successfully.";
  await writeFile(join(consumer, "verify.xml"), `<rss><channel><link>https://example.invalid/</link><item>
    <title>Verified</title><link>https://example.invalid/verified/</link>
    <wp:post_id>1</wp:post_id><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
    <wp:post_name>verified</wp:post_name><content:encoded><![CDATA[<p>${verificationText}</p>]]></content:encoded>
    </item></channel></rss>`);
  await mkdir(join(consumer, "built"));
  await writeFile(join(consumer, "built/verified.html"), `<p>${verificationText}</p>`);
  const verified = JSON.parse(runNpm([
    "exec", "--offline", "--", "wp-migrate-core", "verify", "verify.xml", "--html-dir", "built",
    "--json", "--fail-on", "warning"
  ], consumer));
  assert.equal(verified.failed, false);
  assert.equal(verified.summary.verified, 1);
  const verificationFile = JSON.parse(await readFile(join(consumer, "migration-verification.json"), "utf8"));
  assert.equal(verificationFile.schemaVersion, "0.5");
  assert.equal(verificationFile.generator.version, metadata.version);
  assert.deepEqual(verificationFile.summary, verified.summary);

  runNpm(["exec", "--offline", "--", "wp-migrate-core", "demo", "--out", "demo output"], consumer);
  const output = join(consumer, "demo output");
  const plan = JSON.parse(await readFile(join(output, "migration-plan/migration-plan.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(output, "astro-site/migration/manifest.json"), "utf8"));
  assert.ok(plan.records.length > 0);
  assert.equal(manifest.records.length, plan.records.length);
  assert.equal(manifest.generator.version, metadata.version);
  for (const reportPath of ["migration-plan/report.html", "astro-site/migration/report.html"]) {
    const report = await readFile(join(output, reportPath), "utf8");
    assert.ok(report.includes("Repair"));
    assert.ok(report.includes(`Version ${metadata.version}`));
  }
  const readme = await readFile(join(output, "astro-site/README.md"), "utf8");
  assert.ok(readme.includes(`wp-migrate-core ${metadata.version}`));
  const media = JSON.parse(await readFile(join(output, "astro-site/migration/media.json"), "utf8"));
  const redirects = JSON.parse(await readFile(join(output, "astro-site/migration/redirects.json"), "utf8"));
  const links = JSON.parse(await readFile(join(output, "astro-site/migration/links.json"), "utf8"));
  const coverage = JSON.parse(await readFile(join(output, "astro-site/migration/coverage.json"), "utf8"));
  // Inventory formats are versioned on their own, so they only move when
  // their shape changes.
  assert.equal(media.schemaVersion, "0.2");
  assert.equal(redirects.schemaVersion, "0.2");
  assert.equal(media.summary.assets, 5);
  assert.equal(redirects.summary.generated, manifest.redirects.summary.generated);
  assert.equal(links.schemaVersion, "0.3");
  assert.equal(coverage.schemaVersion, "0.4");
  assert.equal(manifest.schemaVersion, "0.4");
  assert.equal(links.rewrites.length, manifest.links.summary.needsRewrite);
  assert.equal(manifest.media.file, "migration/media.json");
  assert.equal(manifest.redirects.file, "migration/redirects.json");
  assert.equal(manifest.links.file, "migration/links.json");
  // The bundled demo ships a sitemap so the packaged install exercises the
  // coverage check and the rule files outside the checkout.
  assert.equal(manifest.coverage.file, "migration/coverage.json");
  assert.deepEqual(manifest.coverage.summary, coverage.summary);
  assert.equal(coverage.summary.checked, true);
  assert.equal(coverage.summary.liveUrls, 17);
  assert.equal(coverage.summary.uncovered, 2);
  const netlifyRules = await readFile(join(output, "astro-site/migration/redirect-rules/netlify/_redirects"), "utf8");
  assert.match(netlifyRules, /# Handled by Pretty URLs: \/guides\/stop-a-leaking-tap -> \/guides\/stop-a-leaking-tap\//);
  const vercelRules = JSON.parse(await readFile(join(output, "astro-site/migration/redirect-rules/vercel/vercel.json"), "utf8"));
  assert.equal(vercelRules.redirects.length, redirects.redirects.length);
  assert.equal(vercelRules.redirects[0].source, "/(guides/stop-a-leaking-tap$)");
  context.diagnostic(`Verified wp-migrate-core@${metadata.version}: installed executable, ESM exports, types, content verification, bundled demo, and handoff version.`);
});
