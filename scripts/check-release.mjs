import { existsSync, readFileSync } from "node:fs";

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

if (existsSync("data.json")) {
  fail("data.json must not be committed or included in a release.");
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== manifest.version) {
  fail(`Git tag ${tag} must exactly match manifest version ${manifest.version}.`);
}
