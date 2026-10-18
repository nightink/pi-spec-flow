// Real CLI/provenance/lifecycle path with prescribed FAKE verdicts. No model.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSpec, writeFrontmatter } from "../../packages/core/src/core.mjs";
import { digest, reviewStore } from "../../packages/core/src/review-storage.mjs";

const core = fileURLToPath(new URL("../../packages/core/src/core.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-coverage-cli-")),
  root = path.join(tmp, "caller");
fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
const phase = path.join(root, ".git", "fixture-phase"),
  calls = path.join(root, ".git", "fixture-calls");
const env = {
  ...process.env,
  SPECFLOW_AUDIT_BIN: path.join(tmp, "fake.mjs"),
  SPECFLOW_REVIEW_BUDGET_ID: "synthetic",
  SPECFLOW_AUDIT_TIMEOUT: "30000",
};
function command(...args) {
  const out = spawnSync(process.execPath, [core, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}
const json = (commandName, input) =>
  JSON.parse(command(commandName, "--json", JSON.stringify(input)));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const budget = () =>
  JSON.parse(fs.readFileSync(path.join(reviewStore(root), "budgets/synthetic.json"))).used;
try {
  let content = writeFrontmatter(
    "# Entry refresh\n\n## Design\n\n- Actual click must return the helper's fresh value.\n\n## Executable acceptance\n\n- [ ] [A1] Helper returns fresh.\n- [ ] [A2] Actual click returns fresh through the entry.\n",
    {
      id: "S1",
      status: "approved",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: [] },
      review_inputs: { context_files: ["entry.mjs", "helper.mjs"], proposal_reviews: [] },
    },
  );
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), content);
  fs.writeFileSync(path.join(root, "entry.mjs"), "export function click() { return 'stale'; }\n");
  fs.writeFileSync(path.join(root, "helper.mjs"), "export function refresh() { return 'old'; }\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --input-type=module -e \"import {refresh} from './helper.mjs'; if (!refresh()) process.exit(1)\"",
      },
    }),
  );
  git("init", "-q");
  git("config", "user.name", "coverage-CLI-fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "baseline");
  fs.writeFileSync(
    env.SPECFLOW_AUDIT_BIN,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage,packetData} from ${JSON.stringify(new URL("../helpers/review-fixture.mjs", import.meta.url).href)};
const packet=fs.readFileSync(process.argv.at(-1).slice(1),'utf8'),data=packetData(packet),phase=fs.readFileSync(${JSON.stringify(phase)},'utf8');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
let raw=mechanicalCoverage({verdict:phase==='pass'?'pass':'fail',criteria:[{criterion:'synthetic static judgment, NOT model discovery',status:'pass',evidence:'prescribed fake fixture only'}],scope_deviations:[],out_of_scope:[],findings:[],previous_closure:[]},data);
if(phase==='proposal')raw.findings=[{id:'F1',classification:'incomplete-fix',blocking:true,file:'entry.mjs',line:1,evidence:'Prescribed synthetic proposal blocker; not an independent finding'}];
raw.previous_closure=data.review_metadata.prior_findings.map(id=>({id,status:phase==='gap'?'unverifiable':'fixed',evidence:'Prescribed fixture closure only'}));
if(phase==='gap')for(const row of raw.coverage){const unit=data.review_index.units.find(u=>u.id===row.id);if(unit.label==='A2'||unit.prior_finding_id){row.disposition='gap';row.acceptance_ids=[];row.criterion_ids=[];row.evidence='Prescribed missing entry evidence, not a model observation';}}
console.log(JSON.stringify(raw));\n`,
    { mode: 0o700 },
  );
  json("review-budget", {
    id: "synthetic",
    calls: 3,
    note: "Disposable mechanical CLI fixture; three prescribed fake outputs, no real provider authorization.",
  });
  fs.writeFileSync(phase, "proposal");
  const proposal = json("review", { mode: "proposal", id: "S1" });
  const original = json("review", { action: "run", jobId: proposal.jobId, budgetId: "synthetic" });
  assert.equal(original.outputInfo.category, "product-fail");
  const spec = findSpec(root, "S1");
  spec.frontmatter.review_inputs.proposal_reviews = [proposal.jobId];
  content = writeFrontmatter(content, spec.frontmatter);
  fs.writeFileSync(spec.path, content);
  command("begin", "S1");
  fs.writeFileSync(
    path.join(root, "helper.mjs"),
    "export function refresh() { return 'fresh'; }\n",
  );
  assert.match(command("impl", "S1"), /PASS/);
  fs.writeFileSync(phase, "gap");
  const gap = command("audit", "S1");
  assert.match(gap, /覆盖\/证据缺口/);
  assert.match(gap, /非已确认产品 FAIL/);
  const gapRecord = findSpec(root, "S1").frontmatter.audit,
    gapJob = json("review", { action: "status", jobId: gapRecord.review.job_id });
  assert.equal(gapJob.outputInfo.category, "coverage-gap");
  assert.equal(gapJob.receipt.prior_findings.length, 1);
  assert.equal(gapJob.result.coverage_summary.semantic_guarantee, false);
  assert.equal(budget(), 2);
  const denied = spawnSync(process.execPath, [core, "done", "S1"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.notEqual(denied.status, 0);
  command("audit", "S1");
  assert.equal(budget(), 2);
  console.log(
    "PASS actual CLI carries original proposal provenance and unchanged caller context; prescribed coverage gap blocks closure without false product claim or automatic respawn",
  );
  if (process.argv[2] === "--archive" && process.argv[3]) {
    fs.copyFileSync(gapJob.packetPath, process.argv[3]);
    assert.equal(digest(fs.readFileSync(process.argv[3])), gapJob.receipt.packet_sha256);
    console.log(`SYNTHETIC_PACKET_SHA256 ${gapJob.receipt.packet_sha256}`);
  }
  fs.writeFileSync(
    path.join(root, "entry.mjs"),
    "import {refresh} from './helper.mjs'; export function click() { return refresh(); }\n",
  );
  // Actual trusted fixture entry execution, separate from the fake review.
  const entry = await import(pathToFileURL(path.join(root, "entry.mjs")).href);
  assert.equal(entry.click(), "fresh");
  command("impl", "S1");
  fs.writeFileSync(phase, "pass");
  assert.match(command("audit", "S1"), /✅ PASS/);
  const record = findSpec(root, "S1").frontmatter.audit;
  assert.equal(record.review.result_protocol_version, 3);
  assert.equal(record.coverage.mechanical_complete, true);
  assert.match(command("audit", "S1"), /缓存复用/);
  assert.equal(budget(), 3);
  assert.match(command("done", "S1"), /已完成/);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\ncall\n");
  console.log(
    "PASS actual CLI new implementation rebinds v3 full audit/major closure, free cache and done; real fixture entry returns fresh, fake verdicts do not prove model semantics",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
