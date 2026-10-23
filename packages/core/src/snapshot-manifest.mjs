import fs from "node:fs";
import path from "node:path";
import { digest, privateDir, readPrivate } from "./review-storage.mjs";
import { coordinationDirectory } from "./workspace.mjs";

const MAX = 32 * 1024 * 1024;
function directory(repo) {
  return privateDir(coordinationDirectory(repo), "snapshots-v1");
}
export function retainSnapshotManifest(repo, snapshot) {
  const document = { version: 1, snapshot_hash: snapshot.hash, files: snapshot.files };
  const text = `${JSON.stringify(document)}\n`,
    sha256 = digest(text);
  if (Buffer.byteLength(text) > MAX)
    return {
      version: 1,
      available: false,
      reason: "manifest exceeds 32 MiB; aggregate snapshot remains authoritative",
    };
  const target = path.join(directory(repo), `${sha256}.json`);
  try {
    fs.writeFileSync(target, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || readPrivate(target, MAX) !== text) throw error;
  }
  return { version: 1, sha256, file_count: snapshot.files.length };
}

// Diagnostic-only. Neither a missing manifest nor a tampered one changes the
// authoritative aggregate hash comparison or grants any lifecycle approval.
export function explainSnapshotDrift(repo, impl, current) {
  const reference = impl?.snapshot_manifest;
  if (!reference?.sha256)
    return {
      available: false,
      reason:
        reference?.reason ||
        "legacy impl has no retained per-file manifest; rerun impl to establish a baseline",
      changes: [],
      total: null,
    };
  try {
    if (reference.version !== 1 || !/^[a-f0-9]{64}$/.test(reference.sha256))
      throw new Error("invalid manifest reference");
    const text = readPrivate(path.join(directory(repo), `${reference.sha256}.json`), MAX);
    if (digest(text) !== reference.sha256) throw new Error("retained manifest was modified");
    const before = JSON.parse(text);
    if (
      before.version !== 1 ||
      before.snapshot_hash !== impl.snapshot_hash ||
      !Array.isArray(before.files) ||
      before.files.some(
        (item) =>
          typeof item.path !== "string" ||
          path.isAbsolute(item.path) ||
          item.path.split("/").includes("..") ||
          !/^[a-f0-9]{64}$/.test(item.hash),
      )
    )
      throw new Error("retained manifest does not bind this impl");
    const old = new Map(before.files.map((item) => [item.path, item]));
    const next = new Map(current.files.map((item) => [item.path, item]));
    const changes = [];
    for (const file of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const a = old.get(file),
        b = next.get(file);
      if (!a) changes.push({ path: file, change: "added" });
      else if (!b) changes.push({ path: file, change: "deleted" });
      else if (a.hash !== b.hash)
        changes.push({
          path: file,
          change:
            a.kind !== b.kind ? "type-changed" : a.mode !== b.mode ? "mode-changed" : "modified",
        });
    }
    return {
      available: true,
      changes: changes.slice(0, 100),
      total: changes.length,
      truncated: changes.length > 100,
    };
  } catch (error) {
    return {
      available: false,
      reason: `manifest unavailable/untrusted: ${error.message}`,
      changes: [],
      total: null,
    };
  }
}
export function driftSummary(drift) {
  return drift.available
    ? `${drift.total} changed paths: ${drift.changes
        .slice(0, 8)
        .map((item) => `${item.change}:${item.path.slice(0, 150)}`)
        .join(", ")}${drift.total > 8 ? " (see structured drift)" : ""}`
    : drift.reason;
}
