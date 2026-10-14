import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir, diffAgainstExisting } from '../src/generate.mjs';
import { planApply, applyToDir, BACKUP_DIR_NAME } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { MANIFEST_FILE_NAME } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

function planFor(overrides) {
  return buildPlan(validateConfig(baseConfig(overrides)));
}

function seed(name, overrides = {}) {
  const plan = planFor(overrides);
  const dir = path.join(tmp, name);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}

function snapshot(dir) {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((n) => fs.statSync(path.join(dir, n)).isFile())
      .map((n) => [n, readText(path.join(dir, n))]),
  );
}

function backupDirs(dir) {
  const root = path.join(dir, BACKUP_DIR_NAME);
  return fs.existsSync(root) ? fs.readdirSync(root).map((n) => path.join(root, n)) : [];
}

test('apply: モード変更を既存フォルダへ直接反映し、変更前をバックアップ、案件のファイルは不変', () => {
  const dir = seed('apply-mode');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);\n');
  const oldWorkflow = readText(path.join(dir, 'WORKFLOW.md'));

  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.entries.find((e) => e.path === 'WORKFLOW.md').status, 'changed');
  const r = applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });

  // 課題表だけは、ひな型の内容の末尾に「ウィザード更新後の対応」(役割の変更にともなう作業) が足される
  for (const f of plan2.files.filter((x) => x.path !== 'TASKS.md')) assert.equal(readText(path.join(dir, f.path)), f.content);
  const tasksAfter = readText(path.join(dir, 'TASKS.md'));
  assert.ok(tasksAfter.startsWith(plan2.files.find((f) => f.path === 'TASKS.md').content) && /## ウィザード更新後の対応[^\n]*\n\n[^\n]+\n\n- 役割の変更: /.test(tasksAfter));
  const manifest = JSON.parse(readText(path.join(dir, MANIFEST_FILE_NAME)));
  assert.equal(manifest.planDigest, plan2.digest);
  assert.equal(manifest.mode, 'claude-led');
  assert.equal(readText(path.join(r.backupDir, 'WORKFLOW.md')), oldWorkflow);
  assert.ok(fs.existsSync(path.join(r.backupDir, MANIFEST_FILE_NAME)));
  assert.equal(readText(path.join(dir, 'src', 'app.js')), 'console.log(1);\n');
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.psw-tmp-')), '一時ファイルが残っている');
  assert.equal(auditTarget(dir).findings.filter((f) => f.severity !== 'info').length, 0);
});

test('apply: 単独化で不要になった未変更の入口はバックアップへ移す (削除しない)', () => {
  const dir = seed('apply-solo');
  const oldAgents = readText(path.join(dir, 'AGENTS.md'));
  const plan2 = planFor({ mode: 'claude-solo', handoff: undefined });
  const report = planApply(plan2, dir);
  assert.deepEqual(report.removals.map((x) => x.path), ['AGENTS.md']);
  const r = applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.equal(readText(path.join(r.backupDir, 'AGENTS.md')), oldAgents);
  assert.equal(auditTarget(dir).findings.filter((f) => f.severity !== 'info').length, 0);
});

test('apply: 手で変更された不要入口は残し、要確認として報告', () => {
  const dir = seed('apply-solo-edited');
  fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\n自分で足した行\n');
  const plan2 = planFor({ mode: 'claude-solo', handoff: undefined });
  const report = planApply(plan2, dir);
  assert.deepEqual(report.removals, []);
  assert.ok(report.kept.some((k) => k.path === 'AGENTS.md'));
  applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.ok(/自分で足した行/.test(readText(path.join(dir, 'AGENTS.md'))));
});

test('apply: 設定を変えずに実行すると、手で崩した文書を設定どおりに戻す (audit の差分案の反映)', () => {
  const dir = seed('apply-restore');
  const plan = planFor({});
  const original = readText(path.join(dir, 'WORKFLOW.md'));
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), original.replace('主導: Codex', '主導: Claude'));
  const report = planApply(plan, dir);
  const wf = report.entries.find((e) => e.path === 'WORKFLOW.md');
  assert.equal(wf.status, 'changed');
  assert.equal(wf.handEdited, true);
  const r = applyToDir({ plan, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.equal(readText(path.join(dir, 'WORKFLOW.md')), original);
  assert.ok(/主導: Claude/.test(readText(path.join(r.backupDir, 'WORKFLOW.md'))));
});

test('apply: 差分なしなら何も書かない', () => {
  const dir = seed('apply-noop');
  const before = snapshot(dir);
  const plan = planFor({});
  const report = planApply(plan, dir);
  assert.equal(report.nothingToDo, true);
  const r = applyToDir({ plan, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.deepEqual(r.written, []);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(backupDirs(dir), []);
});

test('apply: digest 不一致・確認後の対象変更・regenerate 用 digest・無人は拒否し、何も変えない', () => {
  const dir = seed('apply-digest');
  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  const before = snapshot(dir);
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: '0'.repeat(64) }), /一致しません/);
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: plan2.digest }), /一致しません/);
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: diffAgainstExisting(plan2, dir).confirmDigest }), /一致しません/);
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest, unattended: true }), /無人/);
  assert.deepEqual(snapshot(dir), before);
  // 確認後に対象が変わったら古い承認は使えない
  fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] 追加\n');
  const changed = snapshot(dir);
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest }), /一致しません/);
  assert.deepEqual(snapshot(dir), changed);
  assert.deepEqual(backupDirs(dir), []);
});

