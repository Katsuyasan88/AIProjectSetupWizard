// 更新後の対応: 設定の変更にともなって案件側の AI が行う作業を、apply が課題表の末尾へ追記する。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { planApply, applyToDir, formatApplyReport } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { FOLLOWUP_HEADING, settingFollowups, appendFollowups } from '../src/followup.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (ov = {}) => buildPlan(validateConfig(baseConfig({ mode: 'claude-led', profile: 'standard', ...ov })));
const cfg = (ov = {}) => validateConfig(baseConfig({ mode: 'claude-led', profile: 'standard', ...ov })).config;
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `f${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}
const apply = (plan, dir, opts = {}) => applyToDir({ plan, targetDir: dir, confirmDigest: planApply(plan, dir, opts).confirmDigest, ...opts });

test('設定が変わらなければ、対応は並べない。変わった項目の分だけ並べ、担当名と課題 ID は書かない', () => {
  assert.deepEqual(settingFollowups(cfg(), cfg()), []);
  assert.deepEqual(settingFollowups(null, cfg({ uiRules: true })), [], '変更前が分からなければ推測しない');
  const ui = settingFollowups(cfg(), cfg({ uiRules: true }));
  assert.equal(ui.length, 3);
  assert.ok(/デザインルールをユーザーと決め/.test(ui[0]) && /決まっていないことを推測で書かない/.test(ui[0]) && /CONTEXT\.md に書く/.test(ui[0]));
  assert.ok(/直接書いている箇所/.test(ui[1]) && /検証レシピに登録/.test(ui[2]));
  assert.ok(/TASKS\.md の再開メモ に書く/.test(settingFollowups(cfg({ profile: 'minimal' }), cfg({ profile: 'minimal', uiRules: true }))[0]));
  const launch = settingFollowups(cfg(), cfg({ launchPolicy: 'lead-launch' }));
  assert.equal(launch.length, 3);
  assert.ok(/起動の手段と、範囲が/.test(launch[0]) && /承認記録に書く/.test(launch[0]));
  assert.ok(/毎回承認に戻った/.test(settingFollowups(cfg({ launchPolicy: 'lead-launch' }), cfg())[0]));
  const many = settingFollowups(cfg(), cfg({ mode: 'codex-led', pushPolicy: 'work-branch', profile: 'full', ai: { codex: { model: 'model-a', fallbackModels: ['model-b'] } } }));
  assert.deepEqual(many.map((l) => l.slice(2, l.indexOf(':'))), ['役割の変更', 'モデルの設定', 'push の承認', '運用の段階']);
  for (const line of [...ui, ...launch, ...many]) assert.ok(/^- /.test(line) && !/Codex|Claude|T-\d|\[ \]/.test(line), line);
  assert.equal(appendFollowups('a\n- x\n', ['- x']), null);
  assert.deepEqual(appendFollowups('a', ['- x', '- x', '- y']).lines, ['- x', '- y']);
});

test('書き足された課題表: 既存の行は変えずに、末尾へ対応を追記する。差分と digest に入り、変更前はバックアップへ', () => {
  const p0 = planFor();
  const dir = gen(p0);
  const tasksFile = path.join(dir, 'TASKS.md');
  const edited = readText(tasksFile).replace('**承認記録**: (未記入)', '**承認記録**: 編集範囲は src/ と test/。') + '\n(案件で書き足した行)\n';
  fs.writeFileSync(tasksFile, edited);
  const contextFile = path.join(dir, 'CONTEXT.md');
  fs.appendFileSync(contextFile, '\n(案件で書き足した知識)\n');

  const p1 = planFor({ uiRules: true, launchPolicy: 'lead-launch' });
  const r = planApply(p1, dir);
  assert.equal(r.followup.path, 'TASKS.md');
  assert.equal(r.followup.lines.length, 7, '画面 3 + 起動 3 + 残した CONTEXT.md 1');
  const shown = formatApplyReport(r);
  assert.ok(shown.includes('TASKS.md: 末尾に「ウィザード更新後の対応」を追記する') && shown.includes(`+${FOLLOWUP_HEADING}`) && shown.includes('+- 画面の実装の基本: デザインルールをユーザーと決め'));
  assert.notEqual(r.confirmDigest, planApply(planFor({ uiRules: true }), dir).confirmDigest);
  // 追記は承認の対象: 古い digest では書けない
  assert.throws(() => applyToDir({ plan: p1, targetDir: dir, confirmDigest: planApply(p0, dir).confirmDigest }), /digest/);

  const done = applyToDir({ plan: p1, targetDir: dir, confirmDigest: r.confirmDigest });
  const after1 = readText(tasksFile);
  assert.ok(after1.startsWith(edited), '既存の行はそのまま');
  const added = after1.slice(edited.length);
  assert.ok(added.includes(FOLLOWUP_HEADING) && added.includes('主導担当が読み、必要なものを課題として発行します'));
  assert.equal((added.match(/^- /gm) || []).length, 7);
  assert.ok(added.includes('- CONTEXT.md: ウィザードのひな型が変わったが、書き足しがあるため上書きしていない'));
  assert.ok(!/Codex|Claude/.test(added), '作業文書に担当名を書かない');
  assert.equal(readText(path.join(done.backupDir, 'TASKS.md')), edited);
  assert.ok(readText(contextFile).includes('(案件で書き足した知識)') && !readText(contextFile).includes('表示の値'), '残した文書は変えない');
  assert.ok(done.written.includes('TASKS.md'));
  assert.deepEqual(auditTarget(dir).findings.filter((f) => f.severity !== 'info'), []);

  // 同じ設定でもう一度: 足すものがない
  const again = planApply(p1, dir);
  assert.equal(again.followup, null);
  assert.ok(again.nothingToDo);
  // 設定を戻すと、その変更の対応だけが足される
  const back = planApply(planFor({ uiRules: true }), dir);
  assert.deepEqual(back.followup.lines.map((l) => l.slice(0, 20)), ['- 別AIの起動: 毎回承認に戻った。承']);
});

test('別AIの起動の項目がない設定 (項目ができる前の生成物) は、毎回承認だったものとして読み、既定への切り替えを対応に書く', () => {
  const { launchPolicy, ...noKey } = baseConfig({ mode: 'claude-led', profile: 'standard' });
  // 当時の生成物を再現する: 文書は毎回承認、設定には項目がない
  const dir = gen(planFor());
  const cfgFile = path.join(dir, 'setup.config.json');
  const old = JSON.parse(readText(cfgFile));
  delete old.launchPolicy;
  fs.writeFileSync(cfgFile, JSON.stringify(old, null, 2));
  const next = buildPlan(validateConfig(noKey));
  const r = planApply(next, dir);
  assert.equal(r.entries.find((e) => e.path === 'WORKFLOW.md').status, 'changed');
  assert.equal(r.followup.lines.length, 3);
  assert.ok(r.followup.lines.every((l) => l.startsWith('- 別AIの起動: ')));
});

test('書き足しのない課題表・設定の変更なし・導入 (--adopt) の扱い', () => {
  // 書き足しのない課題表: 新しいひな型の末尾に追記する
  const dir = gen(planFor());
  const p1 = planFor({ uiRules: true });
  apply(p1, dir);
  const tasks = readText(path.join(dir, 'TASKS.md'));
  assert.ok(tasks.startsWith(p1.files.find((f) => f.path === 'TASKS.md').content) && tasks.includes(FOLLOWUP_HEADING));
  assert.ok(planApply(p1, dir).nothingToDo);

  // 設定を変えない更新では追記しない
  const same = gen(planFor());
  assert.equal(planApply(planFor(), same).followup, null);

  // 導入: 同名の既存ファイルは変えない
  const own = path.join(tmp, 'own');
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'TASKS.md'), '# 自前の課題表\n');
  const r = planApply(planFor({ uiRules: true }), own, { adopt: true });
  assert.equal(r.followup, null);
  apply(planFor({ uiRules: true }), own, { adopt: true });
  assert.equal(readText(path.join(own, 'TASKS.md')), '# 自前の課題表\n');
});

test('以前の配置から移す課題表にも、移した先の末尾へ追記する', () => {
  const dir = gen(planFor({ layout: 'root' }));
  const edited = readText(path.join(dir, 'TASKS.md')) + '\n(書き足し)\n';
  fs.writeFileSync(path.join(dir, 'TASKS.md'), edited);
  const p1 = planFor({ layout: 'folders', uiRules: true });
  const done = apply(p1, dir);
  const moved = readText(path.join(dir, 'docs', 'TASKS.md'));
  assert.ok(moved.startsWith(edited) && moved.includes(FOLLOWUP_HEADING));
  assert.ok(!fs.existsSync(path.join(dir, 'TASKS.md')) && fs.existsSync(path.join(done.backupDir, 'TASKS.md')));
});
