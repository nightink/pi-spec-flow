import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkCI } from "./core.mjs";
import { loadProjectProfile } from "./project-profile.mjs";

const CLI = fileURLToPath(new URL("./core.mjs", import.meta.url));
const RULES = {
  requiredFields: ["id", "title", "kind", "status", "created", "updated", "author", "depends_on"],
  kindField: "kind", allowedKinds: ["spec", "plan", "analysis"],
  numericFileId: true, checkDoneCheckboxes: true,
  forbidAddendumFilename: true, dependencyIntegrity: true,
};
const PROFILE = {
  version: 1,
  lifecycle: {
    preReview: ["draft", "in-review"], startable: ["approved"], active: "in-progress",
    done: "done", ignored: ["archived"], dependenciesField: "depends_on",
    updatedField: "updated", bodyStatusLine: false,
    legacyActive: "external-warning", externalActiveIds: [2],
    approval: { reviewersField: "reviewers", reviewedAtField: "reviewed_at",
      minimumReviewers: 1, placeholderReviewers: ["pending"] },
  },
  gates: { mode: "replace", npmScripts: ["verify"] },
  validation: RULES,
};
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-contract-check-"));
  fs.mkdirSync(path.join(root, "specs"));
  fs.writeFileSync(path.join(root, ".spec-flow.json"), JSON.stringify(PROFILE));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { verify: "node verify.mjs" } }));
  fs.writeFileSync(path.join(root, "verify.mjs"), "import fs from 'node:fs';fs.writeFileSync('gate-ran','yes');console.log('gate passed');\n");
  spec(root, 0, "done", [], "- [x] initial\n");
  spec(root, 2, "in-progress", [0], "- [ ] pending\n");
  spec(root, 3, "archived", [0], "archive\n");
  return root;
}
function spec(root, id, status, deps, body, name = `${id}.example.md`) {
  fs.writeFileSync(path.join(root, "specs", name),
    `---\nid: ${id}\ntitle: Item ${id}\nkind: spec\nstatus: ${status}\ncreated: '2026-09-26'\nupdated: '2026-09-26'\nauthor: agent\ndepends_on: [${deps.join(", ")}]\n---\n\n# Item ${id}\n\n${body}`);
}
function mutate(root, filename, before, after) {
  const file = path.join(root, "specs", filename);
  const old = fs.readFileSync(file, "utf8");
  assert.ok(old.includes(before));
  fs.writeFileSync(file, old.replace(before, after));
}

// Opt-in must not make any pre-existing project's validation stricter.
test("without validation profile, project contract rules remain disabled", async () => {
  const root = makeProject();
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(root, ".spec-flow.json")));
    delete profile.validation;
    fs.writeFileSync(path.join(root, ".spec-flow.json"), JSON.stringify(profile));
    mutate(root, "0.example.md", "- [x] initial", "- [ ] initial");
    const result = await checkCI(root, { runProjectGates: false });
    assert.equal(result.pass, true, result.output);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("configured contract checker enforces parity across done/legacy/archived", async () => {
  const root = makeProject();
  try {
    let result = await checkCI(root, { runProjectGates: false });
    assert.equal(result.pass, true, result.output);
    assert.match(result.output, /项目 npm 门禁未运行/);
    assert.equal(fs.existsSync(path.join(root, "gate-ran")), false);
    mutate(root, "0.example.md", "- [x] initial", "- [ ] initial");
    mutate(root, "2.example.md", "kind: spec", "kind: wrong");
    mutate(root, "3.example.md", "title: Item 3", "title: ''");
    result = await checkCI(root, { runProjectGates: false });
    assert.equal(result.pass, false);
    assert.match(result.output, /0: status=done 但仍有未勾验收项/);
    assert.match(result.output, /2: 非法 kind/);
    assert.match(result.output, /3: 缺字段 title/);
    assert.equal(fs.existsSync(path.join(root, "gate-ran")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("numeric ID, filename, missing dependency, arbitrary cycle and addendum fail closed", async () => {
  const root = makeProject();
  try {
    spec(root, 4, "draft", [5], "new\n", "4.addendum.md");
    spec(root, 5, "draft", [6], "new\n");
    spec(root, 6, "draft", [4, 777], "new\n");
    mutate(root, "3.example.md", "id: 3", "id: 99");
    const result = await checkCI(root, { runProjectGates: false });
    assert.equal(result.pass, false);
    assert.match(result.output, /id=99 与文件名前缀不符/);
    assert.match(result.output, /addendum 文件禁止/);
    assert.match(result.output, /引用了不存在的 id 777/);
    assert.match(result.output, /依赖循环: 4 → 5 → 6 → 4/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("strict validation schema rejects unknown keys and unsafe required fields", () => {
  const root = makeProject();
  try {
    const file = path.join(root, ".spec-flow.json");
    const data = JSON.parse(fs.readFileSync(file));
    data.validation.surprise = true;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => loadProjectProfile(root), /unknown key: surprise/);
    delete data.validation.surprise;
    data.validation.requiredFields = ["__proto__"];
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => loadProjectProfile(root), /unsafe field name/);
    data.validation.requiredFields = ["id"];
    data.validation.dependencyIntegrity = "yes";
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => loadProjectProfile(root), /must be boolean/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI contracts-only does not execute gates; full CI does; unknown flags fail", () => {
  const root = makeProject();
  try {
    const run = (...flags) => execFileSync(process.execPath, [CLI, "check", ...flags], { cwd: root, encoding: "utf8" });
    assert.match(run("--ci", "--contracts-only"), /项目 npm 门禁未运行/);
    assert.equal(fs.existsSync(path.join(root, "gate-ran")), false);
    assert.match(run("--ci"), /check --ci 通过/);
    assert.equal(fs.readFileSync(path.join(root, "gate-ran"), "utf8"), "yes");
    assert.throws(() => run("--ci", "--typo"), /Command failed/);
    mutate(root, "0.example.md", "- [x] initial", "- [ ] initial");
    assert.throws(() => run("--ci", "--contracts-only"), /Command failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
