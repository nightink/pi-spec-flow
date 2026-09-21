import fs from "node:fs";
import path from "node:path";

export const PROJECT_PROFILE_FILE = ".spec-flow.json";
const MAX_PROFILE_BYTES = 64 * 1024;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SAFE_NPM_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_FRONTMATTER_FIELDS = new Set([
  "id",
  "status",
  "workflow_version",
  "impl",
  "audit",
  "attestations",
  "evidence",
  "scope",
  "review",
]);

const DEFAULT_PROFILE = Object.freeze({
  configured: false,
  sourcePath: null,
  lifecycle: Object.freeze({
    preReview: Object.freeze([]),
    startable: Object.freeze(["pending", "approved"]),
    active: "in-progress",
    done: "done",
    ignored: Object.freeze([]),
    dependenciesField: "deps",
    updatedField: null,
    bodyStatusLine: true,
    legacyActive: "error",
    externalActiveIds: Object.freeze([]),
    approval: Object.freeze({ mode: "decision" }),
  }),
  gates: null,
  contractMetadataFields: Object.freeze([]),
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value, allowed, label) {
  assertObject(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedSet.has(key)) {
      throw new Error(`${label} contains unknown key: ${key}`);
    }
  }
}

function assertStringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array`);
  }
  if (
    value.some(
      (item) => typeof item !== "string" || !item.trim() || item !== item.trim()
    )
  ) {
    throw new Error(`${label} items must be non-empty, trimmed strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function assertField(value, label) {
  if (
    typeof value !== "string" ||
    !SAFE_FIELD.test(value) ||
    FORBIDDEN_KEYS.has(value) ||
    RESERVED_FRONTMATTER_FIELDS.has(value)
  ) {
    throw new Error(`${label} must be a safe, non-reserved frontmatter field name`);
  }
}

function canonicalConfiguredId(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} numeric IDs must be safe integers`);
    return String(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} items must be non-empty strings or safe integers`);
  }
  return value.trim();
}

