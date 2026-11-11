#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

class SyncError extends Error {}

class SyncEvents {
  pointerUpdate = "pointer-update";
  linkPackage = "link-package";
  unlinkPackage = "unlink-package";
}

class SyncStatuses {
  pushed = "pushed";
  noop = "noop";
  failed = "failed";
}

class SyncFailureReasons {
  invalidPayload = "invalid_payload";
  unsupportedEvent = "unsupported_event";
  submoduleNotFound = "submodule_not_found";
  pushFailed = "push_failed";
  unexpectedError = "unexpected_error";
}

class Identifiers {
  shaPattern = /^[0-9a-f]{40}$/;
  idPattern = /^[A-Za-z0-9_-]{1,128}$/;
  repositoryFullNamePattern = /^[A-Za-z0-9._-]+[/][A-Za-z0-9._-]+$/;
  submodulePathPattern = /^packages[/][A-Za-z0-9._-]+$/;
  branchNamePattern = /^[A-Za-z0-9._/-]+$/;
  maxBranchNameLength = 200;
  dotSegments = [".", ".."];

  isSha(value) {
    return typeof value === "string" && this.shaPattern.test(value);
  }

  isId(value) {
    return typeof value === "string" && this.idPattern.test(value);
  }

  isRepositoryFullName(value) {
    return (
      typeof value === "string" &&
      this.repositoryFullNamePattern.test(value) &&
      value.split("/").every((part) => !this.dotSegments.includes(part))
    );
  }

  isSubmodulePath(value) {
    return (
      typeof value === "string" &&
      this.submodulePathPattern.test(value) &&
      !this.dotSegments.includes(value.split("/")[1])
    );
  }

  isBranchName(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= this.maxBranchNameLength &&
      this.branchNamePattern.test(value) &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock")
    );
  }
}

class SyncRunner {
  events = new SyncEvents();
  statuses = new SyncStatuses();
  reasons = new SyncFailureReasons();
  identifiers = new Identifiers();
  gitlinkMode = "160000";
  packagesDirectory = "packages/";
  gitmodulesFile = ".gitmodules";
  remoteName = "origin";
  committerName = "github-actions[bot]";
  committerEmail = "41898282+github-actions[bot]@users.noreply.github.com";
  repositoryUrlPrefix = "https://github.com/";
  repositoryUrlSuffix = ".git";
  missingSectionExitCode = 128;

  constructor(env) {
    this.env = env;
  }

  handlers() {
    return {
      [this.events.pointerUpdate]: (payload) => this.pointerUpdate(payload),
      [this.events.linkPackage]: (payload) => this.linkPackage(payload),
      [this.events.unlinkPackage]: (payload) => this.unlinkPackage(payload),
    };
  }

  git(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  }

  gitlinkOid(path) {
    const pattern = new RegExp("^" + this.gitlinkMode + " commit ([0-9a-f]{40})\t");
    const match = pattern.exec(this.git(["ls-tree", "HEAD", "--", path]));
    return match ? match[1] : null;
  }