test('apply: manifest のないフォルダ (このツールの生成物ではない) は更新しない', () => {
  const dir = path.join(tmp, 'apply-foreign');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# 自作の入口\n');
  const plan = planFor({});
  const report = planApply(plan, dir);
  assert.ok(report.blockers.length > 0);
  assert.throws(() => applyToDir({ plan, targetDir: dir, confirmDigest: report.confirmDigest }), /更新できません/);
  assert.equal(readText(path.join(dir, 'CLAUDE.md')), '# 自作の入口\n');
  assert.deepEqual(fs.readdirSync(dir), ['CLAUDE.md']);
});

test('apply: 秘密らしい記述を含む文書は差分を出せないため更新しない', () => {
  const dir = seed('apply-secret');
  fs.appendFileSync(path.join(dir, 'WORKFLOW.md'), '\napi_key = sk-' + 'a'.repeat(40) + '\n');
  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  const before = snapshot(dir);
  assert.equal(report.entries.find((e) => e.path === 'WORKFLOW.md').secretSuppressed, true);
  assert.ok(report.blockers.some((b) => b.startsWith('WORKFLOW.md')));
  assert.throws(() => applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest }), /更新できません/);
  assert.deepEqual(snapshot(dir), before);
});

test('apply: 書き足された作業文書 (TASKS/VALIDATION) は上書きせず残し (課題表は末尾への追記だけ)、未変更なら更新する', () => {
  const dir = seed('apply-working');
  fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] 自分で足した課題\n');
  const edited = readText(path.join(dir, 'TASKS.md'));
  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  assert.equal(report.entries.find((e) => e.path === 'TASKS.md').status, 'kept');
  assert.ok(report.kept.some((k) => k.path === 'TASKS.md'));
  const r = applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });
  // 既存の行は変えない。役割を変えたので、末尾に更新後の対応だけが足される
  const tasksNow = readText(path.join(dir, 'TASKS.md'));
  assert.ok(tasksNow.startsWith(edited) && tasksNow.slice(edited.length).includes('## ウィザード更新後の対応'));
  assert.equal(readText(path.join(r.backupDir, 'TASKS.md')), edited);
  assert.ok(r.written.includes('WORKFLOW.md'));

  // 未変更の作業文書は、内容が変わる設定変更 (段階) なら更新される
  const dir2 = seed('apply-working-untouched');
  const plan3 = planFor({ phases: ['別の段階'] });
  const report2 = planApply(plan3, dir2);
  const r2 = applyToDir({ plan: plan3, targetDir: dir2, confirmDigest: report2.confirmDigest });
  assert.ok(r2.written.includes('TASKS.md'));
});

test('apply: 作業文書に担当名がないので、役割変更だけでは TASKS / VALIDATION は変わらない', () => {
  const dir = seed('apply-role-only');
  for (const mode of ['claude-led', 'codex-solo', 'claude-solo']) {
    const report = planApply(planFor({ mode, handoff: mode.endsWith('solo') ? undefined : 'manual' }), dir);
    for (const name of ['TASKS.md', 'VALIDATION.md']) assert.equal(report.entries.find((e) => e.path === name).status, 'same', `${mode}: ${name}`);
  }
});

test('apply: 書き込み途中で失敗したら、置換済みのファイルを元へ戻す', () => {
  const dir = seed('apply-rollback');
  const before = snapshot(dir);
  const plan2 = planFor({ mode: 'claude-solo', handoff: undefined });
  const report = planApply(plan2, dir);
  let n = 0;
  assert.throws(
    () =>
      applyToDir({
        plan: plan2,
        targetDir: dir,
        confirmDigest: report.confirmDigest,
        onWrite: () => {
          n += 1;
          if (n === 3) throw new Error('試験用の失敗');
        },
      }),
    /元へ戻しました/,
  );
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!fs.readdirSync(dir).some((x) => x.includes('.psw-tmp-')));
});

test('apply: manifest に書かれた生成物以外の名前は触らない', () => {
  const dir = seed('apply-manifest-inject');
  fs.writeFileSync(path.join(dir, 'notes.md'), '大事なメモ\n');
  const mp = path.join(dir, MANIFEST_FILE_NAME);
  const m = JSON.parse(readText(mp));
  m.files.push({ path: 'notes.md', sha256: 'x', bytes: 1 }, { path: '../outside.md', sha256: 'x', bytes: 1 });
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  assert.deepEqual(report.removals, []);
  applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.equal(readText(path.join(dir, 'notes.md')), '大事なメモ\n');
});

