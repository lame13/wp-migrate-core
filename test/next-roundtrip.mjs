#!/usr/bin/env node
/**
 * The Next.js round trip, run on demand with `npm run test:next`.
 *
 * The package's own test suite checks the generated project as text. This
 * script is the other half: it installs the Next and React releases the
 * handoff is written against, type-checks the generated app, runs a real
 * `next build`, and then points the launch gate at the static export the build
 * produced.
 *
 * It asserts the things a text check cannot: that every planned route
 * prerenders to an HTML file, that delivered media is served from `out/`, that
 * a custom post type travels with its own content, that a publish-ready
 * handoff comes out with no launch blocker, and that a redirect the plan
 * published for the host is *not* silently faked by the app.
 *
 * It installs packages, so it is not part of `npm test`. Set
 * `NEXT_ROUNDTRIP_DIR` to choose a workspace and keep the built site for
 * inspection. Its `bundle` subdirectory is replaced on each run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repository, "dist/src/cli.js");

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

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check with `npm run test:next`.");
  return run(process.execPath, [npmCli, ...args], { cwd });
}

/**
 * A menu and a custom post type. The demo export carries neither, and both are
 * the parts of a handoff most likely to break in a destination that is not the
 * one the shared renderers were first written for.
 */
const extraItems = `
<item>
  <title>Home</title><wp:post_id>500</wp:post_id><wp:post_type>nav_menu_item</wp:post_type><wp:status>publish</wp:status>
  <category domain="nav_menu" nicename="primary">Primary</category>
  <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>custom</wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key>_menu_item_url</wp:meta_key><wp:meta_value>https://brightpath.example/</wp:meta_value></wp:postmeta>
</item>
<item>
  <title>Tap repair</title>
  <link>https://brightpath.example/work/tap-repair/</link>
  <dc:creator><![CDATA[niko]]></dc:creator>
  <category domain="service" nicename="repairs"><![CDATA[Repairs]]></category>
  <content:encoded><![CDATA[
<h2>What we do</h2>
<p>A custom post type record that has to arrive with its own route.</p>
  ]]></content:encoded>
  <wp:post_id>620</wp:post_id>
  <wp:post_name>tap-repair</wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>portfolio</wp:post_type>
</item>
`;

const expectedPhrase = "A custom post type record that has to arrive with its own route.";

const workspace = process.env.NEXT_ROUNDTRIP_DIR ?? (await mkdtemp(join(tmpdir(), "wp-migrate-next-roundtrip-")));
const keep = process.env.NEXT_ROUNDTRIP_DIR !== undefined || process.env.NEXT_ROUNDTRIP_KEEP === "1";
const bundle = join(workspace, "bundle");
const exportPath = join(workspace, "export.xml");

try {
  await mkdir(workspace, { recursive: true });
  const base = await readFile(join(repository, "fixtures/demo-wordpress.xml"), "utf8");
  await writeFile(exportPath, base.replace("</channel>", `${extraItems}</channel>`));

  console.log(`Next.js round trip in ${workspace}`);
  console.log("Generating the handoff ...");
  await rm(bundle, { recursive: true, force: true });
  run(
    process.execPath,
    [cliPath, "convert", exportPath, "--target", "next", "--out", bundle, "--uploads", join(repository, "fixtures/uploads"), "--publish-ready"],
    { capture: false }
  );

  console.log("Installing the handoff's dependencies ...");
  npm(["install", "--no-audit", "--no-fund", "--package-lock=false"], bundle);

  console.log("Type-checking the generated app ...");
  npm(["run", "typecheck"], bundle);

  console.log("Building the static export with Next.js ...");
  npm(["run", "build"], bundle);
  await stat(join(bundle, "out/index.html"));

  console.log("Checking every planned route reached the export ...");
  const routes = JSON.parse(await readFile(join(bundle, "content/routes.json"), "utf8"));
  assert.ok(routes.routes.length >= 7, `the plan carries the demo routes and the custom type (got ${routes.routes.length})`);
  for (const entry of routes.routes) {
    const file = entry.route === "/" ? "out/index.html" : join("out", entry.route.slice(1), "index.html");
    await stat(join(bundle, file));
  }

  console.log("Checking the custom post type and the menu ...");
  const portfolio = await readFile(join(bundle, "out/work/tap-repair/index.html"), "utf8");
  assert.ok(portfolio.includes(expectedPhrase), "the custom post type content is in the built page");
  const nav = await readFile(join(bundle, "out/index.html"), "utf8");
  assert.match(nav, /Primary navigation/);

  console.log("Checking the media the plan delivered is served by the build ...");
  await stat(join(bundle, "out/wp-content/uploads/2026/05/repair.jpg"));
  assert.match(
    await readFile(join(bundle, "out/services/index.html"), "utf8"),
    /\/wp-content\/uploads\/2026\/05\/repair\.jpg/,
    "a delivered image is referenced from the built page"
  );

  console.log("Checking a publish-ready build is crawler-facing ...");
  const robots = await readFile(join(bundle, "out/robots.txt"), "utf8");
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/brightpath\.example\/sitemap\.xml/);
  const sitemap = await readFile(join(bundle, "out/sitemap.xml"), "utf8");
  for (const entry of routes.routes) {
    assert.ok(sitemap.includes(`https://brightpath.example${entry.route}`), `${entry.route} is in the sitemap`);
  }

  console.log("Running the launch gate against the export ...");
  const verification = JSON.parse(
    run(
      process.execPath,
      [cliPath, "verify", exportPath, "--html-dir", join(bundle, "out"), "--json", "--fail-on", "none", "--out", join(workspace, "next-verification.json")],
      { cwd: workspace }
    )
  );
  assert.equal(verification.observed.kind, "html-directory");
  assert.equal(
    verification.summary.launchBlockers,
    0,
    JSON.stringify(verification.launch.findings.filter((finding) => finding.severity === "blocker"), null, 2)
  );
  assert.ok(verification.summary.verified > 0, "the gate compared planned routes with built pages");
  const codes = verification.launch.findings.map((finding) => finding.code);
  assert.ok(!codes.includes("CANONICAL_MISSING"), "a publish-ready build carries canonical URLs");
  assert.ok(
    verification.checks.some((check) => check.id === "content" && check.checked),
    "the content check ran rather than being skipped"
  );

  console.log("Checking the redirect the plan published for the host is not faked by the app ...");
  await assert.rejects(
    () => stat(join(bundle, "out/guides/stop-a-leaking-tap.html")),
    { code: "ENOENT" },
    "a static export serves no redirect of its own"
  );
  const redirects = await readFile(join(bundle, "migration/redirect-rules/netlify/_redirects"), "utf8");
  assert.match(redirects, /Handled by Pretty URLs: \/guides\/stop-a-leaking-tap -> \/guides\/stop-a-leaking-tap\//);

  console.log("PASS: real Next build, every planned route prerendered, custom types and the menu, served media, a clean launch gate, and host-level redirects.");
} finally {
  if (keep) {
    console.log(`Kept ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
}
