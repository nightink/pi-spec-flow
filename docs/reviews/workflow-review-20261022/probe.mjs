import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const corePath = path.join(root, 'packages/core/src/core.mjs');
const core = await import(pathToFileURL(corePath));
const engine = await import(pathToFileURL(path.join(root, 'packages/core/src/review-engine.mjs')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-flow-review-'));
const safeEnv = { PATH: process.env.PATH, HOME: temp, TMPDIR: os.tmpdir(), LANG: 'C', SPECFLOW_AUDIT_MAX_BYTES: '4194304' };
const results = [];
function fixture(name, gate = 0) {
  const cwd = path.join(temp, name);
  fs.mkdirSync(path.join(cwd, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs/specs/S1.md'), core.writeFrontmatter('# Test contract\n\n## Acceptance\n\n- [ ] [A1] implementation changes\n', {
    id: 'S1', status: 'approved', review: { decision: 'approved' }, evidence: { e2e: [], migrations: [], human: [] }
  }));
  fs.writeFileSync(path.join(cwd, '.spec-flow.json'), JSON.stringify({ version: 1, gates: { mode: 'replace', commands: [{ name: 'offline', argv: ['node', '-e', `process.exit(${gate})`] }] } }));
  fs.writeFileSync(path.join(cwd, 'code.txt'), 'baseline\n');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: safeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'offline-probe'); git('config', 'user.email', 'probe@example.invalid');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'offline synthetic fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit();
  return { cwd, git, commit, base, write: text => fs.writeFileSync(path.join(cwd, 'code.txt'), text) };
}
async function attempt(name, fn) {
  try { const value = await fn(); results.push({ name, outcome: 'accepted', ...value }); }
  catch (error) { results.push({ name, outcome: 'rejected', error: error.message }); }
}
const priorLimit = process.env.SPECFLOW_AUDIT_MAX_BYTES;
try {
  process.env.SPECFLOW_AUDIT_MAX_BYTES = '4194304';
  const f = fixture('large-diff');
  f.write('x'.repeat(600 * 1024) + '\n'); const head = f.commit();
  const diff = await core.buildAuditDiff(f.cwd, f.base, null);
  results.push({ name: 'working-tree diff with 4MiB env', outcome: 'accepted', diffBytes: Buffer.byteLength(diff) });
  await attempt('seal >512KiB with 4MiB env', () => engine.sealReview(f.cwd, { mode: 'committed', contract: '# Test\n', bindings: {}, diff }));
  await attempt('committed >512KiB diff with 4MiB env', () => engine.review(f.cwd, { id: 'S1', base: f.base, head }));
  const small = await engine.sealReview(f.cwd, { mode: 'committed', contract: '# Test\n', bindings: {}, diff: 'x' });
  const text = fs.readFileSync(small.packetPath, 'utf8');
  const start = text.indexOf('\n\n{') + 2;
  const data = JSON.parse(text.slice(start, text.indexOf('\n\nReturn only strict JSON:', start)));
  results.push({ name: 'minimal packet overhead', packetBytes: Buffer.byteLength(text), dataBytes: Buffer.byteLength(JSON.stringify(data, null, 2)), contractBytes: Buffer.byteLength(data.contract) });
  for (const value of ['invalid', '0', '-1', '524288junk']) {
    process.env.SPECFLOW_AUDIT_MAX_BYTES = value;
    await attempt(`seal invalid env=${value}`, async () => { const r = await engine.sealReview(f.cwd, { mode: 'committed', contract: '# Test\n', bindings: {}, diff: 'x' }); return { packetBytes: r.receipt.packet_bytes }; });
  }
  process.env.SPECFLOW_AUDIT_MAX_BYTES = '4194304';
  const lines = fixture('line-heavy'); lines.write('hello\n'.repeat(67000)); const lh = lines.commit();
  const ld = await core.buildAuditDiff(lines.cwd, lines.base, null);
  results.push({ name: 'line-heavy raw diff', diffBytes: Buffer.byteLength(ld) });
  await attempt('line-heavy committed prepare', async () => { const r = await engine.review(lines.cwd, { id: 'S1', base: lines.base, head: lh }); return { packetBytes: r.receipt.packet_bytes }; });
  await attempt('contract plus index duplication within allowed source size', () => engine.sealReview(f.cwd, { mode: 'committed', contract: '# Contract\n\n' + 'c'.repeat(240 * 1024) + '\n', bindings: {}, diff: 'd'.repeat(40 * 1024) }));
  const failing = fixture('failing-gate', 7);
  const cli = (f, args) => spawnSync(process.execPath, [corePath, ...args], { cwd: f.cwd, env: safeEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli(failing, ['begin', 'S1']).status, 0);
  failing.write('changed\n');
  const failed = cli(failing, ['impl', 'S1']);
  results.push({ name: 'CLI impl failed gate', exitCode: failed.status, reportsFail: failed.stdout.includes('FAIL'), storedPass: core.findSpec(failing.cwd, 'S1').frontmatter.impl.pass });
  const auditFail = fixture('oversize-audit');
  assert.equal(cli(auditFail, ['begin', 'S1']).status, 0);
  auditFail.write('x'.repeat(600 * 1024) + '\n');
  assert.equal(cli(auditFail, ['impl', 'S1']).status, 0);
  assert.equal(core.findSpec(auditFail.cwd, 'S1').frontmatter.impl.pass, true);
  const af = cli(auditFail, ['audit', 'S1']);
  results.push({ name: 'CLI audit oversize preflight', exitCode: af.status, verdict: core.findSpec(auditFail.cwd, 'S1').frontmatter.audit.verdict, category: core.findSpec(auditFail.cwd, 'S1').frontmatter.audit.output_info?.category, reportsOversize: af.stdout.includes('exceeds limit'), budgetCreated: fs.existsSync(path.join(auditFail.cwd, '.git/spec-flow/review-v1/budgets')) });
  results.push({ name: 'native board core output', board: core.board(auditFail.cwd), nextStep: await core.nextStep(auditFail.cwd, core.findSpec(auditFail.cwd, 'S1')) });
  const stateBefore = fs.readFileSync(path.join(auditFail.cwd, 'docs/specs/S1.md'), 'utf8');
  await attempt('ordinary prepare cannot prepare lifecycle mode', () => engine.review(auditFail.cwd, { action: 'prepare', mode: 'working-tree-audit', id: 'S1' }));
  assert.equal(fs.readFileSync(path.join(auditFail.cwd, 'docs/specs/S1.md'), 'utf8'), stateBefore);
  const adapter = await import(pathToFileURL(path.join(root, 'packages/pi/adapter-core.mjs')));
  const verbose = await engine.sealReview(f.cwd, { mode: 'proposal', contract: '# Test\n\n' + 'c'.repeat(20000), bindings: {}, diff: '' });
  const fullText = JSON.stringify(verbose, null, 2);
  const modelText = adapter.truncateToolText(fullText);
  results.push({ name: 'native text projection of verbose receipt', fullCharacters: fullText.length, visibleCharacters: modelText.length, includesJobId: modelText.includes(verbose.jobId), includesPacketPath: modelText.includes(verbose.packetPath), fullReceiptContainsPacketPath: fullText.includes(verbose.packetPath) });
  const orphan = fixture('orphan-worktree');
  const linked = path.join(temp, 'orphan-member');
  orphan.git('worktree', 'add', '--detach', linked);
  fs.rmSync(path.join(linked, '.git'));
  await attempt('newSpec with prunable sibling worktree', () => core.newSpec(orphan.cwd, { title: 'Test', prefix: 'S' }));
  const preview = await core.newSpec(orphan.cwd, { title: 'Test', prefix: 'S', dryRun: true });
  results.push({ name: 'dryRun with prunable sibling worktree', dryRun: preview.dryRun, status: preview.status });
  const result = name => results.find(item => item.name === name);
  assert.equal(result('seal >512KiB with 4MiB env').outcome, 'rejected');
  assert.equal(result('committed >512KiB diff with 4MiB env').outcome, 'rejected');
  assert.equal(result('line-heavy committed prepare').outcome, 'rejected');
  assert.equal(result('CLI impl failed gate').exitCode, 0);
  assert.equal(result('CLI audit oversize preflight').exitCode, 0);
  assert.equal(result('native text projection of verbose receipt').includesPacketPath, false);
  assert.equal(result('newSpec with prunable sibling worktree').outcome, 'rejected');
  console.log(JSON.stringify({ node: process.version, providerCalls: 0, fixtures: 'synthetic temporary repositories; removed on exit', results }, null, 2));
} finally {
  if (priorLimit === undefined) delete process.env.SPECFLOW_AUDIT_MAX_BYTES; else process.env.SPECFLOW_AUDIT_MAX_BYTES = priorLimit;
  fs.rmSync(temp, { recursive: true, force: true });
}