  remoteBranchExists(branch) {
    try {
      execFileSync("git", ["ls-remote", "--exit-code", "--heads", this.remoteName, "refs/heads/" + branch], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  commitAndPush(branch, message) {
    this.git(["config", "user.name", this.committerName]);
    this.git(["config", "user.email", this.committerEmail]);
    this.git(["switch", "-c", branch]);
    this.git(["commit", "-m", message]);
    try {
      this.git(["push", this.remoteName, branch]);
    } catch {
      throw new SyncError(this.reasons.pushFailed);
    }
  }

  runSuffix() {
    return String(this.env.GITHUB_RUN_ID || "0").replace(/[^0-9]/g, "");
  }

  parsePayload() {
    let payload;
    try {
      payload = JSON.parse(this.env.PAYLOAD_JSON || "");
    } catch {
      throw new SyncError(this.reasons.invalidPayload);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SyncError(this.reasons.invalidPayload);
    }
    return payload;
  }

  pointerUpdate(payload) {
    const valid =
      this.identifiers.isId(payload.eventId) &&
      this.identifiers.isId(payload.packageId) &&
      this.identifiers.isSubmodulePath(payload.path) &&
      this.identifiers.isSha(payload.sha);
    if (!valid) throw new SyncError(this.reasons.invalidPayload);
    const result = { eventId: payload.eventId, packageId: payload.packageId, path: payload.path, sha: payload.sha };
    const current = this.gitlinkOid(payload.path);
    if (current === null) throw new SyncError(this.reasons.submoduleNotFound);
    if (current === payload.sha) return { ...result, status: this.statuses.noop };
    const name = payload.path.slice(this.packagesDirectory.length);
    const branch = "chore/bump-" + name + "-" + payload.sha.slice(0, 7);
    if (!this.remoteBranchExists(branch)) {
      this.git(["update-index", "--cacheinfo", this.gitlinkMode + "," + payload.sha + "," + payload.path]);
      this.commitAndPush(branch, "chore: bump " + name + " to " + payload.sha.slice(0, 7));
    }
    return { ...result, status: this.statuses.pushed, branch };
  }

  linkPackage(payload) {
    const valid =
      this.identifiers.isRepositoryFullName(payload.repositoryFullName) &&
      this.identifiers.isBranchName(payload.defaultBranch) &&
      this.identifiers.isSha(payload.sha);
    if (!valid) throw new SyncError(this.reasons.invalidPayload);
    const name = payload.repositoryFullName.split("/")[1];
    const path = this.packagesDirectory + name;
    if (!this.identifiers.isSubmodulePath(path)) throw new SyncError(this.reasons.invalidPayload);
    const result = { repositoryFullName: payload.repositoryFullName, path, sha: payload.sha };
    if (this.gitlinkOid(path) !== null) return { ...result, status: this.statuses.noop };
    const branch = "feat/add-" + name + "-package-" + this.runSuffix();
    const section = "submodule." + path;
    this.git(["update-index", "--add", "--cacheinfo", this.gitlinkMode + "," + payload.sha + "," + path]);
    this.git(["config", "-f", this.gitmodulesFile, section + ".path", path]);
    this.git([
      "config",
      "-f",
      this.gitmodulesFile,
      section + ".url",
      this.repositoryUrlPrefix + payload.repositoryFullName + this.repositoryUrlSuffix,
    ]);
    this.git(["config", "-f", this.gitmodulesFile, section + ".branch", payload.defaultBranch]);
    this.git(["add", this.gitmodulesFile]);
    this.commitAndPush(branch, "feat: add " + payload.repositoryFullName + " as a package");
    return { ...result, status: this.statuses.pushed, branch };
  }

  unlinkPackage(payload) {
    if (!this.identifiers.isSubmodulePath(payload.path)) throw new SyncError(this.reasons.invalidPayload);
    const result = { path: payload.path };
    if (this.gitlinkOid(payload.path) === null) return { ...result, status: this.statuses.noop };
    const name = payload.path.slice(this.packagesDirectory.length);
    const branch = "feat/remove-" + name + "-package-" + this.runSuffix();
    this.git(["rm", "--cached", "-f", "--", payload.path]);
    this.removeGitmodulesSection(payload.path);
    if (existsSync(this.gitmodulesFile)) this.git(["add", this.gitmodulesFile]);
    this.commitAndPush(branch, "feat: remove " + name + " as a package");
    return { ...result, status: this.statuses.pushed, branch };
  }

  removeGitmodulesSection(path) {
    try {
      this.git(["config", "-f", this.gitmodulesFile, "--remove-section", "submodule." + path]);
    } catch (error) {
      if (error.status !== this.missingSectionExitCode) throw error;
    }
  }

  async notify(body) {
    const tokenResponse = await fetch(
      this.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=" + encodeURIComponent(this.env.OIDC_AUDIENCE),
      { headers: { authorization: "Bearer " + this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }
    );
    if (!tokenResponse.ok) throw new Error("requesting the OIDC token failed (" + tokenResponse.status + ")");
    const { value } = await tokenResponse.json();
    const response = await fetch(this.env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, oidcToken: value }),
    });
    if (!response.ok) throw new Error("notifying the result failed (" + response.status + ")");
  }

  failureResult(reason, payload) {
    const result = { status: this.statuses.failed, reason };
    if (payload && this.identifiers.isId(payload.eventId)) result.eventId = payload.eventId;
    if (payload && this.identifiers.isId(payload.packageId)) result.packageId = payload.packageId;
    if (payload && this.identifiers.isSubmodulePath(payload.path)) result.path = payload.path;
    return result;
  }

  async run() {
    const event = this.env.EVENT_NAME;
    let payload = null;
    let result;
    try {
      payload = this.parsePayload();
      const handle = this.handlers()[event];
      if (!handle) throw new SyncError(this.reasons.unsupportedEvent);
      result = handle(payload);
    } catch (error) {
      const reason = error instanceof SyncError ? error.message : this.reasons.unexpectedError;
      console.error("sync failed: " + reason);
      result = this.failureResult(reason, payload);
    }
    await this.notify({ event, ...result });
    if (result.status === this.statuses.failed) process.exit(1);
  }
}

await new SyncRunner(process.env).run();
