import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
      ["--target", "-v"]
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
    { args: ["inspect", "missing.xml", "--target", "invalid"], error: "Unknown target: invalid" }
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
