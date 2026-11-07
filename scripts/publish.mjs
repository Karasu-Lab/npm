#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://npm.pkg.github.com";
const DEFAULT_VERSION_NAMING_PATTERN = "{version}-{shortCommitHash}";
const token = process.env.NODE_AUTH_TOKEN;
if (!token) {
  console.error("NODE_AUTH_TOKEN is required");
  process.exit(1);
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function repositoryUrl(dir) {
  const url = git(dir, ["remote", "get-url", "origin"]);
  return url.startsWith("http") ? "git+" + url : url;
}

function publishVersionFor(manifest, sha) {
  const declared =
    manifest.versionNaming && typeof manifest.versionNaming.pattern === "string"
      ? manifest.versionNaming.pattern
      : "";
  const pattern = declared || DEFAULT_VERSION_NAMING_PATTERN;
  return pattern
    .split("{version}")
    .join(manifest.version)
    .split("{shortCommitHash}")
    .join(sha.slice(0, 7))
    .split("{commitHash}")
    .join(sha);
}

const packages = [];
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join("packages", entry.name);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) {
    console.log("skip " + entry.name + ": marked private");
    continue;
  }
  const sha = git(dir, ["rev-parse", "HEAD"]);
  packages.push({
    dir,
    manifest,
    name: manifest.name,
    publishVersion: publishVersionFor(manifest, sha),
  });
}

const npmrcPath = join(mkdtempSync(join(tmpdir(), "npmrc-")), ".npmrc");
const scopes = [
  ...new Set(
    packages
      .map((pkg) => (pkg.name.startsWith("@") ? pkg.name.split("/")[0] : null))
      .filter((scope) => scope !== null)
  ),
];
writeFileSync(
  npmrcPath,
  scopes.map((scope) => scope + ":registry=" + REGISTRY).join("\n") +
    (scopes.length > 0 ? "\n" : "") +
    "//" +
    new URL(REGISTRY).host +
    "/:_authToken=" +
    token +
    "\n"
);

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
  const res = await fetch(REGISTRY + "/" + encodeURIComponent(pkg.name), {
    headers: { Authorization: "Bearer " + token },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error("registry check for " + pkg.name + " failed (HTTP " + res.status + ")");
  const body = await res.json();
  return Boolean(body.versions && body.versions[pkg.publishVersion]);
}

let failures = 0;
for (const pkg of ordered) {
  if (await alreadyPublished(pkg)) {
    console.log("skip " + pkg.name + "@" + pkg.publishVersion + ": already published");
    continue;
  }
  const manifest = { ...pkg.manifest };
  delete manifest.private;
  manifest.version = pkg.publishVersion;
  manifest.repository ??= { type: "git", url: repositoryUrl(pkg.dir) };
  manifest.publishConfig = { ...manifest.publishConfig, access: "public" };
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [depName, spec] of Object.entries(manifest[field] ?? {})) {
      if (byName.has(depName) && String(spec).startsWith("workspace:")) {
        manifest[field][depName] = byName.get(depName).publishVersion;
      }
    }
  }
  writeFileSync(join(pkg.dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("publishing " + pkg.name + "@" + pkg.publishVersion);
  try {
    execFileSync(
      "npm",
      ["publish", "--registry", REGISTRY, "--access", "public", "--tag", "latest", "--userconfig", npmrcPath],
      { cwd: pkg.dir, stdio: "inherit", env: { ...process.env, NODE_AUTH_TOKEN: token } }
    );
  } catch {
    failures += 1;
    console.error("failed to publish " + pkg.name + "@" + pkg.publishVersion);
  }
}
if (failures > 0) process.exit(1);
console.log("done");
