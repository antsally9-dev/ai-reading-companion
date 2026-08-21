import { existsSync, readFileSync, statSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  console.error(`Release check failed: ${message}`);
  process.exitCode = 1;
};

const packageJson = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const expectedFiles = ["main.js", "manifest.json", "styles.css"];

if (packageJson.version !== manifest.version) {
  fail(`package.json is ${packageJson.version}, but manifest.json is ${manifest.version}.`);
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  fail(
    `versions.json must map ${manifest.version} to ${manifest.minAppVersion}.`,
  );
}

if (!/^[a-z0-9-]+$/.test(manifest.id)) {
  fail(`manifest id "${manifest.id}" must contain only lowercase letters, numbers, and hyphens.`);
}

for (const path of expectedFiles) {
  if (!existsSync(path)) {
    fail(`missing release file ${path}. Run npm run build first.`);
  }
}

const mainBytes = existsSync("main.js") ? statSync("main.js").size : 0;
const releaseBytes = expectedFiles.reduce(
  (total, path) => total + (existsSync(path) ? statSync(path).size : 0),
  0,
);
if (mainBytes > 300 * 1024) {
  fail(`main.js is ${(mainBytes / 1024).toFixed(1)} KiB; the release budget is 300 KiB.`);
}
if (releaseBytes > 400 * 1024) {
  fail(
    `release files total ${(releaseBytes / 1024).toFixed(1)} KiB; the release budget is 400 KiB.`,
  );
}

if (existsSync("data.json")) {
  fail("data.json must not be committed or included in a release.");
}

const refType = process.env.GITHUB_REF_TYPE;
const tag = process.env.GITHUB_REF_NAME;
if (refType === "tag" && tag && tag !== manifest.version) {
  fail(`Git tag ${tag} must exactly match manifest version ${manifest.version}.`);
}
