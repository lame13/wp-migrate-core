import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");

function runCli(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
}

function inspectWithCli(output: string) {
  return spawnSync(process.execPath, [cliPath, "inspect", demoFixturePath, "--out", output], {
    encoding: "utf8"
  });
}

test("inspect publishes a complete new output directory and preserves an existing one", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-"));
  const output = join(workspace, "migration-plan");
  const stagingPrefix = `.${basename(output)}.staging-`;
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const first = inspectWithCli(output);
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual((await readdir(output)).sort(), ["migration-plan.json", "report.html"]);

  const [planBefore, reportBefore] = await Promise.all([
    readFile(join(output, "migration-plan.json"), "utf8"),
    readFile(join(output, "report.html"), "utf8")
  ]);

  const second = inspectWithCli(output);
  assert.equal(second.error, undefined);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite existing output/);
  assert.deepEqual((await readdir(output)).sort(), ["migration-plan.json", "report.html"]);

  const [planAfter, reportAfter] = await Promise.all([
    readFile(join(output, "migration-plan.json"), "utf8"),
    readFile(join(output, "report.html"), "utf8")
  ]);
  assert.equal(planAfter, planBefore);
  assert.equal(reportAfter, reportBefore);
  assert.ok((await readdir(workspace)).every((entry) => !entry.startsWith(stagingPrefix)));
});

for (const command of ["inspect", "convert", "report", "demo"]) {
  test(`${command} rejects incomplete options without creating output`, async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-options-"));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const input = command === "demo" ? [] : [demoFixturePath];
    const cases = [
      ["--out"],
      ["--out", ""],
      ["--out", "   "],
      ["--out", "--target", "astro"],
      ["--out", "-h"],
      ["--target"],
      ["--target", ""],
      ["--target", "   "],
      ["--target", "--out", "unexpected-output"],
      ["--target", "-v"],
      ["--fail-on"],
      ["--fail-on", ""],
      ["--fail-on", "   "],
      ["--fail-on", "--out", "unexpected-output"],
      ["--fail-on", "-h"]
    ];

    for (const args of cases) {
      const result = runCli([command, ...input, ...args], workspace);
      const label = JSON.stringify([command, ...args]);
      assert.equal(result.error, undefined, label);
      assert.equal(result.status, 1, label);
      assert.ok(result.stderr.includes(`${args[0]} requires a value.`), result.stderr);
      assert.deepEqual(await readdir(workspace), [], label);
    }
  });
}

