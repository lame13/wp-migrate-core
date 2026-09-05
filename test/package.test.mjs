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
  const [packed] = JSON.parse(runNpm(["pack", "--json", "--pack-destination", workspace], repository));
  assert.equal(packed.name, metadata.name);
  assert.equal(packed.version, metadata.version);

  const consumer = join(workspace, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  runNpm([
    "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
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
    import { parseWxr, generateAstroProject, renderReport } from "wp-migrate-core";
    assert.equal(typeof parseWxr, "function");
    assert.equal(typeof generateAstroProject, "function");
    assert.equal(typeof renderReport, "function");
  `], { cwd: consumer, env, encoding: "utf8", timeout: 30_000 });

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
  context.diagnostic(`Verified wp-migrate-core@${metadata.version}: installed executable, ESM exports, types, bundled demo, and handoff version.`);
});
