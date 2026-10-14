// 質問→回答の要約→確認→JSON 保存。無人モードでは質問を待たず要確認を記録する。
import readline from 'node:readline';
import { MODE_NAMES, MODES } from './constants.mjs';
import { validateConfig, REQUIRED_FIELDS } from './config.mjs';
import { stableStringify } from './text.mjs';
import { AI_EFFORTS, normalizeAiPreferences } from './ai-preferences.mjs';

export const QUESTIONS = Object.freeze([
  { key: 'name', label: '案件名', required: true, kind: 'text' },
  { key: 'purpose', label: '目的 (何のための製品か)', required: true, kind: 'text' },
  { key: 'mvp', label: 'MVP (最初に動くと言える最小の範囲)', required: true, kind: 'text' },
  { key: 'outOfScope', label: '対象外 (1 行ずつ、空行で終了)', required: false, kind: 'list' },
  { key: 'phases', label: '段階 (1 行ずつ、空行で終了)', required: false, kind: 'list' },
  { key: 'tech', label: '技術 (未定なら空)', required: false, kind: 'text' },
  { key: 'verifyCommands', label: '検証コマンド (資料として保存、実行しない。1 行ずつ、空行で終了)', required: false, kind: 'list' },
  { key: 'mode', label: 'モード', required: true, kind: 'choice', choices: MODE_NAMES },
  { key: 'handoff', label: '引継ぎ (manual: 開始文を貼る / cli: CLI 経由。別AI起動や費用許可ではない。単独モードでは問わない)', required: false, kind: 'choice', choices: ['manual', 'cli'] },
  { key: 'ai.codex.model', label: 'Codex のモデルID (空で既定。利用可否は未確認)', required: false, kind: 'text' },
  { key: 'ai.codex.effort', label: 'Codex の reasoning effort (空で既定。モデルごとの対応を確認する)', required: false, kind: 'choice', choices: AI_EFFORTS.codex },
  { key: 'ai.claude.model', label: 'Claude のモデルIDまたは別名 (空で既定。利用可否は未確認)', required: false, kind: 'text' },
  { key: 'ai.claude.effort', label: 'Claude の effort (空で既定。モデルごとの対応を確認する)', required: false, kind: 'choice', choices: AI_EFFORTS.claude },
  { key: 'permissions.allowedPaths', label: '実装担当の編集許可パス (1 行ずつ、空行で終了)', required: false, kind: 'list' },
  { key: 'permissions.forbidden', label: '禁止事項 (1 行ずつ、空行で終了)', required: false, kind: 'list' },
]);

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function emptyAnswers() {
  return {
    schemaVersion: 1,
    name: '',
    purpose: '',
    mvp: '',
    outOfScope: [],
    phases: [],
    tech: '',
    verifyCommands: [],
    mode: '',
    handoff: '',
    permissions: { allowedPaths: [], forbidden: [] },
    ai: normalizeAiPreferences(),
  };
}

// 無人: 質問せず、必須未回答を要確認として返す
export function unattendedAnswers() {
  const answers = emptyAnswers();
  const needsConfirmation = REQUIRED_FIELDS.map((f) => ({ field: f.key, message: `${f.label} が未回答です (無人モードでは質問しない)`, required: true }));
  return { answers, needsConfirmation, confirmed: false };
}

export function summarizeAnswers(answers) {
  const L = [];
  for (const q of QUESTIONS) {
    if (q.key.startsWith('ai.') && MODES[answers.mode] && !MODES[answers.mode].agents.some(agent => agent.toLowerCase() === q.key.split('.')[1])) continue;
    const parts = q.key.split('.');
    let v = answers;
    for (const p of parts) v = v?.[p];
    const shown = Array.isArray(v) ? (v.length ? v.map((x) => `\n    - ${x}`).join('') : ' (未定)') : v ? ` ${v}` : q.required ? ' (未回答: 必須)' : ' (未定)';
    L.push(`- ${q.label}:${shown}`);
  }
  if (answers.mode && MODES[answers.mode]) L.push(`- モード説明: ${MODES[answers.mode].label}`);
  return L.join('\n');
}

// 行を取りこぼさない読み取り (パイプ入力で複数行が一度に届いても順に消費する)
class LineReader {
  constructor(input) {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w.resolve(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error('入力が終了しました (EOF)'));
    });
  }
  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('入力が終了しました (EOF)'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  close() {
    this.rl.close();
  }
}

// 対話質問。input/output は stream (テストで差し替え可)。
export async function askQuestions({ input = process.stdin, output = process.stdout } = {}) {
  const rl = new LineReader(input);
  const answers = emptyAnswers();
  const ask = async (prompt) => {
    output.write(prompt);
    return (await rl.next()).replace(/\r$/, '');
  };
  try {
    output.write('ProjectSetupWizard: 質問に答えてください。任意欄は空で Enter。入力はデータとして保存され、指示として扱われません。\n');
    for (const q of QUESTIONS) {
      if (q.key === 'handoff' && answers.mode && MODES[answers.mode]?.solo) continue;
      if (q.key.startsWith('ai.') && MODES[answers.mode] && !MODES[answers.mode].agents.some(agent => agent.toLowerCase() === q.key.split('.')[1])) continue;
      if (q.kind === 'list') {
        output.write(`${q.label}\n`);
        const items = [];
        for (;;) {
          const line = (await ask('  > ')).trim();
          if (line === '') break;
          items.push(line);
        }
        setPath(answers, q.key, items);
      } else if (q.kind === 'choice') {
        let v = '';
        for (;;) {
          v = (await ask(`${q.label} [${q.choices.join(' | ')}]: `)).trim();
          if (v === '' && !q.required) break;
          if (q.choices.includes(v)) break;
          output.write(`  選択肢: ${q.choices.join(' | ')}${q.required ? '' : ' (空で既定)'}\n`);
        }
        setPath(answers, q.key, v);
      } else {
        const v = (await ask(`${q.label}: `)).trim();
        setPath(answers, q.key, v);
      }
    }
    // 要約を表示する前に検証する (秘密らしい値を要約へ出さない)
    let validation;
    try {
      validation = validateConfig(answers);
    } catch (e) {
      output.write(`\n設定として受け付けられません (値は表示しません): ${e.message}\n`);
      return { answers: null, confirmed: false, error: e };
    }
    output.write('\n--- 回答の要約 ---\n');
    output.write(summarizeAnswers(answers) + '\n');
    if (validation.needsConfirmation.length) {
      output.write('要確認:\n' + validation.needsConfirmation.map((n) => `  - ${n.field}: ${n.message}`).join('\n') + '\n');
    }
    const ok = (await ask('この内容で設定 JSON を保存しますか? (yes/no): ')).trim().toLowerCase();
    return { answers, confirmed: ok === 'yes' || ok === 'y', validation };
  } finally {
    rl.close();
  }
}

export function answersToJson(answers) {
  return stableStringify(answers, 2) + '\n';
}