test("help and version work without reading an export or creating output", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-help-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const metadata = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  const helpCases = [[], ["help"], ["--help"], ["-h"]];
  const versionCases = [["--version"], ["-v"]];

  for (const command of ["inspect", "convert", "report", "demo"]) {
    helpCases.push([command, "--help"], [command, "-h"], [command, "missing.xml", "--help"]);
    versionCases.push([command, "--version"], [command, "-v"]);
  }

  for (const args of helpCases) {
    const result = runCli(args, workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.startsWith(`WP Migrate Core ${metadata.version}\n`));
    assert.match(result.stdout, /Usage:/);
  }

  for (const args of versionCases) {
    const result = runCli(args, workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${metadata.version}\n`);
  }

  assert.deepEqual(await readdir(workspace), []);
});

test("argument errors take precedence over reading an input file", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-errors-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const cases = [
    { args: ["inspetc", "missing.xml"], error: "Unknown command: inspetc" },
    { args: ["inspect", "missing.xml", "--unknown"], error: "Unknown argument: --unknown" },
    { args: ["inspect", "-x"], error: "Unknown argument: -x" },
    { args: ["inspect", "missing.xml", "--out"], error: "--out requires a value." },
    { args: ["inspect", "missing.xml", "--target"], error: "--target requires a value." },
    { args: ["inspect", "missing.xml", "--target", "invalid"], error: "Unknown target: invalid" },
    { args: ["inspect", "missing.xml", "--fail-on"], error: "--fail-on requires a value." },
    { args: ["inspect", "missing.xml", "--fail-on", "critical"], error: "Unknown --fail-on value: critical" }
  ];

  for (const { args, error } of cases) {
    const result = runCli(args, workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(error), result.stderr);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }

  assert.deepEqual(await readdir(workspace), []);
});

test("--include-drafts reads drafts, pending, and private items", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-drafts-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const fixture = await readFile(demoFixturePath, "utf8");
  const withDraft = fixture
    .replace(/(<wp:post_id>10<\/wp:post_id>[\s\S]*?<wp:status>)publish(<\/wp:status>)/, "$1draft$2")
    .replace(/(<wp:post_id>11<\/wp:post_id>[\s\S]*?<wp:status>)publish(<\/wp:status>)/, "$1pending$2")
    .replace(/(<wp:post_id>12<\/wp:post_id>[\s\S]*?<wp:status>)publish(<\/wp:status>)/, "$1private$2");
  const input = join(workspace, "draft-export.xml");
  await writeFile(input, withDraft, "utf8");

  const defaultOutput = join(workspace, "plan-default");
  const defaultRun = runCli(["inspect", input, "--out", defaultOutput], workspace);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const defaultPlan = JSON.parse(await readFile(join(defaultOutput, "migration-plan.json"), "utf8"));
  assert.equal(defaultPlan.records.length, 1);
  assert.ok(defaultPlan.records.every((record: { status: string }) => record.status === "publish"));

  const draftOutput = join(workspace, "plan-drafts");
  const draftRun = runCli(["inspect", input, "--include-drafts", "--json", "--out", draftOutput], workspace);
  assert.equal(draftRun.status, 0, draftRun.stderr);
  assert.deepEqual(JSON.parse(draftRun.stdout).scan, { includeDrafts: true });
  const draftPlan = JSON.parse(await readFile(join(draftOutput, "migration-plan.json"), "utf8"));
  const drafts = draftPlan.records.filter((record: { status: string }) => record.status === "draft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].slug, "home");
  assert.deepEqual(draftPlan.records.map((record: { status: string }) => record.status).sort(), [
    "draft", "pending", "private", "publish"
  ]);
  assert.equal(draftPlan.records.length, defaultPlan.records.length + 3);
});

test("--json prints one machine-readable document instead of the summary", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-json-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const metadata = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  const output = join(workspace, "migration-plan");
  const input = join(workspace, "private-export.xml");
  const fixture = (await readFile(demoFixturePath, "utf8"))
    .replaceAll("https://brightpath.example", "//private-user:private-password@brightpath.example")
    .replace(/(<link>[^<]+)(<\/link>)/g, "$1?private-query=secret#private-fragment$2")
    .replace('[gravityform id="4"', '[gravityform secret="private-evidence" id="4"');
  await writeFile(input, fixture, "utf8");

  const result = runCli(["inspect", input, "--out", output, "--json"], workspace);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const document = JSON.parse(result.stdout);
  const plan = JSON.parse(await readFile(join(output, "migration-plan.json"), "utf8"));

  assert.equal(document.command, "inspect");
  assert.equal(document.generator.name, "wp-migrate-core");
  assert.equal(document.generator.version, metadata.version);
  assert.deepEqual(document.scan, { includeDrafts: false });
  assert.deepEqual(document.source, { title: "Bright Path Plumbing" });
  assert.deepEqual(document.summary, plan.summary);
  assert.deepEqual(document.issues, plan.issues);
  assert.equal(document.summary.media.assets, 5);
  assert.equal(document.summary.media.notInExport, 1);
  assert.equal(document.summary.routes.generated, 0, "every link in this export carries a query string");
  assert.equal(document.summary.routes.withoutTarget, 4);
  assert.doesNotMatch(result.stdout, /private-user|private-password|private-query|private-fragment|private-evidence/);
  assert.doesNotMatch(JSON.stringify(plan), /private-user|private-password|private-query|private-fragment|private-evidence/);
  const report = await readFile(join(output, "report.html"), "utf8");
  assert.doesNotMatch(report, /private-user|private-password|private-query|private-fragment|private-evidence/);
  assert.match(report, /Some source URLs still need a decision/);
  assert.ok(document.issues.every((issue: object) => !("evidence" in issue)));
  assert.deepEqual(document.outputs, {
    plan: join(output, "migration-plan.json"),
    report: join(output, "report.html")
  });
  assert.equal(document.failed, false);
  assert.doesNotMatch(result.stdout, /Repair queue/);
  assert.doesNotMatch(result.stdout, /BLOCKED/);
  assert.deepEqual((await readdir(output)).sort(), ["migration-plan.json", "report.html"]);
});

test("--fail-on gates the exit status without changing what is written", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-failon-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const baseline = runCli(
    ["inspect", demoFixturePath, "--out", join(workspace, "none"), "--json", "--fail-on", "none"],
    workspace
  );
  assert.equal(baseline.status, 0, baseline.stderr);
  const { summary } = JSON.parse(baseline.stdout);
  assert.ok(summary.blockers > 0, "the demo fixture is expected to contain blockers");
  assert.ok(summary.warnings > 0, "the demo fixture is expected to contain warnings");

  const blockerOutput = join(workspace, "blocker");
  const blockerRun = runCli(
    ["inspect", demoFixturePath, "--out", blockerOutput, "--json", "--fail-on", "blocker"],
    workspace
  );
  assert.equal(blockerRun.status, 1);
  assert.equal(JSON.parse(blockerRun.stdout).failed, true);
  assert.match(blockerRun.stderr, /--fail-on blocker matched/);
  assert.deepEqual((await readdir(blockerOutput)).sort(), ["migration-plan.json", "report.html"]);
  assert.equal(
    await readFile(join(blockerOutput, "migration-plan.json"), "utf8"),
    await readFile(join(workspace, "none", "migration-plan.json"), "utf8")
  );

  const humanRun = runCli(
    ["inspect", demoFixturePath, "--out", join(workspace, "human"), "--fail-on", "blocker"],
    workspace
  );
  assert.equal(humanRun.status, 1);
  assert.match(humanRun.stdout, /Repair queue/);
  assert.match(humanRun.stderr, /--fail-on blocker matched/);

  const warningRun = runCli(
    ["inspect", demoFixturePath, "--out", join(workspace, "warning"), "--json", "--fail-on", "warning"],
    workspace
  );
  assert.equal(warningRun.status, 1);
  assert.equal(JSON.parse(warningRun.stdout).failed, true);
  assert.match(warningRun.stderr, /--fail-on warning matched/);
});

test("--fail-on distinguishes clean, warning-only, and blocker-only scans", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-thresholds-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const cases = [
    { name: "clean", content: "<!-- wp:paragraph /-->", warnings: 0, blockers: 0, exits: [0, 0, 0] },
    { name: "warning", content: "<!-- wp:image /-->", warnings: 1, blockers: 0, exits: [0, 1, 0] },
    { name: "blocker", content: "<!-- wp:query /-->", warnings: 0, blockers: 1, exits: [0, 1, 1] }
  ];

  for (const scan of cases) {
    const input = join(workspace, `${scan.name}.xml`);
    await writeFile(input, `<rss><channel><item>
      <wp:post_id>1</wp:post_id><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
      <content:encoded><![CDATA[${scan.content}]]></content:encoded>
    </item></channel></rss>`);
    for (const [index, threshold] of ["none", "warning", "blocker"].entries()) {
      const result = runCli([
        "inspect", input, "--out", join(workspace, `${scan.name}-${threshold}`),
        "--json", "--fail-on", threshold
      ], workspace);
      assert.equal(result.status, scan.exits[index], `${scan.name}: ${threshold}: ${result.stderr}`);
      const document = JSON.parse(result.stdout);
      assert.equal(document.summary.warnings, scan.warnings);
      assert.equal(document.summary.blockers, scan.blockers);
      assert.equal(document.failed, scan.exits[index] === 1);
      if (result.status === 0) assert.equal(result.stderr, "");
    }
  }
});

for (const command of ["convert", "report", "demo"]) {
  test(`${command} emits JSON and completes output before failing the gate`, async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), `wp-migrate-core-cli-${command}-`));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const output = join(workspace, command === "report" ? "report.html" : "output");
    const input = command === "demo" ? [] : [demoFixturePath];
    const result = runCli([
      command, ...input, "--out", output, "--json", "--fail-on", "blocker"
    ], workspace);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--fail-on blocker matched/);
    const document = JSON.parse(result.stdout);
    assert.equal(document.command, command);
    assert.equal(document.failed, true);
    assert.ok(document.summary.blockers > 0);
    assert.match(await readFile(document.outputs.report, "utf8"), /<html/);
    if (command === "report") {
      assert.deepEqual(document.outputs, { report: output });
      assert.deepEqual(await readdir(workspace), ["report.html"]);
    } else {
      const site = command === "demo" ? join(output, "astro-site") : output;
      assert.equal(document.outputs.site, site);
      const manifestPath = join(site, "migration", "manifest.json");
      const issuesPath = join(site, "migration", "issues.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const issues = JSON.parse(await readFile(issuesPath, "utf8"));
      assert.deepEqual(document.summary, manifest.summary);
      assert.deepEqual(document.issues, issues);
      assert.match(await readFile(join(site, "migration", "report.html"), "utf8"), /<html/);
      if (command === "demo") {
        const plan = JSON.parse(await readFile(document.outputs.plan, "utf8"));
        assert.deepEqual(document.summary, plan.summary);
      } else {
        assert.equal(document.outputs.manifest, manifestPath);
        assert.equal(document.outputs.issues, issuesPath);
      }
    }
  });
}

test("convert writes a media inventory and a URL map beside the generated site", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-migrate-core-cli-inventory-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const output = join(workspace, "site");

  const humanRun = runCli(["convert", demoFixturePath, "--out", output], workspace);
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, /media: 5 assets in the export, 4 referenced/);
  assert.match(humanRun.stdout, /urls: 4 routes generated, 1 redirect needed/);
  assert.match(humanRun.stdout, /Media inventory: .*migration\/media\.json/);
  assert.match(humanRun.stdout, /URL and redirect map: .*migration\/redirects\.json/);

  const jsonRun = runCli(["convert", demoFixturePath, "--out", join(workspace, "second-site"), "--json"], workspace);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const document = JSON.parse(jsonRun.stdout);

  assert.equal(document.outputs.media, join(workspace, "second-site", "migration", "media.json"));
  assert.equal(document.outputs.redirects, join(workspace, "second-site", "migration", "redirects.json"));

  const media = JSON.parse(await readFile(document.outputs.media, "utf8"));
  assert.deepEqual(media.summary, document.summary.media);
  assert.ok(media.assets.some((asset: { file?: string }) => asset.file === "2026/05/workshop-team.jpg"));

  const redirects = JSON.parse(await readFile(document.outputs.redirects, "utf8"));
  assert.deepEqual(redirects.summary, document.summary.routes);
  assert.deepEqual(
    redirects.redirects.map((redirect: { sourcePath: string; targetRoute: string }) => [
      redirect.sourcePath,
      redirect.targetRoute
    ]),
    [["/guides/stop-a-leaking-tap", "/guides/stop-a-leaking-tap/"]]
  );
});
