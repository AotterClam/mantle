#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const steps = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
const ordered = [
  "Check Core source",
  "Pack release tarballs", "Verify release credentials", "Create immutable Core tag",
  "Publish to npmjs", "Verify immutable npm artifacts", "Mirror to GitHub Packages",
  "Verify public-registry Core in the reference Worker",
  "Promote npmjs channel tags", "Promote GitHub Packages channel tags", "Create GitHub release",
];
let previous = -1;
for (const name of ordered) {
  const index = steps.indexOf(name);
  assert(index > previous, `${name} must occur once in release order`);
  assert.equal(steps.lastIndexOf(name), index);
  previous = index;
}
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert(pkg.scripts.check.includes("pnpm check:worker-consumer"));
assert.match(workflow, /- name: Check Core source\n        run: pnpm check/);
assert.doesNotMatch(workflow, /mantle-starters|mantle-landing|RELEASE_FANOUT_TOKEN|deploy_landing/);
assert.match(workflow, /run: node scripts\/check-worker-consumer\.mjs --registry "\$VERSION"/);
assert.doesNotMatch(workflow, /continue-on-error:/);
console.log("Core-only release order and public consumer gate passed");
