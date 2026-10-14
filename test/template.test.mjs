// 生成文書 (template 3) の構造: 読むタイミング、初期確認、検証レシピ、最初の課題、証拠欄、作業文書の役割非依存。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { auditTarget } from '../src/audit.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

function planFor(mode, overrides = {}) {
  return buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', ...overrides })));
}
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
const UNDECIDED = { tech: '', verifyCommands: [], phases: [], outOfScope: [], permissions: { allowedPaths: [], forbidden: [] } };

function gen(name, plan) {
  const dir = path.join(tmp, name);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}
const cats = (r) => r.findings.filter((f) => f.severity !== 'info').map((f) => f.category);

test('4 モード: 入口は開始時・着手前・検証時・再開時に読むものと、欠落/矛盾時の停止を示す', () => {
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode);
    for (const agent of MODES[mode].agents) {
      const e = fileOf(plan, ENTRY_FILE[agent]);
      assert.ok(e.includes('## いつ何を読むか'), `${mode}/${agent}`);
      for (const when of ['開始時', '着手前', '検証時', '再開時']) assert.ok(new RegExp(`^- ${when}: `, 'm').test(e), `${mode}/${agent}: ${when}`);
      assert.ok(/その作業を止め/.test(e) && /権限を作ったりしない/.test(e), `${mode}/${agent}: 停止規則`);
      assert.ok(!/^@|\s@[A-Za-z]/m.test(e), `${mode}/${agent}: @import を使わない`);
      assert.ok(/再開メモ/.test(e));
    }
    assert.ok(/2 回目以降は貼らなくても/.test(fileOf(plan, 'START.md')));
  }
});

test('4 モード: 作業文書 (TASKS / VALIDATION) に担当名がなく、モードが違っても同じ内容', () => {
  const base = planFor('codex-led');
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode);
    for (const name of ['TASKS.md', 'VALIDATION.md']) {
      assert.ok(!/Codex|Claude/.test(fileOf(plan, name)), `${mode}: ${name} に担当名`);
      assert.equal(fileOf(plan, name), fileOf(base, name), `${mode}: ${name} がモード依存`);
    }
  }
});

test('4 モード: 初期確認は 1 つの課題 (T-000) にまとまり、最初の課題 (T-001) は合格条件・検証の欄を持つ', () => {
  for (const mode of MODE_NAMES) {
    const t = fileOf(planFor(mode, UNDECIDED), 'TASKS.md');
    assert.equal((t.match(/^- \[ \] T-000 /gm) || []).length, 1, mode);
    const block = t.slice(t.indexOf('## 初期確認'), t.indexOf('## 課題'));
    for (const s of ['編集許可パスを決める', '検証コマンドを決める', '技術を決めて', 'MVP の課題 (T-003) の合格条件', '承認記録:']) assert.ok(block.includes(s), `${mode}: ${s}`);
    assert.equal((block.match(/^- \[ \]/gm) || []).length, 1, `${mode}: 未定ごとに別課題を作らない`);
    assert.ok(/^- \[ \] T-001 /m.test(t) && /^ {2}- 合格条件: /m.test(t) && /^ {2}- 検証: /m.test(t), mode);
    for (const s of ['## 再開メモ', '- 対象版:', '- 留保・未検証:', '- 次の作業と開始条件:']) assert.ok(t.includes(s), `${mode}: ${s}`);
    const wf = fileOf(planFor(mode, UNDECIDED), 'WORKFLOW.md');
    assert.ok(/「初期確認」\(T-000\) でユーザーが承認し記録された範囲だけ/.test(wf), mode);
    assert.ok(/記録がなければ編集しない/.test(wf), mode);
  }
  // 決まっている場合は「決める」ではなく確認になる
  const t = fileOf(planFor('codex-led'), 'TASKS.md');
  assert.ok(/編集範囲: WORKFLOW\.md の編集許可パスのとおりでよいか/.test(t));
  assert.ok(/候補が実在するか確認し、検証レシピに登録する/.test(t));
});

test('検証: 入力コマンドは実在未確認の候補で、承認不要は登録済みレシピだけ。未定でも架空の手順を補わない', () => {
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode, { verifyCommands: ['npm run nonexistent'] });
    const v = fileOf(plan, 'VALIDATION.md');
    assert.ok(/## 検証コマンドの候補 \(ユーザー入力・実在未確認\)/.test(v), mode);
    assert.ok(/候補のままでは実行せず/.test(v));
    assert.ok(v.includes('| 番号 | コマンドまたは手順 | 実在の根拠 | 実行場所 | 前提 | 確認する対象 | 期待結果 |'));
    const wf = fileOf(plan, 'WORKFLOW.md');
    assert.ok(/検証レシピに登録済みの検証の実行/.test(wf), mode);
    assert.ok(!/に記録された検証コマンドの実行/.test(wf), `${mode}: 入力コマンドを無条件に承認不要としない`);
    assert.ok(/破壊的な操作・外部送信・費用を伴うもの/.test(wf));
    for (const agent of MODES[mode].agents) assert.ok(/検証レシピに登録済みの検証の実行は承認不要/.test(fileOf(plan, ENTRY_FILE[agent])));
    const u = fileOf(planFor(mode, UNDECIDED), 'VALIDATION.md');
    const code = u.slice(u.indexOf('## 検証コマンドの候補'), u.indexOf('## 検証レシピ'));
    assert.ok(code.includes('(未定)') && /存在しないスクリプトやビルド手順を補わない/.test(code), mode);
    assert.ok(!/npm|yarn|pnpm|pytest|make /.test(u), `${mode}: 未定なのに具体的なコマンドを出している`);
  }
});

