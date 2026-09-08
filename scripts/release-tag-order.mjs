#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

if (process.argv[2] === "--channels") {
  console.log(releaseChannels(process.argv[3]).join(" "));
  process.exit(0);
}

if (process.argv[2] === "--self-test") {
  assert.deepEqual(releaseChannels("0.0.11-alpha.63"), ["alpha", "latest"]);
  assert.deepEqual(releaseChannels("0.1.0-alpha.17"), ["alpha"]);
  assert.deepEqual(releaseChannels("0.1.2-alpha.1"), ["alpha"]);
  assert.deepEqual(releaseChannels("0.1.2-beta.1"), ["beta"]);
  assert.deepEqual(releaseChannels("0.1.2-rc.1"), ["rc"]);
  assert.deepEqual(releaseChannels("0.1.2"), ["latest"]);
  assert.throws(() => releaseChannels("0.1.2-preview.1"), /Unsupported/);
  const ancestor = (left, right) => left === "old" && right === "new";
  assert.equal(decide("same", "same", ancestor), "same");
  assert.equal(decide("new", "old", ancestor), "advance");
  assert.equal(decide("old", "new", ancestor), "preserve");
  assert.throws(() => decide("left", "right", ancestor), /not comparable/);

  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  let previous = -1;
  for (const step of [
    "Publish to npmjs",
    "Mirror to GitHub Packages",
    "Dispatch Starter release worker",
    "Wait for immutable Starter tag",
    "Validate released Starter provenance",
    "Test released Starter against the public registry",
    "Promote npmjs channel tags",
    "Promote GitHub Packages channel tags",
    "Create GitHub release",
  ]) {
    const current = workflow.indexOf(`- name: ${step}`);
    assert.ok(current > previous, `${step} is missing or out of order`);
    previous = current;
  }

  console.log("release self-test passed");
  process.exit(0);
}

const [candidateSha, currentVersion] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateSha ?? "") || !currentVersion) {
  throw new Error("usage: release-tag-order.mjs <candidate-sha> <current-version>");
}
const currentSha = git("rev-parse", `refs/tags/v${currentVersion}^{commit}`);
console.log(decide(candidateSha, currentSha, isAncestor));

function decide(candidate, current, ancestor) {
  if (candidate === current) return "same";
  if (ancestor(current, candidate)) return "advance";
  if (ancestor(candidate, current)) return "preserve";
  throw new Error(`release commits ${candidate} and ${current} are not comparable`);
}

function isAncestor(left, right) {
  return spawnSync("git", ["merge-base", "--is-ancestor", left, right]).status === 0;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function releaseChannels(version) {
  const prerelease = version.match(/-(alpha|beta|rc)(?:\.|$)/)?.[1];
  if (version.includes("-") && !prerelease) throw new Error(`Unsupported prerelease channel: ${version}`);
  const channel = prerelease ?? "latest";
  return /^0\.0\.\d+-alpha(?:\.|$)/.test(version) ? [channel, "latest"] : [channel];
}
