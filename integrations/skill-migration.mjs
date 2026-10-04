// S1.7's explicitly authorized local integration only. Never run on discovery.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "skill-migration.json"), "utf8"));
const bundle = path.join(here, "autonomous-delivery");
const authorized = { autonomous: "<home>/.pi/agent/skills/autonomous-delivery", reviewer: "<home>/.pi/agent/skills/independent-spec-diff-review" };
const archive = "<home>/.pi/agent/retired-skills/S1.7";
if (config.version !== 1 || config.contract !== "S1.7" || config.archive !== archive || JSON.stringify(config.paths) !== JSON.stringify(authorized)) throw new Error("Migration authority/path mismatch");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function tree(root) {
  const output = {};
  function walk(dir) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Integration root cannot be symlink/non-directory");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Integration refuses symlinks");
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) output[path.relative(root, file)] = hash(fs.readFileSync(file));
      else throw new Error("Integration refuses non-regular files");
    }
  }
  walk(root); return output;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function verifyBundle() {
  const actual = tree(bundle), manifest = fs.readFileSync(path.join(bundle, "MANIFEST.sha256"), "utf8").trim().split("\n");
  const listed = {};
  for (const line of manifest) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9./_-]+)$/);
    if (!match || match[2].includes("..") || Object.hasOwn(listed, match[2]) || actual[match[2]] !== match[1]) throw new Error("Bundle manifest mismatch");
    listed[match[2]] = match[1];
  }
  if (Object.keys(actual).length !== manifest.length + 1) throw new Error("Unmanifested bundle files");
  return actual;
}
function safeParents(dir) {
  let current = path.parse(dir).root;
  for (const segment of dir.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe migration parent");
  }
}
const updated = verifyBundle(), command = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--install", "--rollback"].includes(command)) throw new Error("Use --check, --install or --rollback; never automatic");
if (command === "--check") console.log("PASS tracked autonomous bundle/version/SHA-256 manifest");
else {
  safeParents(path.dirname(authorized.autonomous)); safeParents(archive);
  const oldAutonomous = path.join(archive, "autonomous-delivery-1.0.0"), oldReviewer = path.join(archive, "independent-spec-diff-review");
  const receipt = path.join(archive, "migration.json");
  if (command === "--install") {
    if (fs.existsSync(receipt) || fs.existsSync(oldAutonomous) || fs.existsSync(oldReviewer)) throw new Error("Already migrated/occupied archive; no silent replacement");
    for (const name of Object.keys(authorized)) if (!equal(tree(authorized[name]), config.originals[name])) throw new Error(`Concurrent installed skill edit: ${name}; not overwritten`);
    const stage = path.join(archive, "install-stage"); if (fs.existsSync(stage)) throw new Error("Occupied install stage");
    fs.cpSync(bundle, stage, { recursive: true, errorOnExist: true, force: false });
    if (!equal(tree(stage), updated)) throw new Error("Staged bundle mismatch");
    // Recheck immediately before moves, including the duplicate's immutable source.
    for (const name of Object.keys(authorized)) if (!equal(tree(authorized[name]), config.originals[name])) throw new Error(`Concurrent installed skill edit: ${name}`);
    fs.renameSync(authorized.autonomous, oldAutonomous);
    try { fs.renameSync(stage, authorized.autonomous); }
    catch (error) { if (!fs.existsSync(authorized.autonomous)) fs.renameSync(oldAutonomous, authorized.autonomous); throw error; }
    // Only authorized after real host replacement acceptance (recorded in governing Spec).
    if (!equal(tree(authorized.reviewer), config.originals.reviewer)) throw new Error("Reviewer changed during migration; do not retire concurrent content");
    fs.renameSync(authorized.reviewer, oldReviewer);
    fs.writeFileSync(receipt, JSON.stringify({ version: 1, contract: config.contract, state: "installed", updated, at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("PASS installed autonomous 1.1.0; archived both originals outside skill discovery");
  } else {
    const state = JSON.parse(fs.readFileSync(receipt, "utf8"));
    const retiredNew = path.join(archive, "autonomous-delivery-1.1.0-rollback");
    if (state.state !== "installed" || fs.existsSync(authorized.reviewer) || fs.existsSync(retiredNew) || !equal(tree(authorized.autonomous), state.updated) ||
        !equal(tree(oldAutonomous), config.originals.autonomous) || !equal(tree(oldReviewer), config.originals.reviewer)) throw new Error("Concurrent edits/collision prevent rollback; preserve all directories");
    fs.renameSync(authorized.autonomous, retiredNew); fs.renameSync(oldAutonomous, authorized.autonomous); fs.renameSync(oldReviewer, authorized.reviewer);
    fs.writeFileSync(receipt, JSON.stringify({ ...state, state: "rolled-back", rollback_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    console.log("PASS reversible rollback, updated bundle preserved in archive");
  }
}