// ---- 導入 (--adopt): このツールで生成していない案件 ----
function foreign(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);' + '\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# 自作の入口' + '\n' + '- 案件固有のルール' + '\n');
  fs.writeFileSync(path.join(dir, 'TASKS.md'), '- [ ] 自作の課題' + '\n');
  return dir;
}

test('adopt: 既定では同名の既存ファイルを残し、ない文書と manifest だけを新しく作る', () => {
  const dir = foreign('adopt-keep');
  const before = snapshot(dir);
  const plan = planFor({});
  const report = planApply(plan, dir, { adopt: true });
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.kept.map((k) => k.path).sort(), ['CLAUDE.md', 'TASKS.md']);
  const r = applyToDir({ plan, targetDir: dir, confirmDigest: report.confirmDigest, adopt: true });
  assert.equal(readText(path.join(dir, 'CLAUDE.md')), before['CLAUDE.md']);
  assert.equal(readText(path.join(dir, 'TASKS.md')), before['TASKS.md']);
  assert.equal(readText(path.join(dir, 'src', 'app.js')), 'console.log(1);' + '\n');
  for (const name of ['WORKFLOW.md', 'PROJECT.md', 'VALIDATION.md', 'AGENTS.md', 'START.md', 'setup.config.json', MANIFEST_FILE_NAME]) assert.ok(fs.existsSync(path.join(dir, name)), name);
  assert.ok(!r.written.includes('CLAUDE.md') && !r.written.includes('TASKS.md'));
  // 導入後は通常の apply の対象になる (--adopt は不要と案内)
  assert.ok(planApply(plan, dir, { adopt: true }).blockers.some((b) => /--adopt は不要/.test(b)));
  assert.deepEqual(planApply(plan, dir).blockers, []);
});

test('adopt: --replace に指定した既存ファイルだけをバックアップして置き換える。digest は指定ごとに別', () => {
  const dir = foreign('adopt-replace');
  const plan = planFor({});
  const keep = planApply(plan, dir, { adopt: true });
  const report = planApply(plan, dir, { adopt: true, replace: ['CLAUDE.md'] });
  assert.notEqual(keep.confirmDigest, report.confirmDigest);
  assert.throws(() => applyToDir({ plan, targetDir: dir, confirmDigest: keep.confirmDigest, adopt: true, replace: ['CLAUDE.md'] }), /一致しません/);
  const r = applyToDir({ plan, targetDir: dir, confirmDigest: report.confirmDigest, adopt: true, replace: ['CLAUDE.md'] });
  assert.equal(readText(path.join(dir, 'CLAUDE.md')), plan.files.find((f) => f.path === 'CLAUDE.md').content);
  assert.ok(/自作の入口/.test(readText(path.join(r.backupDir, 'CLAUDE.md'))));
  assert.ok(/自作の課題/.test(readText(path.join(dir, 'TASKS.md'))));
});

test('adopt: 生成対象でない名前の --replace、秘密らしい記述のある置き換え対象、無人は拒否', () => {
  const dir = foreign('adopt-guard');
  const plan = planFor({});
  assert.ok(planApply(plan, dir, { adopt: true, replace: ['src/app.js'] }).blockers.length > 0);
  fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'api_key = sk-' + 'a'.repeat(40) + '\n');
  const before = snapshot(dir);
  assert.ok(planApply(plan, dir, { adopt: true, replace: ['CLAUDE.md'] }).blockers.some((b) => b.startsWith('CLAUDE.md')));
  const ok = planApply(plan, dir, { adopt: true });
  assert.deepEqual(ok.blockers, [], '残すだけなら秘密らしい記述があっても導入できる (ファイルには触れない)');
  assert.throws(() => applyToDir({ plan, targetDir: dir, confirmDigest: ok.confirmDigest, adopt: true, unattended: true }), /無人/);
  assert.deepEqual(snapshot(dir), before);
});

test('apply: バックアップフォルダに全部無視の .gitignore を置き、案件側の .gitignore には触れない', () => {
  const dir = seed('apply-backup-ignore');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/' + String.fromCharCode(10));
  const plan2 = planFor({ mode: 'claude-led' });
  const report = planApply(plan2, dir);
  applyToDir({ plan: plan2, targetDir: dir, confirmDigest: report.confirmDigest });
  assert.equal(readText(path.join(dir, BACKUP_DIR_NAME, '.gitignore')).trim(), '*');
  assert.equal(readText(path.join(dir, '.gitignore')), 'node_modules/' + String.fromCharCode(10));
  // 2 回目の更新でも置き直さない
  const plan3 = planFor({ mode: 'codex-led' });
  const report3 = planApply(plan3, dir);
  applyToDir({ plan: plan3, targetDir: dir, confirmDigest: report3.confirmDigest });
  assert.equal(readText(path.join(dir, BACKUP_DIR_NAME, '.gitignore')).trim(), '*');
});
