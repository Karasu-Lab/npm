#!/usr/bin/env node
/**
 * Scans packages/ for npm packages and publishes the unpublished ones
 * to GitHub Packages.
 *
 * A package is publishable when its package.json is not marked private.
 * The published version is the package's own version suffixed with the
 * short hash of the commit it was scanned at, e.g. 0.1.0-0123abc, so a
 * version always identifies exactly one source state. Packages are
 * published in dependency order, workspace dependencies are rewritten
 * to the exact published versions, and a version that already exists
 * on the registry is skipped.
 *
 * Environment: NODE_AUTH_TOKEN (required) — a token with packages:write
 * for publishing and packages:read for the existence check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "https://npm.pkg.github.com";
const token = process.env.NODE_AUTH_TOKEN;
if (!token) {
  console.error("NODE_AUTH_TOKEN is required");
  process.exit(1);
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const packages = [];
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join("packages", entry.name);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) {
    console.log(`skip ${entry.name}: marked private`);
    continue;
  }
  const sha = git(dir, ["rev-parse", "HEAD"]);
  packages.push({
    dir,
    manifest,
    name: manifest.name,
    publishVersion: `${manifest.version}-${sha.slice(0, 7)}`,
  });
}

const byName = new Map(packages.map((p) => [p.name, p]));
function workspaceDeps(pkg) {
  const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies };
  return Object.keys(deps).filter((name) => byName.has(name));
}
const ordered = [];
const visiting = new Set();
function visit(pkg) {
  if (ordered.includes(pkg) || visiting.has(pkg.name)) return;
  visiting.add(pkg.name);
  for (const depName of workspaceDeps(pkg)) visit(byName.get(depName));
  visiting.delete(pkg.name);
  ordered.push(pkg);
}
for (const pkg of packages) visit(pkg);

async function alreadyPublished(pkg) {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(pkg.name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`registry check for ${pkg.name} failed (HTTP ${res.status})`);
  const body = await res.json();
  return Boolean(body.versions?.[pkg.publishVersion]);
}

let failures = 0;
for (const pkg of ordered) {
  if (await alreadyPublished(pkg)) {
    console.log(`skip ${pkg.name}@${pkg.publishVersion}: already published`);
    continue;
  }
  const manifest = { ...pkg.manifest };
  delete manifest.private;
  manifest.version = pkg.publishVersion;
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [depName, spec] of Object.entries(manifest[field] ?? {})) {
      if (byName.has(depName) && String(spec).startsWith("workspace:")) {
        manifest[field][depName] = byName.get(depName).publishVersion;
      }
    }
  }
  writeFileSync(join(pkg.dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`publishing ${pkg.name}@${pkg.publishVersion}`);
  try {
    execFileSync(
      "npm",
      ["publish", "--registry", REGISTRY, "--access", "public"],
      { cwd: pkg.dir, stdio: "inherit", env: { ...process.env, NODE_AUTH_TOKEN: token } },
    );
  } catch {
    failures += 1;
    console.error(`failed to publish ${pkg.name}@${pkg.publishVersion}`);
  }
}
if (failures > 0) process.exit(1);
console.log("done");
