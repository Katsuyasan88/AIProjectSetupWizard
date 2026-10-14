// 運用の段階 (profile): minimal / standard / full。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { planApply, applyToDir } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE, STANDARD_ELEMENTS } from '../src/constants.mjs';
import { PROFILES, PUSH_REWRITES } from '../src/render-profile.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, profile, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', profile, ...ov })));
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
const cats = (dir) => auditTarget(dir).findings.filter((f) => f.severity !== 'info').map((f) => f.category);
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `p${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}

test('未指定は standard。知らない段階は拒否する', () => {
  const { profile, ...rest } = baseConfig();
  assert.equal(validateConfig(rest).config.profile, 'standard');
  assert.throws(() => validateConfig(baseConfig({ profile: 'heavy' })), /profile/);
});

test('ウィザード標準の各要素が、その段階以上の 4 モードの生成文書に入っている。下の段階には入らない', () => {
  for (const mode of MODE_NAMES) {
    PROFILES.forEach((profile, level) => {
      const plan = planFor(mode, profile);
      for (const e of STANDARD_ELEMENTS.filter((x) => !x.setting)) {
        const applies = !e.profile || PROFILES.indexOf(e.profile) <= level;
        const targets = e.file === 'entry' ? MODES[mode].agents.map((a) => ENTRY_FILE[a]) : [e.file];
        for (const t of targets) {
          const text = fileOf(plan, t);
          if (applies) assert.ok(text && (e.markers ?? [e.marker]).some((m) => text.includes(m)), `${mode}/${profile}: ${e.id} が ${t} にない`);
          else if (e.profile) assert.ok(!text || !text.includes(e.marker), `${mode}/${profile}: ${e.id} が下の段階に入っている`);
        }
      }
    });
  }
});

test('段階ごとの文書: minimal は足さない、standard は CONTEXT と USER_TESTS、full は BACKLOG も', () => {
  for (const mode of MODE_NAMES) {
    const names = (p) => planFor(mode, p).files.map((f) => f.path);
    for (const n of ['CONTEXT.md', 'USER_TESTS.md', 'BACKLOG.md']) assert.ok(!names('minimal').includes(n), `${mode}: minimal に ${n}`);
    assert.ok(names('standard').includes('CONTEXT.md') && names('standard').includes('USER_TESTS.md') && !names('standard').includes('BACKLOG.md'), mode);
    assert.ok(names('full').includes('BACKLOG.md'), mode);
    assert.notEqual(planFor(mode, 'minimal').digest, planFor(mode, 'standard').digest);
    assert.notEqual(planFor(mode, 'standard').digest, planFor(mode, 'full').digest);
  }
});

test('standard: 課題は T-000 / T-001 の個票で、6 項目・実行キュー・一覧・ユーザーの作業 (U) を持つ。#t の表記は残らない', () => {
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode, 'standard');
    const t = fileOf(plan, 'TASKS.md');
    for (const h of ['## 実行キュー', '## 一覧', '## ユーザーの作業 (U-xxx)', '## 詳細', '## 再開メモ']) assert.ok(t.includes(h), `${mode}: ${h}`);
    assert.ok(/^- \[ \] T-000 初期確認$/m.test(t) && /^- \[ \] T-001 /m.test(t), mode);
    const card = t.slice(t.indexOf('### T-001:'), t.indexOf('## 段階'));
    for (const label of ['目的', '対象', '参照ドキュメント', '実装方針', '完了条件', '確認事項']) assert.ok(card.includes(`**${label}**:`), `${mode}: ${label}`);
    assert.ok(/U-001/.test(t) && /バージョン管理: /.test(t) && /CONTEXT\.md/.test(t), mode);
    for (const f of plan.files) {
      if (f.path.endsWith('.md')) assert.ok(!/#t[01]\b|`#id`/.test(f.content), `${mode}: ${f.path} に #t の表記`);
    }
    // 作業文書は担当名を含まず、モードが違っても同じ
    const base = planFor('codex-led', 'standard');
    for (const name of ['TASKS.md', 'VALIDATION.md', 'CONTEXT.md', 'USER_TESTS.md']) {
      assert.ok(!/Codex|Claude/.test(fileOf(plan, name)), `${mode}: ${name} に担当名`);
      assert.equal(fileOf(plan, name), fileOf(base, name), `${mode}: ${name} がモード依存`);
    }
  }
});

