/**
 * Release gate: the suite runs against at least the versions this package demands of hosts.
 * Every peerDependency also in devDependencies must have a devDep floor >= the peer floor, and a
 * required (non-optional) peer must be a devDependency — otherwise CI validates an older contract
 * than consumers install. Zero deps; plain x.y.z floor compare. Wired into `npm run ci`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

const peers = pkg.peerDependencies ?? {};
const devDeps = pkg.devDependencies ?? {};
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional)
    .map(([name]) => name),
);

/** First x.y.z triple in a range string, or null. */
function floorOf(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lessThan(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

const failures = [];

for (const [name, peerRange] of Object.entries(peers)) {
  const devRange = devDeps[name];
  if (!devRange) {
    if (!optionalPeers.has(name)) {
      failures.push(
        `${name}: required peer (${peerRange}) is not in devDependencies — the suite never exercises it.`,
      );
    }
    continue;
  }
  const peerFloor = floorOf(peerRange);
  const devFloor = floorOf(devRange);
  if (!peerFloor || !devFloor) continue;
  if (lessThan(devFloor, peerFloor)) {
    failures.push(
      `${name}: devDependency ${devRange} is BELOW the declared peer floor ${peerRange}. ` +
        `The suite runs against an older API than hosts are told to install.`,
    );
  }
}

if (failures.length > 0) {
  console.error("[check-peer-skew] FAIL — peer/devDep version skew detected:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nAlign devDependencies to (at least) each peer floor, reinstall, and re-run the suite.",
  );
  process.exit(1);
}

console.log("[check-peer-skew] OK — every peer floor is covered by devDependencies.");
