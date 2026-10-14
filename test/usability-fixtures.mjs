// 生成文書の実用性の評価ケース (docs/VERIFICATION.md の「生成文書の使いやすさ」)。
// 合成 fixture による構造・整合・保存・判定の検査。生成器のテスト (*.test.mjs) とは分けて実行する:
//   node test/usability-fixtures.mjs [--dump <新規フォルダ>]
// temp 内だけで動き、ネットワーク・課金・AI 起動なし。AI が実際に文書を読んで動く挙動 (第二段階) は確認しない。
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir, regenerateToDir, diffAgainstExisting } from '../src/generate.mjs';
import { planApply, applyToDir } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp('psw-usability-');
const UNDECIDED = { tech: '', verifyCommands: [], phases: [], outOfScope: [], permissions: { allowedPaths: [], forbidden: [] } };
const planFor = (mode, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', ...ov })));
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `f${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}
const read = (dir, name) => readText(path.join(dir, name));
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const cats = (dir) => auditTarget(dir).findings.filter((f) => f.severity !== 'info').map((f) => f.category);
const addResult = (dir, row) => fs.appendFileSync(path.join(dir, 'VALIDATION.md'), `${row}\n`);
const markDone = (dir, id, evidence = 'logs/result.txt') => write(dir, 'TASKS.md', read(dir, 'TASKS.md').replace(`- [ ] ${id} `, `- [x] ${id} 証跡: ${evidence} `));
const addTask = (dir, line) => write(dir, 'TASKS.md', read(dir, 'TASKS.md').replace('## 段階', `${line}\n\n## 段階`));
const otherModes = (mode) => MODE_NAMES.filter((m) => m !== mode);

// 各ケース: (mode) => [ [確認項目, 合否(boolean)], ... ]
const SCENARIOS = [
  {
    id: 'S1',
    title: '未知の技術構成・空の新規案件',
    run(mode) {
      const dir = gen(planFor(mode, UNDECIDED));
      const t = read(dir, 'TASKS.md');
      const v = read(dir, 'VALIDATION.md');
      const init = t.slice(t.indexOf('## 初期確認'), t.indexOf('## 課題'));
      return [
        ['未定を未定のまま残す (技術・検証・編集範囲)', (init.match(/\(未定\)/g) || []).length === 3 && v.includes('(未定)')],
        ['架空のスクリプトや手順を出さない', !/npm|yarn|pnpm|pytest|make |build/i.test(v + t)],
        ['初期権限と最初の課題を 1 回の確認にまとめる', (init.match(/^- \[ \]/gm) || []).length === 1 && init.includes('MVP の課題 (T-003) の合格条件') && init.includes('承認記録:')],
        ['未定の間の編集範囲が正本で定義されている', /記録がなければ編集しない/.test(read(dir, 'WORKFLOW.md'))],
        ['生成直後の監査が検出 0', auditTarget(dir).findings.length === 0],
      ];
    },
  },
  {
    id: 'S2',
    title: '実在する検証方法',
    run(mode) {
      const dir = gen(planFor(mode, { verifyCommands: ['node --test'] }));
      const v = read(dir, 'VALIDATION.md');
      const candidate = v.slice(v.indexOf('## 検証コマンドの候補'), v.indexOf('## 検証レシピ'));
      // レシピを登録し、T-001 に OK の結果を対応づけて完了にする
      write(dir, 'VALIDATION.md', v.replace('| | | | | | | |\n\n## 受け入れ基準', '| V1 | node --test | test/app.test.mjs が存在 | 案件ルート | Node 22 | T-001 の経路 | 1 件以上が実行され全件成功 |\n\n## 受け入れ基準'));
      addResult(dir, '| 2026-10-11 | T-001 | OK | logs/t1.txt | 自己確認 | a1b2c3 | Node 22 / 4 件 / 留保なし |');
      markDone(dir, 'T-001');
      return [
        ['入力コマンドは「実在未確認の候補」と表示', /実在未確認/.test(candidate) && candidate.includes('node --test')],
        ['レシピ欄に根拠・実行場所・前提・対象・期待結果がある', ['実在の根拠', '実行場所', '前提', '確認する対象', '期待結果'].every((c) => v.includes(c))],
        ['承認不要は登録済みレシピだけ', /検証レシピに登録済みの検証の実行/.test(read(dir, 'WORKFLOW.md'))],
        ['レシピ登録 + T-001 の OK 結果 + 証跡つき完了は監査を通る', cats(dir).length === 0],
      ];
    },
  },
  {
    id: 'S3',
    title: 'ゼロ件成功 / 失敗 / 環境不能',
    run(mode) {
      const out = [];
      for (const [result, note] of [['実行成功', '0 件'], ['NG', '2 件失敗'], ['環境不能', 'ブラウザなし'], ['未実行', '-']]) {
        const dir = gen(planFor(mode));
        addResult(dir, `| 2026-10-11 | T-001 | ${result} | logs/t1.txt | 自己確認 | a1b2c3 | ${note} |`);
        markDone(dir, 'T-001');
        out.push([`結果「${result}」(${note}) のまま [x] にすると監査が検出`, cats(dir).includes('done-but-validation-failed')]);
      }
      const v = read(gen(planFor(mode)), 'VALIDATION.md');
      out.push(['0 件成功を合格にしない規則と、結果の語彙が文書にある', /実行件数が 0 の成功/.test(v) && ['実行成功', '未実行', '環境不能'].every((w) => v.includes(w))]);
      return out;
    },
  },
  {
    id: 'S4',
    title: '多数テスト成功、2 ユーザー主要フロー未検証',
    run(mode) {
      const dir = gen(planFor(mode));
      addTask(dir, '- [ ] #t2 2 人の参加者が同じ部屋でメッセージを交換できる (合成の通信要件)\n  - 合格条件: 参加者 A と B の双方の画面に相手の発言が出る\n  - 検証: 手動確認 (2 端末)');
      addResult(dir, '| 2026-10-11 | T-001 | OK | logs/unit.txt | 自己確認 | a1b2c3 | 120 件成功 |');
      addResult(dir, '| 2026-10-11 | #t2 | 実行成功 | logs/unit.txt | 自己確認 | a1b2c3 | 120 件成功。2 端末では未確認 |');
      markDone(dir, 'T-001');
      markDone(dir, '#t2', 'logs/unit.txt');
      const f = auditTarget(dir).findings.filter((x) => x.category === 'done-but-validation-failed');
      return [
        ['単体テスト成功だけの #t2 を完了にすると監査が検出し、T-001 は通る', f.length === 1 && /#t2/.test(f[0].evidence)],
        ['「合格条件の経路を通っていない成功は OK ではない」が文書にある', /合格条件の経路を通っていない成功/.test(read(dir, 'VALIDATION.md'))],
        ['課題ごとに合格条件を書く欄がある', /^ {2}- 合格条件: /m.test(read(dir, 'TASKS.md'))],
      ];
    },
  },
  {
    id: 'S5',
    title: '成果物へ実験コード混入',
    run(mode) {
      const dir = gen(planFor(mode));
      addTask(dir, '- [ ] #t3 配布 zip を作る\n  - 合格条件: 採用した変更だけが含まれる\n  - 検証: zip の一覧を採用範囲と照合');
      addResult(dir, '| 2026-10-11 | #t3 | NG | logs/zip-list.txt | 自己確認 | a1b2c3 | 機能試験は成功。experiments/ が混入 |');
      markDone(dir, '#t3', 'logs/zip-list.txt');
      return [
        ['受け入れ基準に成果物の採用範囲の確認がある', /採用していない変更や実験用のファイルが含まれない/.test(read(dir, 'VALIDATION.md'))],
        ['混入で NG の #t3 を完了にすると監査が検出', cats(dir).includes('done-but-validation-failed')],
      ];
    },
  },
  {
    id: 'S6',
    title: 'ユーザー編集と途中進捗がある regenerate / apply',
    run(mode) {
      const out = [];
      for (const to of otherModes(mode)) {
        const dir = gen(planFor(mode));
        addResult(dir, '| 2026-10-11 | T-001 | OK | logs/t1.txt | 自己確認 | a1b2c3 | 4 件 |');
        markDone(dir, 'T-001');
        addTask(dir, '- [ ] #t9 自分で足した未完了の課題 (作業中)');
        const tasks = read(dir, 'TASKS.md');
        const validation = read(dir, 'VALIDATION.md');
        const plan2 = planFor(to);
        // 別フォルダ (regenerate): 進捗を引き継ぎ、元は不変
        const d = diffAgainstExisting(plan2, dir);
        const dst = path.join(tmp, `r${++seq}`);
        regenerateToDir({ plan: plan2, fromDir: dir, outDir: dst, confirmDigest: d.confirmDigest });
        const regenOk = read(dst, 'TASKS.md') === tasks && read(dst, 'VALIDATION.md') === validation && read(dir, 'TASKS.md') === tasks;
        // 確認後に元が変わると古い承認は使えない
        const rep = planApply(plan2, dir);
        fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] #t10 確認後に足した課題\n');
        let stale = false;
        try {
          applyToDir({ plan: plan2, targetDir: dir, confirmDigest: rep.confirmDigest });
        } catch {
          stale = true;
        }
        // 直接更新 (apply): 進捗を残し、役割を切り替える
        const tasks2 = read(dir, 'TASKS.md');
        const rep2 = planApply(plan2, dir);
        const r = applyToDir({ plan: plan2, targetDir: dir, confirmDigest: rep2.confirmDigest });
        // 課題表は既存の行を変えず、末尾に「ウィザード更新後の対応」(役割の変更にともなう作業) だけが足される
        const tasks3 = read(dir, 'TASKS.md');
        const tasksOk = tasks3.startsWith(tasks2) && tasks3.slice(tasks2.length).includes('## ウィザード更新後の対応') && read(path.join(r.backupDir), 'TASKS.md') === tasks2;
        const applyOk = tasksOk && read(dir, 'VALIDATION.md') === validation && fs.existsSync(path.join(r.backupDir, 'WORKFLOW.md'));
        const roleOk = new RegExp(`^- 主導: ${MODES[to].lead}$`, 'm').test(read(dir, 'WORKFLOW.md'));
        const clean = (x) => cats(x).filter((c) => c !== 'done-without-id');
        out.push([`→ ${to}: 別フォルダ生成が完了証拠・未完了課題・結果記録を引き継ぎ、元は不変`, regenOk]);
        out.push([`→ ${to}: 確認後の変更で古い承認を拒否`, stale]);
        out.push([`→ ${to}: 直接更新が進捗を残し、変更前をバックアップし、役割を切り替える`, applyOk && roleOk]);
        out.push([`→ ${to}: 役割変更後、古い担当の記述や不在担当への言及が残らない (両経路で監査 0)`, clean(dir).length === 0 && clean(dst).length === 0]);
      }
      return out;
    },
  },
  {
    id: 'S7',
    title: '欠落参照と矛盾',
    run(mode) {
      const m = MODES[mode];
      const entry = ENTRY_FILE[m.lead];
      // 欠落
      const a = gen(planFor(mode));
      fs.rmSync(path.join(a, 'VALIDATION.md'));
      const before = fs.readdirSync(a).sort().join(',');
      const ca = cats(a);
      const noRestore = fs.readdirSync(a).sort().join(',') === before;
      // 入口と正本の矛盾
      const b = gen(planFor(mode));
      write(b, entry, read(b, entry).replace(/^- 役割: .+$/m, `- 役割: ${m.solo ? '主導・レビュー' : '実装'}`));
      // 不在担当待ち (単独モードに相手の名前が残る)
      let absent = true;
      if (m.solo) {
        const c = gen(planFor(mode));
        const absentName = m.lead === 'Claude' ? 'Codex' : 'Claude';
        fs.appendFileSync(path.join(c, 'TASKS.md'), `\n- [ ] #t5 ${absentName} のレビューを待つ\n`);
        absent = cats(c).includes('absent-agent-reference');
      }
      const e = read(gen(planFor(mode)), entry);
      return [
        ['文書の欠落を検出 (欠落ファイル・リンク切れ)', ca.includes('missing-file') && ca.includes('broken-link')],
        ['監査は復元しない', noRestore],
        ['入口と正本の役割矛盾を検出', cats(b).includes('role-contradiction')],
        [m.solo ? '単独モードでの不在担当待ちを検出' : '(協働モード: 不在担当は該当なし)', absent],
        ['入口に「止めて、欠けている箇所と必要な判断を示す。権限を作らない」がある', /その作業を止め、欠けている箇所と必要な判断をユーザーに示す/.test(e) && /権限を作ったりしない/.test(e)],
      ];
    },
  },
  {
    id: 'S8',
    title: '次セッションで再開',
    run(mode) {
      const m = MODES[mode];
      const dir = gen(planFor(mode));
      const t = read(dir, 'TASKS.md');
      const memo = t.slice(t.indexOf('## 再開メモ'), t.indexOf('## 完了済み'));
      const entries = m.agents.map((a) => read(dir, ENTRY_FILE[a]));
      const wf = read(dir, 'WORKFLOW.md');
      return [
        ['再開メモに対象版・変更・証拠・留保・次作業の欄がある', ['対象版', '直近の変更', '証拠', '留保・未検証', '次の作業と開始条件'].every((k) => memo.includes(`- ${k}:`))],
        ['すべての入口が再開時に読むもの (再開メモ・未完了課題・直近の結果) を示す', entries.every((e) => /^- 再開時: .*再開メモ.*未完了課題.*直近の結果/m.test(e))],
        ['手順に再開メモの更新がある', /「再開メモ」を更新する/.test(wf)],
        ['開始文なしで再開できると明記', /2 回目以降は貼らなくても/.test(read(dir, 'START.md'))],
        ['再開メモに秘密を書かない注意がある', /秘密・認証情報は書かない/.test(memo)],
        [m.solo ? '自己確認を独立レビューと誤記しない' : '独立レビューの担当が実在する担当', m.solo ? /独立レビュー: なし/.test(wf) && /自己確認/.test(read(dir, 'VALIDATION.md')) : new RegExp(`独立レビュー: あり — ${m.reviewer}`).test(wf)],
      ];
    },
  },
];

const dumpIdx = process.argv.indexOf('--dump');
const dumpDir = dumpIdx > -1 ? process.argv[dumpIdx + 1] : null;
let failed = 0;
const lines = ['| ケース | ' + MODE_NAMES.join(' | ') + ' |', '| --- |' + MODE_NAMES.map(() => ' --- |').join('')];
const details = [];
try {
  for (const s of SCENARIOS) {
    const cells = [];
    for (const mode of MODE_NAMES) {
      let checks;
      try {
        checks = s.run(mode);
      } catch (e) {
        checks = [[`実行時エラー: ${e.message}`, false]];
      }
      const bad = checks.filter(([, ok]) => !ok);
      failed += bad.length;
      cells.push(`${checks.length - bad.length}/${checks.length}`);
      for (const [label] of bad) details.push(`- NG ${s.id} / ${mode}: ${label}`);
      if (mode === MODE_NAMES[0]) details.push(`\n${s.id} ${s.title} の確認項目:\n` + checks.map(([label]) => `  - ${label}`).join('\n'));
    }
    lines.push(`| ${s.id} ${s.title} | ${cells.join(' | ')} |`);
  }
  // 文書量 (文字数) の参考値
  const sizes = MODE_NAMES.map((mode) => {
    const p = planFor(mode);
    return `${mode}: ` + p.files.filter((f) => f.path.endsWith('.md')).map((f) => `${f.path} ${f.content.length}`).join(', ');
  });
  process.stdout.write(lines.join('\n') + '\n' + details.join('\n') + '\n\n文書量 (文字数):\n' + sizes.map((x) => `- ${x}`).join('\n') + '\n');
  if (dumpDir) {
    if (fs.existsSync(dumpDir)) throw new Error(`--dump 先が既に存在します: ${dumpDir}`);
    fs.mkdirSync(dumpDir, { recursive: true });
    for (const mode of MODE_NAMES) {
      for (const [label, ov] of [['set', {}], ['undecided', UNDECIDED]]) {
        const p = planFor(mode, ov);
        generateToDir({ plan: p, outDir: path.join(dumpDir, `${mode}-${label}`), confirmDigest: p.digest });
      }
    }
    process.stdout.write(`\n読み取り用の生成物: ${dumpDir}\n`);
  }
  process.stdout.write(`\n合計 NG: ${failed}\n`);
} finally {
  cleanup(tmp);
}
process.exitCode = failed ? 1 : 0;