test('standard: 正本に 課題の進め方・レビューと是正・ブランチとマージ・報告・履歴の分離 が入り、役割に合った書き分けになる', () => {
  const led = fileOf(planFor('codex-led', 'standard'), 'WORKFLOW.md');
  assert.ok(/Claude は着手時に `\[~\]` にできる。`\[x\]` にするのは Codex だけ/.test(led));
  assert.ok(/reviews\/Codex\/YYYYMMDD_T-xxx_review\.md/.test(led));
  assert.ok(/マージは、ユーザーまたは Codex の明示があったときだけ行う/.test(led));
  assert.ok(/push は「承認の扱い」のとおり、ユーザーの明示承認が要る/.test(led));
  const solo = fileOf(planFor('claude-solo', 'standard'), 'WORKFLOW.md');
  assert.ok(/自己レビューは自己確認であり、独立レビューではない/.test(solo));
  assert.ok(!/Codex/.test(solo), '単独モードで不在の担当に言及しない');
  for (const wf of [led, solo]) {
    assert.ok(/確認済み・未確認・推測を分けて書く/.test(wf) && /前の案件のコマンド・設定・承認・環境・鍵が、この案件にもあると仮定しない/.test(wf));
    assert.ok(!wf.includes('## TASKS.md の記法'), '古い記法の節は置き換わる');
    assert.ok(wf.includes('## 変更の扱い') && wf.includes('承認不要 (通常作業)'), '既存の節は残る');
    assert.ok(!wf.includes('## 検討から課題まで'), 'full の節は入らない');
  }
  // 入口には担当ごとの要点が入る
  const lead = fileOf(planFor('codex-led', 'standard'), 'AGENTS.md');
  const impl = fileOf(planFor('codex-led', 'standard'), 'CLAUDE.md');
  assert.ok(/完了にするのはこの担当だけ/.test(lead));
  assert.ok(/課題の発行、順位の変更、`\[x\]` 化はしない/.test(impl) && /仕様を独断で変えない/.test(impl));
  for (const e of [lead, impl]) assert.ok(/^- 役割: /m.test(e) && /いつ何を読むか/.test(e) && /CONTEXT\.md/.test(e));
});

test('full: 検討から課題まで・完了の記録・公開と費用と引き継ぎ が入る。単独モードに引き継ぎ文の決まりは入らない', () => {
  const led = fileOf(planFor('claude-led', 'full'), 'WORKFLOW.md');
  for (const h of ['## 検討から課題まで', '## 完了の記録', '## 公開・費用・引き継ぎ']) assert.ok(led.includes(h), h);
  assert.ok(/別の担当へ依頼するのは、次の具体的な作業があるときだけ/.test(led));
  assert.ok(/tasks\/archive\/YYYY-MM\.md/.test(fileOf(planFor('claude-led', 'full'), 'TASKS.md')));
  const solo = fileOf(planFor('codex-solo', 'full'), 'WORKFLOW.md');
  assert.ok(solo.includes('## 公開・費用・引き継ぎ') && !/別の担当へ依頼する/.test(solo) && !/Claude/.test(solo));
});

test('4 モード × 3 段階: 生成直後の監査は検出 0 (リンク切れ・役割の矛盾・不在の担当への言及なし)', () => {
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const r = auditTarget(gen(planFor(mode, profile, { projectRules: ['例のルール'], handover: ['例の引継ぎ'] })));
      assert.deepEqual(r.findings, [], `${mode}/${profile}`);
    }
  }
});

