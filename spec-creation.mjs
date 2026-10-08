// Deterministic scaffolding; project bodies are data, never executable templates.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadProjectProfile, canonicalSpecId } from "./project-profile.mjs";
import { getSpecDirectories, findSpec, projectContractProblems, writeFrontmatter,
  updateStatusLine, withAllocator, reserveSpecIdUnlocked, appendLedger } from "./core.mjs";

export const SPEC_TEMPLATE_VERSION = 1;
const SLOTS = ["title", "goals", "non_goals", "design", "plan", "acceptance"];
const INPUT_KEYS = ["title", "prefix", "slug", "goals", "nonGoals", "design", "plan", "acceptance", "dependencies", "dryRun"];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const builtin = fileURLToPath(new URL("./templates/spec-v1.md", import.meta.url));
function text(value, name, max = 4000) {
  // eslint-disable-next-line no-control-regex -- bounded single-line text; control bytes are rejected
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be bounded nonempty single-line text`);
  }
  return value.trim();
}
function items(value, name) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error(`${name} must be a nonempty bounded array`);
  return value.map((item) => text(item, name));
}
function safeAncestors(root, directory, create = false) {
  let current = root;
  for (const part of directory.split("/")) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      // lstat catches a dangling link as well.
      try { fs.lstatSync(current); throw new Error(`Unsafe creation directory: ${current}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (create) fs.mkdirSync(current);
    } else {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe creation directory: ${current}`);
    }
  }
  return current;
}
function readTemplate(root, relative) {
  let file = builtin;
  if (relative) {
    safeAncestors(root, path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
    file = path.join(root, relative);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Template must be a bounded regular non-symlink file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let body;
  try { body = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
  if (!/^#\s/.test(body) || body.startsWith("---")) throw new Error("Template must be a heading-led body, without frontmatter");
  const tokens = [...body.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1]);
  if (tokens.length !== SLOTS.length || SLOTS.some((slot) => tokens.filter((token) => token === slot).length !== 1) || /\{[{}]|[{}]\}/.test(body.replace(/\{\{[^{}]*\}\}/g, ""))) {
    throw new Error("Template requires each known literal slot exactly once and no other expressions");
  }
  return { body, version: SPEC_TEMPLATE_VERSION, sha256: hash(body) };
}
export function previewTemplate() {
  const body = fs.readFileSync(builtin, "utf8");
  return { version: SPEC_TEMPLATE_VERSION, sha256: hash(body), body, inputKeys: INPUT_KEYS };
}
export async function createSpec(cwd, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !INPUT_KEYS.includes(key))) {
    throw new Error("spec_new has unknown/invalid structured input fields");
  }
  const root = fs.realpathSync(cwd), profile = loadProjectProfile(root);
  const title = text(input.title, "title", 300);
  const prefix = input.prefix ?? "";
  if (typeof prefix !== "string" || prefix.length > 80 || (prefix && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix))) throw new Error("Invalid Spec ID prefix");
  const slug = input.slug ?? "spec";
  if (typeof slug !== "string" || slug.length > 80 || !/^[a-z0-9][a-z0-9-]*$/.test(slug) ||
      (profile.validation?.forbidAddendumFilename && /addendum/i.test(slug))) throw new Error("Invalid Spec filename slug");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new Error("dryRun must be boolean");
  const status = profile.lifecycle.preReview[0];
  if (!status) throw new Error("spec_new requires a project preReview draft status; configure lifecycle.preReview");
  if (profile.validation?.numericFileId && prefix) throw new Error("Numeric project cannot use a prefixed Spec ID");
  const existing = getSpecDirectories(root);
  let directory = profile.creation?.directory;
  if (!directory) {
    if (existing.length > 1) throw new Error("Ambiguous Spec directories; configure creation.directory");
    directory = existing[0]?.relativePath ?? "docs/specs";
  }
  safeAncestors(root, directory);
  const template = readTemplate(root, profile.creation?.template);
  const fields = {};
  for (const [key, label] of [["goals", "goals"], ["nonGoals", "non_goals"], ["design", "design"], ["plan", "plan"], ["acceptance", "acceptance"]]) {
    fields[label] = items(input[key], key);
  }
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some((id) =>
    !["string", "number"].includes(typeof id) || !canonicalSpecId(id) || !findSpec(root, id))) {
    throw new Error("dependencies must identify existing project Specs");
  }
  if (new Set(dependencies.map(canonicalSpecId)).size !== dependencies.length) throw new Error("Duplicate dependencies");
  const date = new Date().toISOString().slice(0, 10);
  const fm = { ...profile.creation?.defaults, id: prefix ? `${prefix}1` : 1, title,
    kind: "spec", author: "agent", status, created: date,
    review: { decision: "pending" }, evidence: { e2e: [], migrations: [], human: [] },
    template: { version: template.version, sha256: template.sha256 } };
  Object.assign(fm, profile.creation?.defaults || {});
  if (profile.validation && !profile.validation.allowedKinds.includes(fm[profile.validation.kindField])) {
    throw new Error(`Configure creation.defaults.${profile.validation.kindField} with an allowed kind`);
  }
  if (profile.validation?.kindField && ["id", "title", "status", "author", "created", "review", "evidence", "template"].includes(profile.validation.kindField)) {
    throw new Error("Unsupported creation kindField collision");
  }
  fm[profile.lifecycle.dependenciesField] = profile.validation?.dependencyIntegrity
    ? dependencies.map((id) => { const number = Number(id); if (!Number.isSafeInteger(number) || number < 0) throw new Error("Numeric dependency required"); return number; })
    : dependencies;
  if (profile.lifecycle.updatedField) fm[profile.lifecycle.updatedField] = date;
  const approval = profile.lifecycle.approval;
  if (approval.mode === "reviewers") { fm[approval.reviewersField] = []; fm[approval.reviewedAtField] = null; }
  const values = { title,
    goals: (fields.goals || ["TODO: define observable outcome"]).map((item) => `- ${item}`).join("\n"),
    non_goals: (fields.non_goals || ["TODO: define scope and safety limits"]).map((item) => `- ${item}`).join("\n"),
    design: (fields.design || ["TODO: define the smallest complete design"]).map((item) => `- ${item}`).join("\n"),
    plan: (fields.plan || ["TODO: review proposal before implementation"]).map((item, i) => `${i + 1}. ${item}`).join("\n"),
    acceptance: (fields.acceptance || ["TODO: define executable acceptance"]).map((item) => `- [ ] ${item}`).join("\n") };
  // Callback replacement avoids interpreting user $&/$` sequences.
  const body = template.body.replace(/\{\{([^{}]*)\}\}/g, (_match, slot) => values[slot]);
  const filename = (id) => `${id}${prefix ? "-" : "."}${slug}.md`;
  const render = () => {
    let content = writeFrontmatter(body, fm);
    if (profile.lifecycle.bodyStatusLine) content = updateStatusLine(content, status);
    return content;
  };
  const validate = (id) => {
    fm.id = profile.validation?.numericFileId || !prefix ? Number(id) : id;
    const content = render();
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error("Generated Spec exceeds 256 KiB reviewable contract limit");
    const problems = projectContractProblems({ file: filename(id), content, frontmatter: fm }, profile);
    if (problems.length) throw new Error(`Cannot create valid draft: ${problems.join("; ")}`);
    return content;
  };
  validate(prefix ? `${prefix}1` : "1"); // All fallible metadata/template checks precede allocation.
  if (input.dryRun) return { dryRun: true, directory, status, template: fm.template, content: render() };
  return withAllocator(root, () => {
    if (JSON.stringify(loadProjectProfile(root)) !== JSON.stringify(profile) ||
        readTemplate(root, profile.creation?.template).sha256 !== template.sha256) throw new Error("Creation policy/template changed while waiting; retry current authority");
    if (!profile.creation?.directory) {
      const current = getSpecDirectories(root);
      if (current.length > 1 || (current.length === 1 && current[0].relativePath !== directory)) throw new Error("Creation directory selection changed; configure creation.directory");
    }
    const id = reserveSpecIdUnlocked(root, prefix);
    const content = validate(id);
    const dir = safeAncestors(root, directory, true);
    const target = path.join(dir, filename(id));
    const temp = path.join(dir, `.spec-new-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temp, content, { flag: "wx", mode: 0o644 });
      fs.linkSync(temp, target); // Atomic exclusive publication, never replaces a file/symlink.
    } finally { fs.rmSync(temp, { force: true }); }
    appendLedger(root, { type: "spec-new", spec: id, path: path.relative(root, target), template: fm.template });
    return { id, path: path.relative(root, target), status, template: fm.template };
  });
}