function validateExternalActiveIds(lifecycle) {
  if (!Array.isArray(lifecycle.externalActiveIds)) {
    throw new Error("lifecycle.externalActiveIds must be an array");
  }
  const ids = lifecycle.externalActiveIds.map((value) =>
    canonicalConfiguredId(value, "lifecycle.externalActiveIds")
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("lifecycle.externalActiveIds must not contain duplicate IDs");
  }
  if (lifecycle.legacyActive === "external-warning" && ids.length === 0) {
    throw new Error(
      "lifecycle.externalActiveIds must list each historical active spec when external-warning is enabled"
    );
  }
  if (lifecycle.legacyActive === "error" && ids.length > 0) {
    throw new Error("lifecycle.externalActiveIds must be empty when legacyActive is error");
  }
  return ids;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function readProfileFile(root, candidate) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot inspect ${PROJECT_PROFILE_FILE}: ${error?.message || error}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${PROJECT_PROFILE_FILE} must be a regular non-symlink file`);
  }
  if (stat.size > MAX_PROFILE_BYTES) {
    throw new Error(`${PROJECT_PROFILE_FILE} exceeds ${MAX_PROFILE_BYTES} bytes`);
  }

  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(candidate);
  if (!pathInside(realRoot, realFile)) {
    throw new Error(`${PROJECT_PROFILE_FILE} escapes the project root`);
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_PROFILE_BYTES) {
      throw new Error(`${PROJECT_PROFILE_FILE} is not a safe regular file`);
    }
    return fs.readFileSync(fd, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${PROJECT_PROFILE_FILE}: ${error?.message || error}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateStatusRoles(lifecycle) {
  assertStringArray(lifecycle.preReview, "lifecycle.preReview");
  assertStringArray(lifecycle.startable, "lifecycle.startable", { nonEmpty: true });
  assertStringArray(lifecycle.ignored, "lifecycle.ignored");
  if (
    typeof lifecycle.active !== "string" ||
    !lifecycle.active.trim() ||
    lifecycle.active !== lifecycle.active.trim()
  ) {
    throw new Error("lifecycle.active must be a non-empty, trimmed string");
  }
  if (
    typeof lifecycle.done !== "string" ||
    !lifecycle.done.trim() ||
    lifecycle.done !== lifecycle.done.trim()
  ) {
    throw new Error("lifecycle.done must be a non-empty, trimmed string");
  }

  const roles = [
    ...lifecycle.preReview.map((status) => [status, "preReview"]),
    ...lifecycle.startable.map((status) => [status, "startable"]),
    [lifecycle.active, "active"],
    [lifecycle.done, "done"],
    ...lifecycle.ignored.map((status) => [status, "ignored"]),
  ];
  const seen = new Map();
  for (const [status, role] of roles) {
    if (seen.has(status)) {
      throw new Error(
        `lifecycle status ${JSON.stringify(status)} overlaps ${seen.get(status)} and ${role}`
      );
    }
    seen.set(status, role);
  }
}

function parseConfiguredProfile(root, raw) {
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid ${PROJECT_PROFILE_FILE} JSON: ${error?.message || error}`);
  }

  assertExactKeys(data, ["version", "lifecycle", "gates"], PROJECT_PROFILE_FILE);
  if (data.version !== 1) throw new Error(`${PROJECT_PROFILE_FILE} version must be 1`);

  assertExactKeys(
    data.lifecycle,
    [
      "preReview",
      "startable",
      "active",
      "done",
      "ignored",
      "dependenciesField",
      "updatedField",
      "bodyStatusLine",
      "legacyActive",
      "externalActiveIds",
      "approval",
    ],
    "lifecycle"
  );
  const lifecycle = data.lifecycle;
  validateStatusRoles(lifecycle);
  assertField(lifecycle.dependenciesField, "lifecycle.dependenciesField");
  assertField(lifecycle.updatedField, "lifecycle.updatedField");
  if (typeof lifecycle.bodyStatusLine !== "boolean") {
    throw new Error("lifecycle.bodyStatusLine must be boolean");
  }
  if (!new Set(["error", "external-warning"]).has(lifecycle.legacyActive)) {
    throw new Error('lifecycle.legacyActive must be "error" or "external-warning"');
  }
  const externalActiveIds = validateExternalActiveIds(lifecycle);

  assertExactKeys(
    lifecycle.approval,
    ["reviewersField", "reviewedAtField", "minimumReviewers", "placeholderReviewers"],
    "lifecycle.approval"
  );
  const approval = lifecycle.approval;
  assertField(approval.reviewersField, "lifecycle.approval.reviewersField");
  assertField(approval.reviewedAtField, "lifecycle.approval.reviewedAtField");
  if (!Number.isSafeInteger(approval.minimumReviewers) || approval.minimumReviewers < 1) {
    throw new Error("lifecycle.approval.minimumReviewers must be a positive integer");
  }
  assertStringArray(
    approval.placeholderReviewers,
    "lifecycle.approval.placeholderReviewers"
  );

  const metadataFields = [
    lifecycle.updatedField,
    approval.reviewersField,
    approval.reviewedAtField,
  ];
  if (new Set([lifecycle.dependenciesField, ...metadataFields]).size !== 4) {
    throw new Error("lifecycle dependency/review/update fields must be distinct");
  }

  assertExactKeys(data.gates, ["mode", "npmScripts"], "gates");
  if (data.gates.mode !== "replace") {
    throw new Error('gates.mode must be "replace" in profile version 1');
  }
  assertStringArray(data.gates.npmScripts, "gates.npmScripts", { nonEmpty: true });
  for (const script of data.gates.npmScripts) {
    if (!SAFE_NPM_SCRIPT.test(script) || FORBIDDEN_KEYS.has(script)) {
      throw new Error(`gates.npmScripts contains unsafe script name: ${script}`);
    }
  }

  const packagePath = path.join(root, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot validate configured npm scripts: ${error?.message || error}`);
  }
  for (const script of data.gates.npmScripts) {
    if (typeof pkg?.scripts?.[script] !== "string" || !pkg.scripts[script].trim()) {
      throw new Error(`Configured npm script does not exist: ${script}`);
    }
  }

  return {
    configured: true,
    sourcePath: path.join(root, PROJECT_PROFILE_FILE),
    lifecycle: {
      preReview: [...lifecycle.preReview],
      startable: [...lifecycle.startable],
      active: lifecycle.active,
      done: lifecycle.done,
      ignored: [...lifecycle.ignored],
      dependenciesField: lifecycle.dependenciesField,
      updatedField: lifecycle.updatedField,
      bodyStatusLine: lifecycle.bodyStatusLine,
      legacyActive: lifecycle.legacyActive,
      externalActiveIds,
      approval: {
        mode: "reviewers",
        reviewersField: approval.reviewersField,
        reviewedAtField: approval.reviewedAtField,
        minimumReviewers: approval.minimumReviewers,
        placeholderReviewers: [...approval.placeholderReviewers],
      },
    },
    gates: {
      mode: "replace",
      npmScripts: [...data.gates.npmScripts],
    },
    contractMetadataFields: metadataFields,
  };
}

export function defaultProjectProfile() {
  return DEFAULT_PROFILE;
}

export function loadProjectProfile(cwd) {
  const root = path.resolve(cwd);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (error) {
    throw new Error(`Cannot resolve project root: ${error?.message || error}`);
  }
  const candidate = path.join(realRoot, PROJECT_PROFILE_FILE);
  const raw = readProfileFile(realRoot, candidate);
  return raw === null ? DEFAULT_PROFILE : parseConfiguredProfile(realRoot, raw);
}

export function canonicalSpecId(value) {
  return value === null || value === undefined ? "" : String(value);
}

export function isExternalLegacyActive(profile, id) {
  return profile.lifecycle.externalActiveIds.includes(canonicalSpecId(id));
}

export function statusRole(profile, status) {
  const lifecycle = profile.lifecycle;
  if (lifecycle.preReview.includes(status)) return "preReview";
  if (lifecycle.startable.includes(status)) return "startable";
  if (status === lifecycle.active) return "active";
  if (status === lifecycle.done) return "done";
  if (lifecycle.ignored.includes(status)) return "ignored";
  return "unknown";
}

export function dependencyIds(profile, frontmatter) {
  const value = frontmatter?.[profile.lifecycle.dependenciesField];
  return Array.isArray(value) ? value : [];
}

export function approvalProblems(profile, frontmatter) {
  if (profile.lifecycle.approval.mode === "decision") {
    return frontmatter?.review?.decision === "approved"
      ? []
      : [
          `review.decision=${frontmatter?.review?.decision || "null"} (need "approved")`,
        ];
  }

  const approval = profile.lifecycle.approval;
  const rawReviewers = frontmatter?.[approval.reviewersField];
  const placeholders = new Set(approval.placeholderReviewers);
  const reviewers = Array.isArray(rawReviewers)
    ? [
        ...new Set(
          rawReviewers
            .filter((value) => typeof value === "string" && value.trim())
            .map((value) => value.trim())
            .filter((value) => !placeholders.has(value))
        ),
      ]
    : [];
  const problems = [];
  if (reviewers.length < approval.minimumReviewers) {
    problems.push(
      `${approval.reviewersField} needs at least ${approval.minimumReviewers} non-placeholder reviewer(s)`
    );
  }
  const reviewedAt = frontmatter?.[approval.reviewedAtField];
  if (reviewedAt === null || reviewedAt === undefined || String(reviewedAt).trim() === "") {
    problems.push(`${approval.reviewedAtField} is required`);
  }
  return problems;
}

export function applyLifecycleWrite(profile, frontmatter, { status, now = new Date() } = {}) {
  if (status !== undefined) frontmatter.status = status;
  if (profile.lifecycle.updatedField) {
    frontmatter[profile.lifecycle.updatedField] = now.toISOString().slice(0, 10);
  }
  return frontmatter;
}