test('監査: T-001 形式の ID でも、OK 以外の結果のまま完了にすると検出する。着手中 ([~]) は完了として扱わない', () => {
  const mark = (dir, id, state, tail = '') => {
    const p = path.join(dir, 'TASKS.md');
    fs.writeFileSync(p, readText(p).replace(new RegExp(`^- \\[ \\] ${id} (.*)$`, 'm'), `- [${state}] ${id} $1${tail}`));
  };
  const result = (dir, row) => fs.appendFileSync(path.join(dir, 'VALIDATION.md'), `${row}\n`);

  const ng = gen(planFor('claude-solo', 'standard'));
  result(ng, '| 2026-10-12 | T-001 | 実行成功 | logs/t1.txt | 自己確認 | a1b2c3 | 0 件 |');
  mark(ng, 'T-001', 'x', ' 証跡: logs/t1.txt');
  assert.ok(cats(ng).includes('done-but-validation-failed'));

  const ok = gen(planFor('claude-solo', 'standard'));
  result(ok, '| 2026-10-12 | T-001 | OK | logs/t1.txt | 自己確認 | a1b2c3 | 4 件 |');
  mark(ok, 'T-001', 'x', ' 証跡: logs/t1.txt');
  assert.deepEqual(cats(ok), []);

  const doing = gen(planFor('claude-solo', 'standard'));
  result(doing, '| 2026-10-12 | T-001 | NG | logs/t1.txt | 自己確認 | a1b2c3 | 失敗 |');
  mark(doing, 'T-001', '~');
  assert.deepEqual(cats(doing), [], '着手中は検出しない');

  const noEvidence = gen(planFor('claude-solo', 'standard'));
  mark(noEvidence, 'T-001', 'x');
  assert.ok(cats(noEvidence).includes('done-without-evidence'));
  // ユーザーの作業 (U) と本人確認 (UT) の ID も課題の ID として読める
  fs.appendFileSync(path.join(noEvidence, 'TASKS.md'), '\n- [x] U-001 アカウントを用意する 証跡: 本人の報告 (10/12)\n');
  assert.ok(!cats(noEvidence).includes('done-without-id'));
});

test('段階の変更: minimal → standard は足りない文書を足す。書き足した課題表は残す。standard → minimal は未変更の文書だけ退避する', () => {
  const dir = gen(planFor('codex-led', 'minimal'));
  fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] #t9 自分で足した課題\n');
  const up = planFor('codex-led', 'standard');
  const r1 = planApply(up, dir);
  assert.deepEqual(r1.blockers, []);
  assert.equal(r1.entries.find((e) => e.path === 'CONTEXT.md').status, 'added');
  assert.equal(r1.entries.find((e) => e.path === 'TASKS.md').status, 'kept');
  applyToDir({ plan: up, targetDir: dir, confirmDigest: r1.confirmDigest });
  assert.ok(/#t9 自分で足した課題/.test(readText(path.join(dir, 'TASKS.md'))));
  assert.ok(fs.existsSync(path.join(dir, 'USER_TESTS.md')));

  // CONTEXT を埋めたあとで minimal に戻す: 埋めた CONTEXT は残り、未変更の USER_TESTS はバックアップへ
  fs.appendFileSync(path.join(dir, 'CONTEXT.md'), '\n技術: 例\n');
  const down = planFor('codex-led', 'minimal');
  const r2 = planApply(down, dir);
  assert.deepEqual(r2.removals.map((x) => x.path), ['USER_TESTS.md']);
  assert.ok(r2.kept.some((k) => k.path === 'CONTEXT.md'));
  const done = applyToDir({ plan: down, targetDir: dir, confirmDigest: r2.confirmDigest });
  assert.ok(fs.existsSync(path.join(dir, 'CONTEXT.md')) && !fs.existsSync(path.join(dir, 'USER_TESTS.md')));
  assert.ok(fs.existsSync(path.join(done.backupDir, 'USER_TESTS.md')));
});

