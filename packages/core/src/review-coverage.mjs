// Structural coverage, not a natural-language theorem prover. Every body block
// is indexed; a reviewer must justify its semantics instead of silently omitting it.
import { contextError, resolveContextLimits } from "./review-context.mjs";
import { digest } from "./review-storage.mjs";
export const REVIEW_INDEX_VERSION = 1;
export const MAX_REVIEW_UNITS = 400;
const acceptanceHeadings = new Set([
  "acceptance",
  "executable acceptance",
  "acceptance criteria",
  "验收",
  "验收标准",
  "可执行验收",
]);
const nonblank = (value, max = 10000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const listLine = (line) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
const tableLine = (line) => /^\s*\|.*\|\s*$/.test(line);
const tableRule = (line) => /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
const fenceLine = (line) => /^ {0,3}(`{3,}|~{3,})/.exec(line);

export function buildReviewIndex(content, prior = []) {
  if (typeof content !== "string") throw new Error("Review contract must be text");
  const lines = content.replace(/\r\n/g, "\n").split("\n"),
    units = [],
    headings = [];
  let cursor = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) throw new Error("Unclosed contract frontmatter");
    cursor = end + 1;
  }
  const add = (start, end, fenced = false) => {
    const text = lines.slice(start, end + 1).join("\n"),
      section = headings.filter(Boolean).join(" / ");
    const acceptance =
      !fenced &&
      (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+/.test(text) ||
        (listLine(text) && headings.some((h) => acceptanceHeadings.has(h?.toLowerCase()))));
    const finding =
      !fenced &&
      tableLine(text) &&
      headings.some((h) => /review|评审|决策|处置/i.test(h || "")) &&
      /(?:^|\|)\s*(?:major|blocking|严重|阻断)\s*(?:\||$)/i.test(text);
    const label = acceptance
      ? text.match(
          /^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?\[([A-Za-z][A-Za-z0-9._-]{0,79})\]/,
        )?.[1]
      : undefined;
    units.push({
      id: `S${units.length + 1}`,
      kind: acceptance ? "acceptance" : finding ? "review-finding" : "source",
      line: start + 1,
      end_line: end + 1,
      section,
      text,
      sha256: digest(text),
      ...(label ? { label } : {}),
    });
    if (units.length > MAX_REVIEW_UNITS)
      throw new Error(`Review source index exceeds ${MAX_REVIEW_UNITS} unit limit; no truncation`);
  };
  while (cursor < lines.length) {
    const line = lines[cursor],
      heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      headings.length = heading[1].length;
      headings[heading[1].length - 1] = heading[2];
      add(cursor, cursor, true);
      cursor++;
      continue;
    }
    if (
      !line.trim() ||
      /^- 状态：/.test(line) ||
      /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
      tableRule(line)
    ) {
      cursor++;
      continue;
    }
    const start = cursor,
      fence = fenceLine(line);
    if (fence) {
      cursor++;
      while (
        cursor < lines.length &&
        !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[cursor])
      )
        cursor++;
      if (cursor >= lines.length) throw new Error("Unclosed fenced block in review contract");
      add(start, cursor++, true);
      continue;
    }
    cursor++;
    if (!tableLine(line)) {
      while (
        cursor < lines.length &&
        lines[cursor].trim() &&
        !/^ {0,3}#{1,6}\s/.test(lines[cursor]) &&
        !listLine(lines[cursor]) &&
        !tableLine(lines[cursor]) &&
        !fenceLine(lines[cursor])
      )
        cursor++;
    }
    add(start, cursor - 1);
  }
  for (const item of prior) {
    if (!nonblank(item.id, 200) || !nonblank(item.evidence, 12000))
      throw new Error("Invalid bound prior finding");
    const text = item.evidence;
    units.push({
      id: `H${units.length + 1}`,
      kind: "review-finding",
      line: 0,
      end_line: 0,
      section: "Bound prior review (not proposal approval)",
      text,
      sha256: digest(text),
      prior_finding_id: item.id,
      review_job_id: item.review_job_id,
      original_id: item.original_id,
    });
    if (units.length > MAX_REVIEW_UNITS)
      throw new Error(`Review source index exceeds ${MAX_REVIEW_UNITS} unit limit; no truncation`);
  }
  return {
    version: REVIEW_INDEX_VERSION,
    contract_sha256: digest(content),
    units,
    acceptance_ids: units.filter((u) => u.kind === "acceptance").map((u) => u.id),
  };
}

export function reviewInputs(frontmatter) {
  const input = frontmatter?.review_inputs;
  if (input === undefined) return { context_files: [], proposal_reviews: [] };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["context_files", "proposal_reviews", "context_limits"].includes(k),
    )
  )
    throw new Error("Invalid review_inputs contract fields");
  const files = input.context_files ?? [],
    jobs = input.proposal_reviews ?? [];
  const limits = resolveContextLimits(input.context_limits);
  if (!Array.isArray(files) || files.some((f) => !nonblank(f, 1024)))
    throw contextError(
      "REVIEW_CONTEXT_FILES",
      "context_files must be an array of nonempty paths (<=1024 characters each)",
    );
  if (files.length > limits.max_files || new Set(files).size !== files.length)
    throw contextError(
      "REVIEW_CONTEXT_COUNT",
      `Context sources: ${files.length} files (${new Set(files).size} unique), max ${limits.max_files} unique files; exceeds by ${Math.max(0, files.length - limits.max_files)}; duplicates are forbidden`,
      {
        actual: files.length,
        unique: new Set(files).size,
        limit: limits.max_files,
        excess: Math.max(0, files.length - limits.max_files),
      },
    );
  if (
    !Array.isArray(jobs) ||
    jobs.length > 5 ||
    new Set(jobs).size !== jobs.length ||
    jobs.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
  )
    throw new Error("Invalid proposal_reviews (max 5 unique job IDs)");
  for (const file of files) {
    if (
      file.startsWith("/") ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsafe paths, not source contents
      /[\x00-\x1f\\]/.test(file) ||
      file.split("/").some((p) => !p || p === "." || p === "..") ||
      /(?:^|\/)(?:\.git|\.ssh|\.aws)(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|id_rsa|id_ed25519)(?:\/|$)/i.test(
        file,
      )
    )
      throw new Error("Unsafe review context source path");
  }
  return { context_files: files, proposal_reviews: jobs };
}

export function coverageAssessment(raw, job) {
  const errors = [],
    gaps = [],
    index = job.coverage_index;
  if (
    !index ||
    index.version !== REVIEW_INDEX_VERSION ||
    !Array.isArray(index.units) ||
    index.units.length > MAX_REVIEW_UNITS ||
    !Array.isArray(index.acceptance_ids) ||
    digest(JSON.stringify(index)) !== job.bindings?.review_index_sha256
  ) {
    return { errors: ["Missing/invalid sealed review index binding"], gaps, summary: null };
  }
  const units = new Map(index.units.map((u) => [u.id, u])),
    acceptance = new Set(index.acceptance_ids),
    criteria = new Map();
  if (
    units.size !== index.units.length ||
    JSON.stringify(index.acceptance_ids) !==
      JSON.stringify(index.units.filter((u) => u.kind === "acceptance").map((u) => u.id)) ||
    index.units.some(
      (u) =>
        !nonblank(u.id, 100) ||
        !["source", "acceptance", "review-finding"].includes(u.kind) ||
        !nonblank(u.text, 256 * 1024) ||
        digest(u.text) !== u.sha256,
    )
  )
    errors.push("Invalid sealed review index identities");
  const indexedPrior = index.units
    .filter((u) => u.prior_finding_id)
    .map((u) => u.prior_finding_id)
    .sort();
  if (JSON.stringify(indexedPrior) !== JSON.stringify([...(job.prior_findings || [])].sort()))
    errors.push("Prior finding set differs from sealed source inventory");
  for (const item of Array.isArray(raw?.criteria) ? raw.criteria : []) {
    if (!nonblank(item?.id, 100) || criteria.has(item.id))
      errors.push("criteria requires unique nonempty IDs");
    else criteria.set(item.id, item);
  }
  const rows = raw?.coverage;
  if (!Array.isArray(rows) || rows.length > MAX_REVIEW_UNITS)
    errors.push(`coverage requires a bounded array (max ${MAX_REVIEW_UNITS})`);
  const seen = new Set(),
    counts = { covered: 0, context: 0, deferred: 0, gap: 0, rejected: 0, withdrawn: 0 };
  const refs = (value, valid, label) => {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      new Set(value).size !== value.length ||
      value.some((id) => !nonblank(id, 200) || !valid.has(id))
    ) {
      errors.push(`Invalid ${label} reference list`);
      return [];
    }
    return value;
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !units.has(row.id) || seen.has(row.id)) {
      errors.push("Unknown/duplicate coverage source ID");
      continue;
    }
    seen.add(row.id);
    if (
      Object.keys(row).some(
        (k) =>
          ![
            "id",
            "disposition",
            "acceptance_ids",
            "criterion_ids",
            "evidence",
            "reason",
            "decision_ids",
          ].includes(k),
      ) ||
      !Object.hasOwn(counts, row.disposition) ||
      !nonblank(row.evidence) ||
      (Object.hasOwn(row, "reason") &&
        (row.disposition !== "deferred" || !nonblank(row.reason, 100))) ||
      (Object.hasOwn(row, "decision_ids") && !["rejected", "withdrawn"].includes(row.disposition))
    ) {
      errors.push(`Invalid coverage row ${row.id}`);
      continue;
    }
    counts[row.disposition]++;
    const unit = units.get(row.id),
      a = refs(row.acceptance_ids, acceptance, "acceptance"),
      c = refs(row.criterion_ids, criteria, "criterion");
    if (row.disposition === "context") {
      if (unit.kind !== "source" || a.length || c.length)
        errors.push(`Acceptance/major cannot disappear as context (${row.id})`);
    } else if (row.disposition === "gap") {
      gaps.push(`${row.id}: ${row.evidence}`);
    } else if (["rejected", "withdrawn"].includes(row.disposition)) {
      const decisions = refs(row.decision_ids, units, "decision");
      if (!decisions.length || decisions.includes(row.id) || !c.length)
        errors.push(
          `Withdrawal/rejection needs distinct decision and static criterion (${row.id})`,
        );
    } else {
      const outsideDelta =
        row.disposition === "deferred" &&
        row.reason === "reviewed-coverage" &&
        unit.kind !== "review-finding" &&
        ["incremental", "committed"].includes(job.mode);
      if (
        !outsideDelta &&
        (!a.length || !c.length || (unit.kind === "acceptance" && !a.includes(row.id)))
      )
        errors.push(`Missing acceptance/criterion linkage (${row.id})`);
      if (row.disposition === "deferred") {
        if (
          ![
            "runtime",
            "remote",
            "cross-repository",
            "attestation-deferred",
            "reviewed-coverage",
          ].includes(row.reason) ||
          (row.reason === "reviewed-coverage" && !outsideDelta) ||
          !(
            Array.isArray(raw.out_of_scope) &&
            raw.out_of_scope.some(
              (note) => typeof note === "string" && note.includes(`[${row.id}]`),
            )
          )
        )
          errors.push(`Deferred source needs permitted reason and visible [ID] note (${row.id})`);
      }
    }
    if (unit.prior_finding_id) {
      const closure = Array.isArray(raw.previous_closure)
        ? raw.previous_closure.find((item) => item?.id === unit.prior_finding_id)
        : null;
      const expected = ["covered", "deferred"].includes(row.disposition)
        ? "fixed"
        : row.disposition;
      if (
        !closure ||
        (row.disposition === "gap"
          ? !["not-fixed", "unverifiable"].includes(closure.status)
          : closure.status !== expected)
      )
        errors.push(`Bound prior closure and coverage disagree (${row.id})`);
    }
  }
  for (const id of units.keys()) if (!seen.has(id)) errors.push(`Missing coverage source ${id}`);
  for (const criterion of criteria.values()) {
    if (
      job.prompt_version >= 7 &&
      criterion.kind === "evidence" &&
      criterion.status !== "pass" &&
      !(
        Array.isArray(rows) &&
        rows.some(
          (row) =>
            row?.disposition === "gap" &&
            Array.isArray(row.criterion_ids) &&
            row.criterion_ids.includes(criterion.id),
        )
      )
    ) {
      errors.push(`Nonpassing evidence criterion needs visible gap linkage (${criterion.id})`);
    }
  }
  if (!acceptance.size)
    gaps.push("No executable acceptance inventory; cannot prove contract coverage");
  return {
    errors: [...new Set(errors)],
    gaps,
    summary: {
      version: 1,
      index_sha256: job.bindings.review_index_sha256,
      source_units: units.size,
      accounted_units: seen.size,
      acceptance_units: acceptance.size,
      covered_units: counts.covered,
      context_units: counts.context,
      deferred_units: counts.deferred,
      gap_units: counts.gap,
      decision_units: counts.rejected + counts.withdrawn,
      mechanical_complete: errors.length === 0 && gaps.length === 0,
      semantic_guarantee: false,
      scope: job.bindings?.coverage || job.mode,
    },
  };
}

export const COVERAGE_PROMPT = `Coverage protocol v3 (in addition to the existing result fields): every criterion MUST have a unique nonempty id such as C1 and explicit kind=product|evidence. product judges actual implementation under a resolved requirement; evidence judges missing/ambiguous coverage, caller context, contract consistency, approval or recorded-evidence availability/binding. A failed evidence criterion needs a gap row referencing it, not a product finding. Keep real static defects in separate product criteria even when a gap also exists. Return coverage:[{id:"source ID from review_index",disposition:"covered|context|deferred|gap|rejected|withdrawn",acceptance_ids:["actual acceptance source IDs"],criterion_ids:["C1"],evidence:"precise source/evidence",reason:"only for deferred",decision_ids:["only for rejected/withdrawn"]}]. Omit optional reason/decision_ids when inapplicable. Every review_index unit MUST occur exactly once; do not invent IDs. All reference arrays are unique, <=100 entries; coverage <=400; evidence nonblank <=10000 chars. The index inventories text, NOT a claim that every block is normative or semantically covered.\nFirst reconcile each source with the user's outcome, Design, acceptance and review dispositions; only then judge fulfillment. Design promises bind even when missing from checkboxes. covered requires semantically matching executable acceptance and criterion references, not keyword overlap. Every acceptance maps to itself and a criterion, except an explicitly allowed reviewed-coverage deferral outside delta bindings. context needs a concrete non-normative reason and empty reference arrays; acceptance and major/blocking units cannot be context. A missing acceptance, missing caller context, contradictory metric definition or unresolved scope is gap, NOT proof of a product defect. Any gap prevents PASS. Never silently narrow a compound assertion to the fields the implementation happens to satisfy. Examine units, boundaries, counterexamples and aggregation semantics; sum of parallel spans may legitimately exceed a day. Do not invent numeric invariants.\nFor covered major/blocking dispositions, verify actual acceptance plus fix/test evidence, not the author's 'written into Design'. Only IDs explicitly listed in review_metadata.prior_findings (also represented by an index prior_finding_id) additionally need previous_closure with fixed|not-fixed|unverifiable|rejected|withdrawn. If prior_findings is empty, previous_closure MUST be []. Author review-table labels such as F1 and IDs of newly emitted findings are NOT bound prior IDs: evaluate their S-source rows through coverage/criteria without enrolling them into previous_closure. Never copy a body-table ID or an external approval number into previous_closure. Rejected/withdrawn require distinct decision_ids and criterion_ids verifying the cited rebuttal/decision evidence. Factual rejection is NOT scope withdrawal: independently verified static counterevidence may refute a false finding premise without human approval, including a conditional author rebuttal whose factual condition the reviewer can verify from bound code. Cite that distinct rebuttal and a static criterion; do not manufacture a fix or demand consent to acknowledge a disproved premise. Only withdrawing/waiving a REAL requirement requires actual scope-owner approval; never authenticate author consent claims or treat a new model opinion as that approval. decision_ids MUST be other actual review_index unit IDs (S/H IDs), never external approval numbers such as APR-1. External approval numbers belong in evidence text. A decision/approval record that substantiates withdrawal is evidence, NOT another requirement to withdraw: account for its own purely evidentiary source row as context with empty reference arrays rather than recursively withdrawing the decision or inventing an external decision source. Contract author summaries are not bound independent reports. Proposal mode evaluates plan/verifiability, never future implementation.\nA deferred row requires reason runtime|remote|cross-repository|attestation-deferred and references to the static recorded-evidence criterion and acceptance; name its residual fact in out_of_scope using [source ID]. Only committed/incremental coverage may use reason reviewed-coverage for an acceptance outside its exact bindings, with a [source ID] note; this is not full delivery coverage. Do not launder a static wiring defect into runtime deferral. Source_context includes explicitly selected current/head files, including unchanged callers: unchanged does not mean unimplemented. Distinguish helper capability, actual caller connection, test existence and runtime execution. Static PASS is not runtime PASS or completed delivery.\n`;
