#!/usr/bin/env node
/**
 * The Pruvious round trip, run on demand with `npm run test:pruvious`.
 *
 * The package's own test suite checks the generated bundle as text and runs the
 * importer against a collection-API stub. This script is the other half: it
 * installs the Nuxt and Pruvious releases the bundle is written for, boots the
 * generated app, and runs the importer through the app's own HTTP route, which
 * is how the handoff's README tells you to run it.
 *
 * That route is the interesting part. Its re-run guarantees live in the
 * database, not in the drop: "unchanged" can only be reported by reading the
 * stored record back and matching it by `wordpressSourceId`. So the second run
 * is the assertion that the first one persisted.
 *
 * It installs packages and boots a server, so it is not part of `npm test`.
 * Set `ROUNDTRIP_DIR` to choose a workspace and keep the app. Its
 * `bundle` subdirectory is replaced on each run.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repository, "dist/src/cli.js");
const port = Number(process.env.ROUNDTRIP_PORT ?? 3111);
const origin = `http://localhost:${port}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 900_000,
    cwd: options.cwd ?? repository,
    env: { ...process.env, ...options.env },
    stdio: options.capture === false ? "inherit" : "pipe"
  });
  if (result.status !== (options.expectedStatus ?? 0)) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`
    );
  }
  return result.stdout ?? "";
}

function npm(args, cwd, env = {}) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check with `npm run test:pruvious`.");
  return run(process.execPath, [npmCli, ...args], { cwd, env });
}

async function waitForServer(url, logPath, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const log = await readFile(logPath, "utf8").catch(() => "");
  throw new Error(`The generated app did not answer on ${url} within ${timeoutMs} ms.\n--- server log ---\n${log}`);
}

const workspace = process.env.ROUNDTRIP_DIR ?? (await mkdtemp(join(tmpdir(), "wp-migrate-pruvious-roundtrip-")));
const keep = process.env.ROUNDTRIP_DIR !== undefined || process.env.ROUNDTRIP_KEEP === "1";
const bundle = join(workspace, "bundle");
const exportPath = join(workspace, "export.xml");
const logPath = join(workspace, "server.log");
let server;

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(exportPath, await readFile(join(repository, "fixtures/demo-wordpress.xml"), "utf8"));

  console.log(`Pruvious round trip in ${workspace}`);
  console.log("Generating the bundle ...");
  await rm(bundle, { recursive: true, force: true });
  run(
    process.execPath,
    [cliPath, "convert", exportPath, "--target", "pruvious", "--out", bundle, "--uploads", join(repository, "fixtures/uploads")],
    { capture: false }
  );

  console.log("Installing Nuxt and Pruvious ...");
  npm(["install", "--no-audit", "--no-fund", "--package-lock=false"], bundle);
  await writeFile(join(bundle, ".env"), "WP_MIGRATE_IMPORT_TOKEN=roundtrip-token\n");

  console.log(`Booting the generated app on ${origin} ...`);
  const log = openSync(logPath, "w");
  server = spawn(process.execPath, [process.env.npm_execpath, "run", "dev", "--", "--port", String(port)], {
    cwd: bundle,
    env: { ...process.env, PORT: String(port), WP_MIGRATE_URL: origin },
    stdio: ["ignore", log, log],
    detached: true
  });
  await waitForServer(origin, logPath);
  // The front end is yours to build, so the root may well be a 404. What has to
  // answer is the import route, and it has to refuse a caller with no token.
  const unauthenticated = await fetch(`${origin}/api/migrate`, { method: "POST" });
  assert.ok(
    [401, 403].includes(unauthenticated.status),
    `the import route refuses an unauthenticated call (got ${unauthenticated.status})`
  );

  const importReport = () => {
    npm(["run", "migrate"], bundle, { WP_MIGRATE_URL: origin });
    return readFile(join(bundle, "migration-import.json"), "utf8").then(JSON.parse);
  };

  console.log("Importing through the app's own route ...");
  const first = await importReport();
  assert.equal(first.generator.target, "pruvious");
  assert.equal(
    first.summary.failed,
    0,
    JSON.stringify(first.records.filter((record) => record.action === "failed"), null, 2)
  );
  assert.equal(first.summary.created, first.summary.planned, "the first import creates every planned record");

  console.log("Re-importing to prove the records persisted ...");
  const second = await importReport();
  assert.equal(second.summary.created, 0, "a repeated import creates nothing");
  assert.equal(
    second.summary.unchanged,
    second.summary.planned,
    `a repeated import leaves every record alone: ${JSON.stringify(second.summary)}`
  );

  console.log("Checking the import report against the plan ...");
  const verification = JSON.parse(
    run(
      process.execPath,
      [
        cliPath,
        "verify",
        exportPath,
        "--import-report",
        join(bundle, "migration-import.json"),
        "--json",
        "--out",
        join(workspace, "pruvious-verification.json")
      ],
      { cwd: workspace }
    )
  );
  assert.equal(verification.observed.kind, "import-report");
  assert.equal(
    verification.summary.launchBlockers,
    0,
    JSON.stringify(verification.launch.findings.filter((finding) => finding.severity === "blocker"), null, 2)
  );
  assert.ok(
    verification.checks.some((check) => check.id === "import" && check.checked),
    "the import evidence is checked rather than skipped"
  );

  console.log("PASS: real Nuxt + Pruvious boot, an import through the app, a repeat import that proves persistence, and the import gate.");
} finally {
  if (server?.pid !== undefined) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (keep) {
    console.log(`Kept ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
}
