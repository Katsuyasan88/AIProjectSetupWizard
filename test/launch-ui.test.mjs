// 別AIの起動 (launchPolicy)、モデルの代わりの順番 (fallbackModels)、画面の実装の基本 (uiRules)。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan, planSummary } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { auditTarget } from '../src/audit.mjs';
import { normalizeAiPreferences } from '../src/ai-preferences.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE, STANDARD_ELEMENTS } from '../src/constants.mjs';
import { PROFILES, launchRewrites } from '../src/render-profile.mjs';
import { makeTmp, cleanup, baseConfig } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, profile, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', profile, ...ov })));
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
const all = (plan) => plan.files.filter((f) => f.path.endsWith('.md')).map((f) => f.content).join('\n');
const COLLAB = MODE_NAMES.filter((m) => !MODES[m].solo);
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `l${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}

test('別AIの起動: 協働モードの既定は主導担当による起動。単独モードは常に毎回承認。知らない値は拒否する', () => {
  const { launchPolicy, ...noKey } = baseConfig();
  for (const mode of MODE_NAMES) {
    const v = validateConfig({ ...noKey, mode, handoff: MODES[mode].solo ? undefined : 'manual' });
    assert.equal(v.config.launchPolicy, MODES[mode].solo ? 'approval' : 'lead-launch', `${mode}: 項目がないときの既定`);
    assert.ok(!v.warnings.some((w) => /launchPolicy/.test(w)), `${mode}: 既定のままなら知らせない`);
    const wf = fileOf(buildPlan(v), 'WORKFLOW.md');
    assert.equal(wf.includes('## 実装担当の起動'), !MODES[mode].solo, `${mode}: 既定の正本`);
  }
  assert.throws(() => validateConfig(baseConfig({ launchPolicy: 'always' })), /launchPolicy/);
  const solo = validateConfig(baseConfig({ mode: 'claude-solo', handoff: undefined, launchPolicy: 'lead-launch' }));
  assert.equal(solo.config.launchPolicy, 'approval');
  assert.ok(solo.warnings.some((w) => /launchPolicy/.test(w)));
  // 毎回承認を選んだ案件と単独モードでは、起動を緩める文は入らない
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const text = all(planFor(mode, profile));
      assert.ok(/^- 別AIの起動: .*毎回ユーザーの明示承認が要る。$/m.test(fileOf(planFor(mode, profile), 'WORKFLOW.md')), `${mode}/${profile}`);
      assert.ok(!text.includes('## 実装担当の起動') && !text.includes('範囲を除く'), `${mode}/${profile}: 毎回承認では緩めない`);
    }
  }
});

test('別AIの起動: lead-launch は主導担当による実装担当の起動だけを範囲つきで認め、ほかの承認は変えない', () => {
  for (const mode of COLLAB) {
    const { lead, implementer: impl } = MODES[mode];
    for (const profile of PROFILES) {
      for (const pushPolicy of ['approval', 'work-branch']) {
        const strict = planFor(mode, profile, { pushPolicy });
        const open = planFor(mode, profile, { pushPolicy, launchPolicy: 'lead-launch' });
        const tag = `${mode}/${profile}/${pushPolicy}`;
        assert.notEqual(strict.digest, open.digest, tag);
        const s = all(strict);
        const w = all(open);
        // 置き換え漏れがない
        for (const [from, to] of launchRewrites(MODES[mode])) {
          assert.ok(s.includes(from), `${tag}: 「${from}」が既定の文書にない`);
          assert.ok(w.includes(to), `${tag}: 「${to.slice(0, 24)}…」に置き換わっていない`);
          if (!to.includes(from)) assert.ok(!w.includes(from), `${tag}: 「${from}」が置き換わらずに残っている`);
        }
        const wf = fileOf(open, 'WORKFLOW.md');
        const sec = wf.slice(wf.indexOf('## 実装担当の起動'), wf.indexOf('## 手順'));
        assert.ok(sec.includes(`${lead} は ${impl} を起動して課題を渡してよい`), tag);
        for (const key of ['範囲:', '含まれない承認:', '起動の設定:', '結果の扱い:', '肩代わり:', '拒否の扱い:', '終了の確認:']) assert.ok(sec.includes(`- ${key}`), `${tag}: ${key}`);
        assert.ok(/さらに別の AI を起動することは含まない/.test(sec) && /実装ファイルを編集する許可ではない/.test(sec) && /迂回せず/.test(sec), tag);
        assert.ok(/公開、マージ、作業ブランチ以外への push、依存追加、編集許可パス外の編集、費用を伴う操作/.test(sec), tag);
        assert.ok(/T-000/.test(sec) && !/#t0/.test(sec), `${tag}: 課題 ID の表記`);
        // 緩めるのは起動だけ
        assert.ok(/外部公開、/.test(wf) && /依存追加、権限・認証設定の変更、編集許可パス外の編集/.test(wf) && /秘密・認証情報/.test(wf), tag);
        assert.ok(fileOf(open, ENTRY_FILE[lead]).includes(`${impl} を起動して課題を渡すときは`), tag);
        assert.ok(fileOf(open, ENTRY_FILE[impl]).includes(`${lead} から起動されて作業するときも、承認規則は同じ`), tag);
        assert.ok(fileOf(open, 'START.md').includes(`${lead} は、WORKFLOW.md の「実装担当の起動」の範囲内で ${impl} を起動して課題を渡せます`), tag);
        const tasks = fileOf(open, 'TASKS.md');
        assert.ok(/- 実装担当の起動: 起動の手段と、範囲が/.test(tasks) && !/Codex|Claude/.test(tasks), `${tag}: 初期確認`);
        assert.ok(!fileOf(strict, 'TASKS.md').includes('実装担当の起動'), tag);
      }
    }
    for (const handoff of ['manual', 'cli']) {
      const plan = planFor(mode, 'full', { handoff, launchPolicy: 'lead-launch', layout: 'folders' });
      assert.ok(!all(plan).includes('各AIの起動はユーザーが明示的に行います'), `${mode}/${handoff}: 矛盾する文が残っている`);
      assert.deepEqual(auditTarget(gen(plan)).findings, [], `${mode}/${handoff}`);
      assert.ok(/別AIの起動: 主導担当が範囲内で起動してよい/.test(planSummary(plan)));
    }
  }
});

test('モデルの代わりの順番: 設定に持ち、START に順番つきで出す。形の合わない値は拒否する', () => {
  const ai = { codex: { model: 'model-a', effort: 'medium', fallbackModels: ['model-b', ' model-c ', 'model-b', 'model-a'] } };
  assert.deepEqual(normalizeAiPreferences(ai).codex.fallbackModels, ['model-b', 'model-c']);
  assert.deepEqual(normalizeAiPreferences({}).claude.fallbackModels, []);
  for (const bad of ['model-b', [1], ['x; echo injected'], ['$(evil)'], Array.from({ length: 6 }, (_, i) => `m${i}`)]) {
    assert.throws(() => normalizeAiPreferences({ codex: { fallbackModels: bad } }), /fallbackModels/);
  }
  const base = planFor('claude-led', 'standard');
  const plan = planFor('claude-led', 'standard', { ai });
  assert.notEqual(base.digest, plan.digest);
  const start = fileOf(plan, 'START.md');
  assert.ok(start.includes('- Codex: モデル model-a / effort medium / 代わり: model-b → model-c'));
  assert.ok(/^- Claude: モデル \(既定\) \/ effort \(既定\)$/m.test(start));
  assert.ok(/代わりが書かれていなければ、別のモデルへ切り替える前にユーザーに確かめます/.test(start) && /実際に使ったモデルを記録/.test(start));
  assert.ok(fileOf(base, 'START.md').includes('代わりが書かれていなければ'), '代わりがなくても決まりは入る');
  assert.ok(!start.includes('codex --model "model-b"'), '起動例は指定のモデルだけ');
  assert.ok(/Codex: model model-a \/ effort medium \/ 代わり model-b → model-c/.test(planSummary(plan)));
});

test('画面の実装の基本: 既定では入らない。uiRules を選ぶと、全モード・全段階の正本と入口に入る', () => {
  assert.equal(validateConfig(baseConfig()).config.uiRules, false);
  assert.throws(() => validateConfig(baseConfig({ uiRules: 'yes' })), /uiRules/);
  const elements = STANDARD_ELEMENTS.filter((e) => e.setting === 'uiRules');
  assert.equal(elements.length, 1);
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const off = planFor(mode, profile);
      const on = planFor(mode, profile, { uiRules: true });
      const tag = `${mode}/${profile}`;
      assert.notEqual(off.digest, on.digest, tag);
      assert.ok(!all(off).includes('画面の実装の基本') && !all(off).includes('デザインルール'), `${tag}: 既定では入らない`);
      for (const e of elements) assert.ok(fileOf(on, e.file).includes(e.marker), `${tag}: ${e.id}`);
      const wf = fileOf(on, 'WORKFLOW.md');
      const sec = wf.slice(wf.indexOf('## 画面の実装の基本'), wf.indexOf('## ', wf.indexOf('## 画面の実装の基本') + 5));
      assert.equal((sec.match(/^- /gm) || []).length, 6, tag);
      assert.ok(/デザインはユーザーと一緒に決める/.test(sec) && /文書は最初に決まったときに作る/.test(sec) && /決まっていないことを推測で書かない/.test(sec), `${tag}: 正本は決めながら育てる`);
      assert.ok(/画面のコードに直接書かない/.test(sec) && /共通部品の組み合わせで作る/.test(sec) && /検証レシピに登録する/.test(sec) && /空・読み込み中・エラーの状態/.test(sec), tag);
      assert.ok(wf.indexOf('## 画面の実装の基本') > wf.indexOf('## 手順') && wf.indexOf('## 画面の実装の基本') < wf.indexOf('## 変更の扱い'), tag);
      for (const a of MODES[mode].agents) assert.ok(/^- 画面を変える前: /m.test(fileOf(on, ENTRY_FILE[a])), `${tag}/${a}`);
      // 最初から正本の文書を用意しない (基本ドキュメントの目安に足さない)
      assert.ok(!fileOf(on, 'TASKS.md').includes('デザイン'), `${tag}: 課題表`);
      const context = fileOf(on, 'CONTEXT.md');
      if (profile === 'minimal') assert.ok(context === null && /TASKS\.md\) の再開メモ に書く/.test(sec), tag);
      else assert.ok(context.includes('## 表示の値と文言の入口・共通部品・デザインルールの正本の場所') && !fileOf(off, 'CONTEXT.md').includes('表示の値'), tag);
    }
    assert.deepEqual(auditTarget(gen(planFor(mode, 'standard', { uiRules: true, layout: 'folders' }))).findings, [], mode);
  }
});