test('証拠: 結果表は既存 5 列を先頭に保ち、対象版と環境・件数・留保を後ろに持つ。実行成功は OK ではない', () => {
  const v = fileOf(planFor('claude-solo'), 'VALIDATION.md');
  assert.ok(v.includes('| 日付 | 課題 (T-xxx) | 結果 | 証跡 (ファイル・ログの所在) | 確認者 | 対象版 | 環境・実行件数・留保 |'));
  assert.ok(/実行件数が 0 の成功/.test(v) && /採用していない変更や実験用のファイル/.test(v) && /自己確認/.test(v));
});

test('audit: OK 以外の結果 (実行成功/未実行/環境不能/NG/未確認) の #id を [x] にすると検出。OK と旧 5 列の行は通る', () => {
  const cases = [
    ['実行成功', true],
    ['未実行', true],
    ['環境不能', true],
    ['NG', true],
    ['未確認', true],
    ['OK', false],
  ];
  cases.forEach(([result, flagged], i) => {
    const dir = gen(`vocab-${i}`, planFor('claude-solo'));
    const vp = path.join(dir, 'VALIDATION.md');
    const tp = path.join(dir, 'TASKS.md');
    fs.writeFileSync(vp, readText(vp).replace(/\| \| \| \| \| \| \| \|\n$/, `| 2026-10-11 | T-001 | ${result} | logs/t1.txt | 自己確認 | a1b2c3 | 3 件 |\n`));
    fs.writeFileSync(tp, readText(tp).replace('- [ ] T-001 ', '- [x] T-001 証跡: logs/t1.txt '));
    assert.equal(cats(auditTarget(dir)).includes('done-but-validation-failed'), flagged, result);
  });
  // 旧 5 列の行もそのまま読める
  const dir = gen('vocab-old', planFor('claude-solo'));
  fs.appendFileSync(path.join(dir, 'VALIDATION.md'), '| 2026-10-11 | T-001 | NG | logs/t1.txt | 自己確認 |\n');
  const tp = path.join(dir, 'TASKS.md');
  fs.writeFileSync(tp, readText(tp).replace('- [ ] T-001 ', '- [x] T-001 証跡: logs/t1.txt '));
  assert.ok(cats(auditTarget(dir)).includes('done-but-validation-failed'));
});

test('audit: 検証レシピの表は結果と取り違えない。#id のない [x] は検出', () => {
  const dir = gen('recipe-not-result', planFor('claude-solo'));
  const vp = path.join(dir, 'VALIDATION.md');
  // レシピ表の行に T-001 と「未確認」を含めても、結果記録ではない
  fs.writeFileSync(vp, readText(vp).replace('| | | | | | | |', '| V1 | T-001 用の手動確認 | 未確認 | . | なし | 画面 | 表示される |'));
  const tp = path.join(dir, 'TASKS.md');
  fs.writeFileSync(tp, readText(tp).replace('- [ ] T-001 ', '- [x] T-001 証跡: logs/t1.txt '));
  assert.ok(!cats(auditTarget(dir)).includes('done-but-validation-failed'));
  fs.appendFileSync(tp, '\n- [x] ID のない完了 証跡: logs/x.txt\n');
  assert.ok(cats(auditTarget(dir)).includes('done-without-id'));
});

test('4 モード: 生成直後の監査は検出 0 (リンク切れ・役割矛盾・不在担当への言及なし)', () => {
  for (const mode of MODE_NAMES) {
    for (const [label, ov] of [['set', {}], ['undecided', UNDECIDED]]) {
      const r = auditTarget(gen(`clean-${mode}-${label}`, planFor(mode, ov)));
      assert.deepEqual(r.findings, [], `${mode}/${label}`);
    }
  }
});

test('版の番号は各文書に埋め込まれない (版を上げても、中身の変わらない文書は差分に出ない)', () => {
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode, { projectRules: ['例のルール'], handover: ['例の引継ぎ'] });
    for (const f of plan.files) {
      if (!f.path.endsWith('.md')) continue;
      assert.ok(!/template[ =]d/.test(f.content), `${mode}: ${f.path} に版の番号`);
      assert.ok(!/vd+.d+.d+/.test(f.content), `${mode}: ${f.path} にツールの版`);
    }
  }
});
