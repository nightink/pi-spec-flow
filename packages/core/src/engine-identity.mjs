import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Captured once on module initialization, never recomputed from newer disk files
// and mislabeled as a hot reload. No absolute user paths or environment values.
const root = path.dirname(fileURLToPath(import.meta.url));
const hash = crypto.createHash("sha256");
function fingerprint(directory) {
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(file);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      hash.update(path.relative(root, file).split(path.sep).join("/"));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
  }
}
fingerprint(root);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "../package.json"), "utf8"));
const identity = Object.freeze({
  package: pkg.name,
  version: pkg.version,
  source_sha256: hash.digest("hex"),
  loaded_at: new Date().toISOString(),
  measurement: "core source bytes at module initialization; not hot-reload evidence",
});
export function engineIdentity() {
  return { ...identity };
}
