// TEST-ONLY wire fixtures. This deliberately supplies synthetic associations for
// plumbing tests, NOT a reviewer, semantic oracle, or model-comprehension test.
// Never import from production code or use this to repair real audit output.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function seedLegacyReviewFixture(dir, job) {
  // A genuine legacy precondition has neither coverage metadata nor a v3 packet.
  // Only disposable fake fixtures may be reseeded; never mutate a retained real job.
  const data = packetData(fs.readFileSync(path.join(dir, "packet.md"), "utf8"));
  delete job.result_protocol_version;
  delete job.prompt_version;
  delete job.coverage_index;
  for (const key of ["review_index_sha256", "source_context_sha256", "review_history_sha256"])
    delete job.bindings[key];
  for (const key of ["review_index", "source_context", "review_history", "review_metadata"])
    delete data[key];
  data.bindings = job.bindings;
  const packet =
    "TEST-ONLY synthetic pre-coverage packet, not a real provider prompt.\n\n" +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.writeFileSync(path.join(dir, "packet.md"), packet, { mode: 0o600 });
  job.packet_sha256 = crypto.createHash("sha256").update(packet).digest("hex");
  job.packet_bytes = Buffer.byteLength(packet);
  job.scan = { ...job.scan, packet_sha256: job.packet_sha256 };
}
export function packetData(packet) {
  const start = packet.indexOf("\n\n{") + 2;
  return JSON.parse(packet.slice(start, packet.indexOf("\n\nReturn only strict JSON:", start)));
}
export function mechanicalCoverage(raw, packet) {
  const data = typeof packet === "string" ? packetData(packet) : packet;
  if (!data.review_index) return raw;
  const result = structuredClone(raw);
  if (Array.isArray(result.criteria))
    result.criteria = result.criteria.map((item, i) =>
      item && typeof item === "object"
        ? { ...item, id: item.id ?? `C${i + 1}`, kind: item.kind ?? "product" }
        : item,
    );
  if (!Object.hasOwn(result, "coverage")) {
    const acceptance = data.review_index.acceptance_ids,
      criterion = result.criteria?.[0]?.id;
    result.coverage = data.review_index.units.map((unit) => ({
      id: unit.id,
      disposition: unit.kind === "source" ? "context" : "covered",
      acceptance_ids:
        unit.kind === "source"
          ? []
          : unit.kind === "acceptance"
            ? [unit.id]
            : acceptance.slice(0, 1),
      criterion_ids: unit.kind === "source" || !criterion ? [] : [criterion],
      evidence: "Synthetic fixture association for executor tests only; not semantic evidence",
    }));
  }
  return result;
}
