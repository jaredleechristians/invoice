#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const part = (process.argv[2] || "patch").toLowerCase();
if (!["major", "minor", "patch"].includes(part)) {
  console.error('Usage: node scripts/bump-version.js [major|minor|patch]');
  process.exit(1);
}

const root = path.join(__dirname, "..");
const rootPkgPath = path.join(root, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

const [major, minor, patch] = String(rootPkg.version)
  .split(".")
  .map((n) => Number.parseInt(n, 10) || 0);

let next;
if (part === "major") next = `${major + 1}.0.0`;
else if (part === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

rootPkg.version = next;
fs.writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
console.log(`Bumped version → ${next}`);

require("./sync-version.js");
