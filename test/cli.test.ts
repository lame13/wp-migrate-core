import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { demoFixturePath } from "./fixture-path.js";

const cliPath = resolve(process.cwd(), "dist/src/cli.js");

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
