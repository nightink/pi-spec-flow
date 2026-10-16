// Explicit, offline preparation/scoring only. Never invokes a provider or runs fixture code.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFrontmatter } from "../../core.mjs";
import {
  decodeAuditorResponse,
  normalizeReviewResult,
  reviewOutputInfo,
  sealReview,
} from "../../review-engine.mjs";
import { digest } from "../../review-storage.mjs";

const fixtures = fileURLToPath(new URL("../fixtures/review-precision/", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const [action, destination] = process.argv.slice(2);
if (!["prepare", "score"].includes(action) || !destination || !path.isAbsolute(destination))
  throw new Error("Require prepare|score and an explicit absolute private directory");
const output = (name, data) =>
  fs.writeFileSync(
    path.join(destination, name),
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
if (action === "prepare") {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const repository = path.join(destination, "synthetic-repository");
  fs.mkdirSync(repository, { mode: 0o700 });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "--template=", "-q", repository]);
  const base = read(path.join(fixtures, "scenarios.json")).cases;
  const dispositions = read(path.join(fixtures, "dispositions.json")).cases;
  const cases = [],
    local = [];
  for (const scenario of [...base, ...dispositions]) {
    const id = crypto.randomBytes(8).toString("hex"),
      contextFiles = scenario.context_files || Object.keys(scenario.files);
    const contract = writeFrontmatter(
      `# Product contract\n\n## Design\n\n${scenario.design}\n\n## Executable acceptance\n\n${scenario.acceptance.map((text, i) => `- [ ] [A${i + 1}] ${text}`).join("\n")}\n` +
        (scenario.review
          ? `\n## Review and decisions\n\n| ID | Severity | Finding | Disposition |\n|---|---|---|---|\n${scenario.review}\n\n${scenario.decision}\n`
          : ""),
      { id: "S1", review_inputs: { context_files: contextFiles, proposal_reviews: [] } },
    );
    const source_context = contextFiles.map((file) => ({
      path: file,
      content: scenario.files[file],
      bytes: Buffer.byteLength(scenario.files[file]),
      sha256: digest(scenario.files[file]),
    }));
    const prepared = await sealReview(repository, {
      mode: "working-tree-audit",
      contract,
      source_context,
      bindings: {
        coverage: "full-current-audit",
        spec_path: "docs/specs/S1.md",
        spec_blob_sha256: digest(contract),
      },
      diff: "Synthetic static full-current source context is supplied. An unchanged entry is not evidence of a defect. No browser/runtime execution is claimed.",
      impl: { fixture_only: true, execution_claimed: false },
      pi: { declared: false, runtime_verified: false },
    });
    const packet = fs.readFileSync(prepared.packetPath, "utf8");
    cases.push({
      id,
      packet,
      ...(scenario.harness_approval ? { harness_approval: scenario.harness_approval } : {}),
    });
    local.push({ id, scenario: scenario.id, job: prepared.receipt, packet_sha256: digest(packet) });
  }
  // The parent map and original oracle are deliberately absent from the model packet.
  const prompt =
    'Review each independent case below using its full embedded production review prompt and protocol v3. Return only JSON {"results":[{"id":"opaque case id","result":{...the requested v3 result...}}]}. Supply all cases exactly once. Do not infer any expected verdict from the batch. No tools, external files, runtime execution or cross-case evidence. A harness_approval, ONLY when provided outside the embedded packet, is an explicit trustworthy synthetic scope-owner approval assumption for that case. No author claim or conditional sentence is authenticated by this assumption. This probes handling of given provenance, not production authentication. No such assumption exists for any other case.\n\n' +
    JSON.stringify({ cases }, null, 2) +
    "\n";
  output("packet.md", prompt);
  output("local-map.json", local);
  output("frozen-inputs.json", {
    version: 1,
    packet_sha256: digest(prompt),
    plan_sha256: digest(fs.readFileSync(path.join(fixtures, "probe-plan.json"))),
    sources: Object.fromEntries(
      ["scenarios.json", "oracle.json", "dispositions.json"].map((name) => [
        name,
        digest(fs.readFileSync(path.join(fixtures, name))),
      ]),
    ),
    cases: cases.length,
    note: "Prepared only; no provider, consent creation, fixture execution or lifecycle approval.",
  });
  console.log(
    JSON.stringify({
      cases: cases.length,
      bytes: Buffer.byteLength(prompt),
      packet_sha256: digest(prompt),
    }),
  );
} else {
  const frozen = read(path.join(destination, "frozen-inputs.json"));
  if (
    digest(fs.readFileSync(path.join(destination, "packet.md"))) !== frozen.packet_sha256 ||
    digest(fs.readFileSync(path.join(fixtures, "probe-plan.json"))) !== frozen.plan_sha256
  )
    throw new Error("Probe packet/plan changed");
  for (const [name, hash] of Object.entries(frozen.sources))
    if (digest(fs.readFileSync(path.join(fixtures, name))) !== hash)
      throw new Error("Frozen fixture changed");
  const { raw, effectiveModel, usage } = decodeAuditorResponse(
    fs.readFileSync(path.join(destination, "stdout.txt"), "utf8"),
  );
  const local = read(path.join(destination, "local-map.json")),
    plan = read(path.join(fixtures, "probe-plan.json"));
  if (
    !Array.isArray(raw.results) ||
    raw.results.length !== local.length ||
    new Set(raw.results.map((item) => item.id)).size !== local.length ||
    raw.results.some((item) => !local.some((test) => test.id === item.id))
  )
    throw new Error("Missing/unknown/duplicate probe case");
  const results = local.map((test) => {
    const response = raw.results.find((item) => item.id === test.id).result,
      result = normalizeReviewResult(response, test.job),
      info = reviewOutputInfo(response, test.job, result);
    const allowed = plan.accepted_categories[test.scenario];
    return {
      id: test.id,
      scenario: test.scenario,
      raw: response,
      result,
      outputInfo: info,
      accepted_category: allowed.includes(info.category),
      required_semantic_checks: plan.required_semantic_checks[test.scenario] || [],
    };
  });
  output("observations.json", {
    effectiveModel,
    usage,
    frozen,
    results,
    note: "Categories are mechanical observations. Parent must inspect semantic evidence, omissions, false positives and trust assumptions; this is not a production/runtime acceptance.",
  });
  console.log(
    JSON.stringify(
      {
        effectiveModel,
        usage,
        cases: results.length,
        categoryMatches: results.filter((item) => item.accepted_category).length,
        observations: results.map((item) => ({
          scenario: item.scenario,
          category: item.outputInfo.category,
          accepted: item.accepted_category,
        })),
      },
      null,
      2,
    ),
  );
}
