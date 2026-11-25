// Set the app version everywhere it is written, e.g.: npm run release:version -- 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: npm run release:version -- <major.minor.patch>");
  process.exit(1);
}

function edit(path, change) {
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before) throw new Error(`No version found in ${path}`);
  writeFileSync(path, after);
  console.log(`  ${path}`);
}

const json = (path, set) =>
  edit(path, (text) => {
    const data = JSON.parse(text);
    set(data);
    return JSON.stringify(data, null, 2) + "\n";
  });

console.log(`Setting version ${version} in:`);
json("package.json", (d) => (d.version = version));
json("package-lock.json", (d) => {
  d.version = version;
  if (d.packages?.[""]) d.packages[""].version = version;
});
json("src-tauri/tauri.conf.json", (d) => (d.version = version));
// The first `version = "…"` of Cargo.toml is the [package] one.
edit("src-tauri/Cargo.toml", (t) => t.replace(/^version = "[^"]*"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (t) =>
  t.replace(/(\[\[package\]\]\r?\nname = "gian-claudio"\r?\nversion = )"[^"]*"/, `$1"${version}"`),
);

console.log(`
Next:
  1. Move the "Unreleased" notes in CHANGELOG.md under ## [${version}].
  2. git commit -am "Release v${version}"
  3. git tag v${version}
  4. git push origin main v${version}
  5. Publish the draft release on GitHub when the Release action finishes.`);
