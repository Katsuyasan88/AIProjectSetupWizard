// 利用範囲 (audience): 必須。自分用 / 会社用 / 公開 で、正本の「利用範囲」の決まりが変わる。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan, planSummary } from '../src/plan.mjs';
import { generateToDir, GenerateError } from '../src/generate.mjs';
import { applyToDir } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { settingFollowups, parseConfigText } from '../src/followup.mjs';
import { AUDIENCES, AUDIENCE_NAMES, MODES, MODE_NAMES, STANDARD_ELEMENTS } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (ov = {}) => buildPlan(validateConfig(baseConfig(ov)));
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `a${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}

test('利用範囲は必須: 未回答は要確認で生成も更新もできない。知らない値と文字列以外は拒否する', () => {
  const { audience, ...noKey } = baseConfig();
  const v = validateConfig(noKey);
  assert.equal(v.config.audience, '');
  assert.ok(v.needsConfirmation.some((n) => n.field === 'audience' && n.required));
  const plan = buildPlan(v);
  assert.equal(plan.canGenerate, false);
  assert.match(planSummary(plan), /利用範囲: \(未回答\)/);
  assert.match(fileOf(plan, 'WORKFLOW.md'), /利用範囲: \(未回答: 必須\)/);
  assert.throws(() => generateToDir({ plan, outDir: path.join(tmp, 'none'), confirmDigest: plan.digest }), GenerateError);
  const dir = gen(planFor());
  assert.throws(() => applyToDir({ plan, targetDir: dir, confirmDigest: plan.digest }), /audience/);
  assert.throws(() => validateConfig(baseConfig({ audience: 'everyone' })), /audience は personal \| company \| public/);
  assert.throws(() => validateConfig(baseConfig({ audience: true })), /audience: 文字列/);
});

test('どの利用範囲でも、全モードの正本と製品説明に入り、監査の指摘は出ない。決まりは範囲ごとに違う', () => {
  const element = STANDARD_ELEMENTS.find((e) => e.id === 'audience');
  const sections = new Set();
  for (const audience of AUDIENCE_NAMES) {
    for (const mode of MODE_NAMES) {
      const plan = planFor({ audience, mode, handoff: MODES[mode].solo ? undefined : 'manual' });
      assert.equal(plan.canGenerate, true);
      const wf = fileOf(plan, 'WORKFLOW.md');
      assert.ok(wf.includes(element.marker), `${audience} ${mode}`);
      assert.ok(wf.includes(`- 利用範囲: ${AUDIENCES[audience]} (この案件の設定`), `${audience} ${mode}`);
      assert.ok(fileOf(plan, 'PROJECT.md').includes(`## 利用範囲\n\n- ${AUDIENCES[audience]} `));
      assert.match(planSummary(plan), new RegExp(`利用範囲: ${AUDIENCES[audience]}`));
      sections.add(wf.slice(wf.indexOf(element.marker), wf.indexOf('## 引継ぎ')));
      assert.deepEqual(auditTarget(gen(plan)).findings, [], `${audience} ${mode}`);
    }
  }
  assert.equal(sections.size, AUDIENCE_NAMES.length);
  const wfOf = (audience) => fileOf(planFor({ audience }), 'WORKFLOW.md');
  assert.match(wfOf('company'), /社外のサービスや公開の場所へ送らない/);
  assert.match(wfOf('public'), /一般の人が使う・見る/);
  assert.match(wfOf('public'), /プライバシーポリシー/);
  assert.match(wfOf('public'), /この設定は公開の承認ではない/);
  assert.match(wfOf('personal'), /\/project-change で利用範囲を変える/);
});

test('更新後の対応: 利用範囲が変わった・初めて決まったときだけ並べる', () => {
  const cfg = (ov) => validateConfig(baseConfig(ov)).config;
  assert.deepEqual(settingFollowups(cfg({ audience: 'personal' }), cfg({ audience: 'personal' })), []);
  const changed = settingFollowups(cfg({ audience: 'personal' }), cfg({ audience: 'public' }));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /利用範囲: 「公開」になった/);
  const { audience, ...old } = baseConfig();
  const before = parseConfigText(JSON.stringify(old), { previous: true });
  assert.match(settingFollowups(before, cfg({ audience: 'company' }))[0], /「会社用」になった/);
});
