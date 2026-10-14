import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { auditTarget, renderAuditMarkdown } from '../src/audit.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

function gen(name, overrides = {}) {
  const plan = buildPlan(validateConfig(baseConfig(overrides)));
  const out = path.join(tmp, name);
  generateToDir({ plan, outDir: out, confirmDigest: plan.digest });
  return out;
}
function cats(report) {
  return report.findings.map((f) => f.category);
}
function append(file, text) {
  fs.writeFileSync(file, readText(file) + text, 'utf8');
}

test('生成直後の出力は検出なし', () => {
  const dir = gen('clean');
  const r = auditTarget(dir);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.proposals, []);
});

test('参照切れ: 存在しないローカル md リンクを検出、外部 URL は追わない', () => {
  const dir = gen('links');
  append(path.join(dir, 'PROJECT.md'), '\n[設計](docs/design.md) [公式](https://example.com/x) [外](../outside.md)\n');
  const r = auditTarget(dir);
  const broken = r.findings.filter((f) => f.category === 'broken-link');
  assert.equal(broken.length, 1);
  assert.equal(broken[0].file, 'PROJECT.md');
  assert.ok(broken[0].line > 0);
  assert.ok(r.skipped.some((s) => /外部/.test(s.reason)));
  assert.ok(r.skipped.some((s) => /対象外/.test(s.reason)));
});

test('明示されたローカル md リンクは 1 段階読み、その先のリンク切れも検出', () => {
  const dir = gen('linked');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# notes\nメモ\n[deeper](deep.md)\n', 'utf8');
  append(path.join(dir, 'PROJECT.md'), '\n[notes](docs/notes.md)\n');
  const r = auditTarget(dir);
  assert.ok(r.scanned.includes(path.join('docs', 'notes.md')));
  assert.ok(r.findings.some((f) => f.category === 'broken-link' && /deep\.md/.test(f.evidence)));
});

test('役割矛盾: 入口の役割が WORKFLOW と食い違う', () => {
  const dir = gen('roles');
  const claude = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claude, readText(claude).replace('- 役割: 実装', '- 役割: 主導・レビュー'), 'utf8');
  const r = auditTarget(dir);
  const rc = r.findings.filter((f) => f.category === 'role-contradiction');
  assert.equal(rc.length, 1);
  assert.equal(rc[0].file, 'CLAUDE.md');
  assert.ok(r.findings.some((f) => f.category === 'manifest-changed' && f.file === 'CLAUDE.md'));
  assert.ok(r.proposals.some((p) => p.file === 'CLAUDE.md' && /役割: 実装/.test(p.diff)));
  assert.equal(readText(claude).includes('- 役割: 主導・レビュー'), true, '監査が apply していない');
});

test('入口が正本 (WORKFLOW.md) を参照しないと検出', () => {
  const dir = gen('noref');
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, readText(agents).replace(/WORKFLOW\.md/g, 'RULES.md'), 'utf8');
  const r = auditTarget(dir);
  assert.ok(cats(r).includes('entry-missing-reference'));
});

test('[x] なのに未確認 / 証跡なし を行つきで検出', () => {
  const dir = gen('tasks');
  append(path.join(dir, 'TASKS.md'), '\n- [x] 完了したが未確認\n- [x] 根拠を書かずに完了\n- [x] 正しい完了 証跡: test/log.txt\n');
  const r = auditTarget(dir);
  const unv = r.findings.filter((f) => f.category === 'done-but-unverified');
  const noev = r.findings.filter((f) => f.category === 'done-without-evidence');
  assert.equal(unv.length, 1);
  assert.equal(noev.length, 1);
  assert.ok(unv[0].line > 0 && noev[0].line === unv[0].line + 1);
});

test('秘密らしい記述は検出するが値を出さない (レポート全体)', () => {
  const dir = gen('redact-check');
  const secret = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  append(path.join(dir, 'VALIDATION.md'), `\ntoken: ${secret}\n`);
  const r = auditTarget(dir);
  const s = r.findings.filter((f) => f.category === 'secret-like');
  assert.ok(s.length >= 1);
  assert.equal(s[0].file, 'VALIDATION.md');
  const md = renderAuditMarkdown(r);
  assert.ok(!md.includes(secret));
  assert.ok(!JSON.stringify(r).includes(secret));
});

test('意図的ルール変更: 設定を変えた場合は「判断要/意図確認」で、違反扱いも復元もしない', () => {
  const dir = gen('intent');
  const cfgPath = path.join(dir, 'setup.config.json');
  const cfg = JSON.parse(readText(cfgPath));
  cfg.mode = 'claude-led';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const wfBefore = readText(path.join(dir, 'WORKFLOW.md'));
  const r = auditTarget(dir, { unattended: true });
  const mm = r.findings.filter((f) => f.category === 'config-mismatch');
  assert.equal(mm.length, 1);
  assert.equal(mm[0].severity, 'info');
  assert.ok(/再生成/.test(mm[0].note));
  assert.ok(r.needsConfirmation.length >= 1);
  assert.ok(r.proposals.some((p) => p.file === 'WORKFLOW.md'));
  assert.equal(readText(path.join(dir, 'WORKFLOW.md')), wfBefore, '監査が復元/変更した');
  assert.ok(!cats(r).includes('role-contradiction'), '入口と WORKFLOW は整合しているので矛盾ではない');
});

test('manifest の差分は変更=違反ではない (info) で、作業文書の更新は通常運用', () => {
  const dir = gen('manifest');
  append(path.join(dir, 'TASKS.md'), '\n- [ ] 追加課題\n');
  const r = auditTarget(dir);
  const mc = r.findings.filter((f) => f.category === 'manifest-changed');
  assert.equal(mc.length, 1);
  assert.equal(mc[0].severity, 'info');
  assert.equal(mc[0].file, 'TASKS.md');
});

test('.env や鍵、node_modules は読まず、リンク先でも追わない', () => {
  const dir = gen('deny');
  const secret = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  fs.writeFileSync(path.join(dir, '.env'), `AWS=${secret}\n`, 'utf8');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.md'), `${secret}`, 'utf8');
  fs.writeFileSync(path.join(dir, 'server.key'), secret, 'utf8');
  append(path.join(dir, 'PROJECT.md'), '\n[env](.env) [dep](node_modules/x.md) [key](server.key)\n');
  const r = auditTarget(dir);
  assert.ok(!r.scanned.some((n) => /\.env|node_modules|server\.key/.test(n)));
  assert.equal(r.skipped.filter((s) => /秘密\/認証\/依存/.test(s.reason)).length, 3);
  assert.ok(!JSON.stringify(r).includes(secret));
});

test('単独モードで存在しない担当への言及を検出', () => {
  const dir = gen('solo', { mode: 'claude-solo', handoff: undefined });
  append(path.join(dir, 'TASKS.md'), '\n- [ ] Codex のレビューを待つ\n');
  const r = auditTarget(dir);
  const a = r.findings.filter((f) => f.category === 'absent-agent-reference');
  assert.equal(a.length, 1);
  assert.equal(a[0].file, 'TASKS.md');
});

test('対象が存在しない/UNC は拒否', () => {
  assert.throws(() => auditTarget(path.join(tmp, 'nope')), /存在しない/);
  assert.throws(() => auditTarget('\\\\server\\share'), /UNC/);
});