test('全段階: 課題の ID は T-000 / T-001 の形で、#t や #id の表記は生成物に残らない', () => {
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const plan = planFor(mode, profile);
      assert.ok(/^- \[ \] T-000 初期確認/m.test(fileOf(plan, 'TASKS.md')) && /T-001/.test(fileOf(plan, 'TASKS.md')), `${mode}/${profile}`);
      for (const f of plan.files) {
        if (f.path.endsWith('.md') && f.path !== 'PROJECT.md') assert.ok(!/#t[01](?![0-9])|#id/.test(f.content), `${mode}/${profile}: ${f.path} に古い表記`);
      }
    }
  }
  // ユーザーの文章 (引用) の中の #t1 は書き換えない
  const quoted = planFor('claude-solo', 'standard', { purpose: '#t1 という名前の機能を作る' });
  assert.ok(fileOf(quoted, 'PROJECT.md').includes('#t1 という名前の機能を作る'));
});

test('push の承認: 既定は毎回承認。work-branch を選ぶと、作業ブランチへの push だけ承認なしになり、ほかは承認のまま', () => {
  assert.equal(validateConfig(baseConfig()).config.pushPolicy, 'approval');
  assert.throws(() => validateConfig(baseConfig({ pushPolicy: 'always-free' })), /pushPolicy/);
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const strict = planFor(mode, profile);
      const free = planFor(mode, profile, { pushPolicy: 'work-branch' });
      assert.notEqual(strict.digest, free.digest, `${mode}/${profile}: digest が変わる`);
      const all = (plan) => plan.files.filter((f) => f.path.endsWith('.md')).map((f) => f.content).join('\n');
      const s = all(strict);
      const w = all(free);
      assert.ok(/外部公開、push、/.test(s) && !/作業ブランチへの push/.test(s), `${mode}/${profile}: 既定は毎回承認`);
      assert.ok(/承認不要 \(通常作業\): 編集許可パス内の編集、課題の作業ブランチへの push/.test(w), `${mode}/${profile}`);
      assert.ok(/作業ブランチ以外への push/.test(w) && /remote が設定済みのとき/.test(w), `${mode}/${profile}`);
      // 置き換え漏れがない: 毎回承認の言い回しが 1 つも残らない
      for (const [from, to] of PUSH_REWRITES) {
        if (!s.includes(from)) continue; // この段階の文書にない言い回し (例: 最小にはブランチの節がない)
        assert.ok(w.includes(to), `${mode}/${profile}: 「${to.slice(0, 20)}…」に置き換わっていない`);
        if (!to.includes(from)) assert.ok(!w.includes(from), `${mode}/${profile}: 「${from.slice(0, 20)}…」が残っている`);
      }
      // 緩めるのは作業ブランチへの push だけ
      assert.ok(/別AIプロセスの起動、外部公開、作業ブランチ以外への push/.test(w) && /秘密・認証情報/.test(w), `${mode}/${profile}`);
      if (profile !== 'minimal') assert.ok(/`main` などほかのブランチへの push、マージ、公開は承認が要る/.test(w) && /公開先を独断で作らない/.test(w), `${mode}/${profile}`);
    }
  }
  const dir = gen(planFor('codex-led', 'standard', { pushPolicy: 'work-branch' }));
  assert.deepEqual(auditTarget(dir).findings, []);
});

test('標準以上: 初期の課題は 初期確認 → 基本ドキュメント (T-001) → Skill (T-002) → MVP (T-003) の順で、どれも 6 項目を持つ', () => {
  for (const mode of MODE_NAMES) {
    for (const profile of ['standard', 'full']) {
      const plan = planFor(mode, profile);
      const t = fileOf(plan, 'TASKS.md');
      const queue = t.slice(t.indexOf('## 実行キュー'), t.indexOf('## 一覧'));
      assert.deepEqual(queue.match(/T-00[0-9]/g), ['T-000', 'T-001', 'T-002', 'T-003'], `${mode}/${profile}`);
      for (const [id, title] of [['T-001', '基本ドキュメントを作る'], ['T-002', '必要な Skill を作る'], ['T-003', 'MVP の最小の 1 経路を動かす']]) {
        assert.ok(new RegExp(`^- \\[ \\] ${id} ${title}$`, 'm').test(t), `${mode}/${profile}: 一覧に ${id}`);
        const start = t.indexOf(`### ${id}: ${title}`);
        assert.ok(start > 0, `${mode}/${profile}: 詳細に ${id}`);
        const next = t.indexOf('\n### ', start + 5);
        const card = t.slice(start, next > 0 ? next : t.indexOf('## 段階'));
        for (const label of ['目的', '対象', '参照ドキュメント', '実装方針', '完了条件', '確認事項']) assert.ok(card.includes(`**${label}**:`), `${mode}/${profile}: ${id} の ${label}`);
      }
      assert.ok(/ユーザーに 1 回で聞く。推測で埋めない/.test(t) && /docs\/DECISIONS\.md/.test(t), `${mode}/${profile}: 文書の課題`);
      assert.ok(/作るものをユーザーに選んでもらう/.test(t) && /Skill の作成はユーザーの承認後/.test(t) && /権限を広げる指定はしない/.test(t), `${mode}/${profile}: Skill の課題`);
      assert.ok(!/Codex|Claude/.test(t), `${mode}/${profile}: 課題表に担当名`);
      // Skill の置き場所は正本にあり、使う AI の分だけ出る
      const wf = fileOf(plan, 'WORKFLOW.md');
      const skill = wf.slice(wf.indexOf('## 案件の Skill'), wf.indexOf('## ', wf.indexOf('## 案件の Skill') + 5));
      assert.equal(skill.includes('.claude/skills/'), MODES[mode].agents.includes('Claude'), `${mode}/${profile}: Claude の置き場所`);
      assert.equal(skill.includes('.agents/skills/'), MODES[mode].agents.includes('Codex'), `${mode}/${profile}: Codex の置き場所`);
      assert.equal(/二重に持たない/.test(skill), !MODES[mode].solo, `${mode}/${profile}`);
      // 文書を管理する担当の編集範囲に docs/ と CONTEXT.md が入る
      const edit = wf.slice(wf.indexOf('## 編集権限'), wf.indexOf('## 承認の扱い'));
      assert.ok(/`docs\/` 配下の仕様・設計の文書/.test(edit) && /CONTEXT\.md/.test(edit), `${mode}/${profile}: 編集範囲`);
    }
    // 最小の段階にも、同じ 3 つの課題が短い形で入る
    const min = fileOf(planFor(mode, 'minimal'), 'TASKS.md');
    const tasks = min.slice(min.indexOf('## 課題'), min.indexOf('## 段階'));
    assert.deepEqual(tasks.match(/^- \[ \] T-00[0-9]/gm), ['- [ ] T-001', '- [ ] T-002', '- [ ] T-003'], `${mode}: minimal の課題`);
    assert.ok(/T-001 基本ドキュメントを作る/.test(tasks) && /T-002 必要な Skill を作る/.test(tasks) && /T-003 MVP の最小の1経路を動かす/.test(tasks), `${mode}: minimal`);
    assert.equal((tasks.match(/^ {2}- 合格条件: /gm) || []).length, 3, `${mode}: minimal の合格条件`);
    assert.ok(/推測で埋めない/.test(tasks) && /作るものはユーザーが選び、作成は承認後/.test(tasks) && !/Codex|Claude/.test(min), `${mode}: minimal`);
    assert.ok(/基本ドキュメント \(T-001\) で作る文書の範囲と、MVP の課題 \(T-003\) の合格条件/.test(min), `${mode}: minimal の初期確認`);
  }
});
