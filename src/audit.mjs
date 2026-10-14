// audit: 指定案件への読取診断だけ。入力文書は不信な資料として扱い、値を転記せず、apply しない。
import fs from 'node:fs';
import path from 'node:path';
import {
  MODES,
  ENTRY_FILE,
  CONFIG_FILE_NAME,
  MANIFEST_FILE_NAME,
} from './constants.mjs';
import { validateConfig, detectSecretPatterns, redactSecrets } from './config.mjs';
import { buildPlan } from './plan.mjs';
import { formatDiff } from './diff.mjs';
import { sha256Hex } from './text.mjs';
import {
  resolveLocal,
  isInside,
  isDirNoLink,
  lstatSafe,
  hasLinkComponent,
  hasDeniedSegment,
  hasDeniedSegmentAbs,
  isUncPath,
} from './safepath.mjs';
import { findExisting, baseName, toNative } from './layout.mjs';

export class AuditError extends Error {}

const CORE_FILES = ['PROJECT.md', 'WORKFLOW.md', 'TASKS.md', 'VALIDATION.md', 'START.md', 'AGENTS.md', 'CLAUDE.md', 'RULES.md', 'CONTEXT.md', 'USER_TESTS.md', 'BACKLOG.md'];
// 課題の ID: #t1 の形 (minimal) と、T-001 / U-001 / UT-001 の形 (standard 以上)
const TASK_ID_RE = /#[A-Za-z0-9_-]+|(?<![A-Za-z0-9])(?:UT|T|U)-[0-9]{1,6}(?![0-9])/g;
const KNOWN_GENERATED = new Set([CONFIG_FILE_NAME, ...CORE_FILES]);
const CONTRACT_FILES = new Set(['WORKFLOW.md', 'AGENTS.md', 'CLAUDE.md', 'START.md', 'RULES.md']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// OK 以外の結果 (実行成功 = 実行は通ったが合格条件は未確認)
const NOT_ACCEPTED_RE = /NG|未確認|未実行|実行成功|環境不能|失敗|不明/i;
const EMPTY_EVIDENCE_RE = /^(なし|無し|none|n\/a|-|―|未確認|未|tbd|\?)$/i;

export const CATEGORY_LABEL = Object.freeze({
  'broken-link': '参照切れ',
  'role-contradiction': '役割/編集権限の矛盾',
  'entry-missing-reference': '入口が正本 (WORKFLOW.md) を参照していない',
  'absent-agent-reference': '存在しない担当への言及 (単独モード)',
  'done-but-unverified': '[x] なのに未確認',
  'done-without-evidence': '[x] なのに証跡なし (空/なし/未確認を含む)',
  'done-but-validation-failed': '[x] なのに VALIDATION.md の同じ #id が OK 以外',
  'done-without-id': '[x] なのに #id がない (結果記録と対応づけられない)',
  'secret-like': '秘密らしい記述 (値は非表示)',
  'manifest-changed': 'manifest との差分 (変更=違反ではない: 判断要/意図確認)',
  'manifest-missing-file': 'manifest 記載ファイルが存在しない',
  'config-invalid': '設定ファイルが無効',
  'config-mismatch': '設定とWORKFLOWのモード不一致 (判断要/意図確認)',
  'missing-file': '期待ファイルがない',
});

const JUDGEMENT_CATEGORIES = new Set(['manifest-changed', 'config-mismatch']);

function readTextSafe(target, rel, report) {
  const abs = path.resolve(target, rel);
  if (!isInside(target, abs)) return null;
  if (hasDeniedSegment(rel)) {
    report.skipped.push({ file: rel, reason: '秘密/認証/依存に該当する名前は読まない' });
    return null;
  }
  const st = lstatSafe(abs);
  if (!st) return null;
  if (st.isSymbolicLink() || hasLinkComponent(abs)) {
    report.skipped.push({ file: rel, reason: 'リンク (symlink/junction/reparse point) は追わない' });
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) {
    report.skipped.push({ file: rel, reason: 'サイズ上限超過' });
    return null;
  }
  return fs.readFileSync(abs, 'utf8');
}

function addFinding(report, f) {
  report.findings.push({ severity: 'warn', ...f, evidence: redactSecrets(f.evidence ?? '') });
}

function lineOf(text, re) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 1;
}

function extractLinks(text) {
  const out = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  text.split('\n').forEach((line, idx) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) out.push({ line: idx + 1, target: m[2] });
  });
  return out;
}

function isExternalLink(t) {
  return /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');
}

function parseWorkflowRoles(text) {
  const grab = (label) => {
    const m = text.match(new RegExp(`^- ${label}[:：]\\s*([A-Za-z]+)`, 'm'));
    return m ? m[1] : null;
  };
  const tag = text.match(/<!--\s*psw:workflow\s+mode=([a-z-]+)/);
  return {
    lead: grab('主導'),
    reviewer: grab('レビュー'),
    implementer: grab('実装'),
    taggedMode: tag ? tag[1] : null,
    leadLine: lineOf(text, /^- 主導[:：]/),
    implLine: lineOf(text, /^- 実装[:：]/),
  };
}

function parseEntryRole(text) {
  const m = text.match(/^- 役割[:：]\s*(.+)$/m);
  const role = m ? m[1].trim() : null;
  let roleId = null;
  if (role) {
    if (/単独/.test(role)) roleId = 'solo';
    else if (/主導/.test(role)) roleId = 'lead';
    else if (/実装/.test(role)) roleId = 'implementer';
  }
  return { role, roleId, line: lineOf(text, /^- 役割[:：]/), refersWorkflow: /WORKFLOW\.md/.test(text) };
}

// VALIDATION.md の結果表から #id → {result, line} を集める
function parseValidationResults(text) {
  const map = new Map();
  // 「## 結果記録」があればそれ以降の表だけを読む (検証レシピの表を結果と取り違えない)
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s*結果記録/.test(l));
  lines.forEach((line, i) => {
    if (i < start) return;
    if (!/^\s*\|/.test(line)) return;
    const cells = line.split('|').map((c) => c.trim());
    // 先頭/末尾の空セルを除く: [日付, 課題, 結果, 証跡, 確認者, ...] (後ろの列は増えてもよい)
    const body = cells.slice(1, -1);
    if (body.length < 3) return;
    const ids = body[1].match(TASK_ID_RE) || [];
    for (const id of ids) map.set(id, { result: body[2], line: i + 1 });
  });
  return map;
}

export function auditTarget(targetDir, { unattended = false } = {}) {
  if (isUncPath(targetDir)) throw new AuditError('UNC パスは対象にしません');
  const target = resolveLocal(targetDir, 'target');
  if (hasDeniedSegmentAbs(target)) throw new AuditError('対象の経路に秘密/認証/依存に該当する名前が含まれるため読みません');
  if (!isDirNoLink(target)) throw new AuditError(`対象フォルダが存在しないか、リンクを経由しています: ${target}`);

  const report = {
    target,
    unattended,
    scanned: [],
    skipped: [],
    findings: [],
    proposals: [],
    limits: [
      '機械的検査のみ。文書の意味的な矛盾や、記法から外れた役割記述は検出できない。',
      '秘密らしい記述はパターン一致のみ。見逃し・誤検知があり、値は報告に含めない。秘密らしい記述を含むファイルの修正差分案は抑止する。',
      '読むのは既知の生成物と、そこから明示されたローカル md リンク 1 段階だけ。外部 URL、UNC、対象外、リンク (symlink/junction、中間成分含む)、.env/鍵/.git/認証情報/依存ディレクトリは読まない。manifest は読取許可ではなく、既知ファイル以外は照合しない。',
      'manifest との差分は変更=違反としない。意図した変更かはユーザーが判断する。修正差分案は提示のみで apply しない。',
      '引用 (>) による自由文の分離はプロンプト注入の完全防止を保証しない。',
    ],
  };

  const texts = new Map();
  // where: 論理名 (WORKFLOW.md など) → 実際の相対パス (docs/WORKFLOW.md など)
  const where = new Map();
  const readCore = (name) => {
    const rel = findExisting(target, name) ?? name;
    const t = readTextSafe(target, toNative(rel), report);
    if (t !== null) {
      texts.set(name, t);
      where.set(name, rel);
      report.scanned.push(rel);
    }
    return t;
  };

  // 設定
  let validated = null;
  let cfg = null;
  const configText = readCore(CONFIG_FILE_NAME);
  if (configText !== null) {
    try {
      validated = validateConfig(JSON.parse(configText));
      cfg = validated.config;
    } catch (e) {
      const kinds = e.details?.length ? e.details.map((d) => d.replace(/:\s.*$/, '')) : ['JSON 解析失敗または構造エラー'];
      addFinding(report, { category: 'config-invalid', file: CONFIG_FILE_NAME, line: 1, evidence: kinds.join('; '), note: '設定が無効。値は転記しない。' });
    }
  } else {
    addFinding(report, { category: 'missing-file', file: CONFIG_FILE_NAME, line: 1, severity: 'info', evidence: '設定ファイルなし', note: '設定ベースの照合は省略。' });
  }

  // manifest
  let manifest = null;
  const manifestText = readCore(MANIFEST_FILE_NAME);
  if (manifestText !== null) {
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      addFinding(report, { category: 'config-invalid', file: MANIFEST_FILE_NAME, line: 1, evidence: 'JSON 解析失敗', note: '' });
    }
  }

  // 中核ファイル
  for (const name of CORE_FILES) readCore(name);
  if (cfg?.mode) {
    const m = MODES[cfg.mode];
    for (const agent of m.agents) {
      if (!texts.has(ENTRY_FILE[agent])) {
        addFinding(report, { category: 'missing-file', file: ENTRY_FILE[agent], line: 1, evidence: `モード ${cfg.mode} では ${agent} の入口が必要`, note: '' });
      }
    }
    for (const name of ['WORKFLOW.md', 'TASKS.md', 'VALIDATION.md', 'PROJECT.md']) {
      if (!texts.has(name)) addFinding(report, { category: 'missing-file', file: name, line: 1, evidence: '生成物に含まれるべきファイルがない', note: '' });
    }
  }

  // 明示ローカル md リンク (1 段階)
  const checkLinks = (name, text, allowRead) => {
    for (const l of extractLinks(text)) {
      const t = l.target.split('#')[0];
      if (t === '') continue;
      if (isExternalLink(t) || isUncPath(t)) {
        report.skipped.push({ file: name, line: l.line, reason: '外部/UNC リンクは追わない' });
        continue;
      }
      let abs;
      try {
        abs = path.resolve(path.dirname(path.join(target, toNative(where.get(name) ?? name))), decodeURI(t));
      } catch {
        addFinding(report, { category: 'broken-link', file: name, line: l.line, evidence: 'リンク先を解釈できない', note: '' });
        continue;
      }
      if (!isInside(target, abs)) {
        report.skipped.push({ file: name, line: l.line, reason: '対象外のパスは追わない' });
        continue;
      }
      const rel = path.relative(target, abs);
      if (hasDeniedSegment(rel)) {
        report.skipped.push({ file: name, line: l.line, reason: '秘密/認証/依存に該当する名前は読まない' });
        continue;
      }
      const st = lstatSafe(abs);
      if (!st) {
        addFinding(report, { category: 'broken-link', file: name, line: l.line, evidence: `リンク先が存在しない: ${rel}`, note: '' });
        continue;
      }
      if (st.isSymbolicLink() || hasLinkComponent(abs)) {
        report.skipped.push({ file: name, line: l.line, reason: 'リンク (symlink/junction/reparse point) は追わない' });
        continue;
      }
      if (allowRead && st.isFile() && /\.md$/i.test(rel) && !texts.has(rel) && !coreActual.has(rel)) {
        const lt = readTextSafe(target, rel, report);
        if (lt !== null) {
          texts.set(rel, lt);
          report.scanned.push(rel);
          checkLinks(rel, lt, false);
        }
      }
    }
  };
  // 読み込み済みの文書の実際の場所 (OS の区切り)。byRel: 実際の相対パス (/ 区切り) → 論理名
  const coreActual = new Set([...where.values()].map(toNative));
  const byRel = new Map([...where].map(([name, rel]) => [rel, name]));
  for (const name of CORE_FILES) if (texts.has(name)) checkLinks(name, texts.get(name), true);

  // 内容検査 (秘密らしい記述)
  const secretFiles = new Set();
  for (const [name, text] of texts) {
    if (name === MANIFEST_FILE_NAME) continue;
    text.split('\n').forEach((line, i) => {
      for (const id of detectSecretPatterns(line)) {
        secretFiles.add(name);
        addFinding(report, { category: 'secret-like', severity: 'error', file: name, line: i + 1, evidence: `パターン: ${id} (値は非表示)`, note: '文書から除去し、必要なら資格情報を失効させる。' });
      }
    });
  }

  // 役割整合
  const wf = texts.has('WORKFLOW.md') ? parseWorkflowRoles(texts.get('WORKFLOW.md')) : null;
  if (wf) {
    if (!wf.lead || !wf.implementer) {
      addFinding(report, { category: 'role-contradiction', file: 'WORKFLOW.md', line: 1, evidence: '「- 主導:」「- 実装:」の行が見つからない', note: '記法外の役割記述は検査できない。' });
    }
    if (cfg?.mode) {
      const m = MODES[cfg.mode];
      const mismatch = (wf.lead && wf.lead !== m.lead) || (wf.implementer && wf.implementer !== m.implementer) || (wf.taggedMode && wf.taggedMode !== cfg.mode);
      if (mismatch) {
        addFinding(report, {
          category: 'config-mismatch',
          severity: 'info',
          file: 'WORKFLOW.md',
          line: wf.leadLine,
          evidence: `設定 mode=${cfg.mode} (主導 ${m.lead}/実装 ${m.implementer}) に対し WORKFLOW は 主導 ${wf.lead ?? '?'}/実装 ${wf.implementer ?? '?'}${wf.taggedMode ? ` (tag ${wf.taggedMode})` : ''}`,
          note: '意図した役割変更なら setup.config.json を更新し、差分確認後に別出力へ再生成して整合させる。監査は復元しない。',
        });
      }
    }
    for (const [agent, file] of Object.entries(ENTRY_FILE)) {
      if (!texts.has(file)) continue;
      const e = parseEntryRole(texts.get(file));
      if (!e.refersWorkflow) {
        addFinding(report, { category: 'entry-missing-reference', file, line: 1, evidence: 'WORKFLOW.md への参照がない', note: '入口は正本参照が必要。' });
      }
      if (!e.roleId) {
        addFinding(report, { category: 'role-contradiction', file, line: 1, evidence: '「- 役割:」行が見つからない', note: '' });
        continue;
      }
      const wfSolo = wf.lead && wf.implementer && wf.lead === wf.implementer;
      let expected;
      if (wfSolo) expected = agent === wf.lead ? 'solo' : null;
      else if (agent === wf.lead) expected = 'lead';
      else if (agent === wf.implementer) expected = 'implementer';
      else expected = null;
      if (expected === null) {
        addFinding(report, { category: 'role-contradiction', file, line: e.line, evidence: `WORKFLOW.md:${wf.leadLine} の役割に ${agent} が含まれないのに入口がある`, note: '単独化/主導逆転の残骸の可能性。' });
      } else if (expected !== e.roleId) {
        addFinding(report, { category: 'role-contradiction', file, line: e.line, evidence: `入口の役割 (${e.role}) と WORKFLOW.md:${wf.leadLine}-${wf.implLine} (${agent}=${expected}) が矛盾`, note: '正本は WORKFLOW.md。どちらが意図かユーザー判断。' });
      }
    }
    // 単独モードで存在しない担当への言及
    if (wf.lead && wf.implementer && wf.lead === wf.implementer) {
      const absent = Object.keys(ENTRY_FILE).filter((a) => a !== wf.lead);
      for (const name of ['WORKFLOW.md', 'START.md', 'TASKS.md', ENTRY_FILE[wf.lead]]) {
        if (!texts.has(name)) continue;
        texts.get(name).split('\n').forEach((line, i) => {
          for (const a of absent) {
            if (new RegExp(`\\b${a}\\b`).test(line)) {
              addFinding(report, { category: 'absent-agent-reference', file: name, line: i + 1, evidence: `単独モードなのに ${a} に言及`, note: '存在しない担当待ちになっていないか確認。' });
            }
          }
        });
      }
    }
  }

  // TASKS: [x] の検査 (証跡の空/なし/未確認、VALIDATION の #id 突合)
  if (texts.has('TASKS.md')) {
    const validation = texts.has('VALIDATION.md') ? parseValidationResults(texts.get('VALIDATION.md')) : new Map();
    texts.get('TASKS.md').split('\n').forEach((line, i) => {
      if (!/^\s*[-*]\s*\[[xX]\]/.test(line)) return;
      if (/未確認/.test(line)) {
        addFinding(report, { category: 'done-but-unverified', file: 'TASKS.md', line: i + 1, evidence: '[x] と「未確認」が同じ行', note: '' });
        return;
      }
      const ev = line.match(/証跡[:：]\s*(.*)$/);
      const value = ev ? ev[1].trim() : null;
      if (value === null) {
        addFinding(report, { category: 'done-without-evidence', file: 'TASKS.md', line: i + 1, evidence: '[x] に「証跡:」がない', note: '' });
      } else if (value === '' || EMPTY_EVIDENCE_RE.test(value)) {
        addFinding(report, { category: 'done-without-evidence', file: 'TASKS.md', line: i + 1, evidence: '「証跡:」の値が空/なし/未確認', note: '所在 (ファイル・ログ) を書く。' });
      }
      const ids = line.match(TASK_ID_RE) || [];
      if (ids.length === 0) {
        addFinding(report, { category: 'done-without-id', file: 'TASKS.md', line: i + 1, evidence: '[x] に #id がない', note: 'VALIDATION.md の結果記録と対応づけられない。' });
      }
      for (const id of ids) {
        const v = validation.get(id);
        if (v && NOT_ACCEPTED_RE.test(v.result)) {
          addFinding(report, { category: 'done-but-validation-failed', file: 'TASKS.md', line: i + 1, evidence: `${id} は VALIDATION.md:${v.line} で「${v.result}」`, note: '' });
        }
      }
    });
  }

  // manifest 照合: 読取許可ではない。安全に読めた既知ファイル/明示リンクだけ照合し、他は skip。
  if (manifest && Array.isArray(manifest.files)) {
    for (const mf of manifest.files) {
      if (!mf || typeof mf.path !== 'string') continue;
      const rel = mf.path;
      const key = byRel.get(rel) ?? rel;
      if (texts.has(key)) {
        if (sha256Hex(texts.get(key)) !== mf.sha256) {
          addFinding(report, {
            category: 'manifest-changed',
            severity: 'info',
            file: rel,
            line: 1,
            evidence: '生成時 sha256 と現在が異なる',
            note: CONTRACT_FILES.has(baseName(rel)) ? '契約文書の変更。意図した変更なら設定更新→差分確認→別出力へ再生成で整合。' : '作業文書の更新は通常の運用。',
          });
        }
      } else if (KNOWN_GENERATED.has(baseName(rel))) {
        addFinding(report, { category: 'manifest-missing-file', file: rel, line: 1, evidence: 'manifest にあるが存在しない (または読めない)', note: '' });
      } else {
        report.skipped.push({ file: rel, reason: 'manifest 記載だが既知の生成物/明示リンクではないため照合しない' });
      }
    }
  }

  // 修正差分案 (契約文書のみ、apply しない、秘密らしい記述を含むファイルは抑止)
  if (validated && cfg?.mode) {
    try {
      const plan = buildPlan(validated);
      for (const f of plan.files) {
        const logical = baseName(f.path);
        if (!CONTRACT_FILES.has(logical) || !texts.has(logical)) continue;
        if (secretFiles.has(logical)) {
          report.proposals.push({ file: f.path, diff: '', suppressed: true, note: '秘密らしい記述を含むため差分案を表示しない。先に除去してください。' });
          continue;
        }
        const cur = texts.get(logical);
        if (cur !== f.content) {
          const d = formatDiff(cur, f.content, { oldLabel: `${f.path} (現在)`, newLabel: `${f.path} (設定から再生成した案)` });
          if (d) report.proposals.push({ file: f.path, diff: redactSecrets(d), note: '設定に合わせる案。現在の文書が意図なら設定側を変えて再生成する。apply しない。' });
        }
      }
    } catch (e) {
      report.limits.push(`修正差分案の生成に失敗: ${redactSecrets(e.message)}`);
    }
  }

  for (const f of report.findings) if (where.has(f.file)) f.file = where.get(f.file);
  for (const s of report.skipped) if (where.has(s.file)) s.file = where.get(s.file);
  for (const p of report.proposals) if (where.has(p.file)) p.file = where.get(p.file);
  report.needsConfirmation = report.findings.filter((f) => JUDGEMENT_CATEGORIES.has(f.category)).map((f) => `${f.file}:${f.line}: ${CATEGORY_LABEL[f.category]}`);
  report.summary = summarize(report);
  return report;
}

function summarize(report) {
  const counts = {};
  for (const f of report.findings) counts[f.category] = (counts[f.category] || 0) + 1;
  return { findings: report.findings.length, byCategory: counts, proposals: report.proposals.length, scanned: report.scanned.length, skipped: report.skipped.length };
}

export function renderAuditMarkdown(report) {
  const L = [];
  L.push('# 監査レポート (読取診断のみ、apply なし)');
  L.push('');
  L.push(`- 対象: ${report.target}`);
  L.push(`- 無人モード: ${report.unattended ? 'はい' : 'いいえ'}`);
  L.push(`- 読んだファイル: ${report.scanned.join(', ') || '(なし)'}`);
  L.push(`- 検出数: ${report.summary.findings} / 修正差分案: ${report.summary.proposals}`);
  L.push('');
  L.push('## 検出');
  if (report.findings.length === 0) L.push('- なし');
  for (const f of report.findings) {
    L.push(`- [${f.severity}] ${CATEGORY_LABEL[f.category] || f.category} — ${f.file}:${f.line} — ${f.evidence}${f.note ? ` — ${f.note}` : ''}`);
  }
  L.push('');
  L.push('## 判断要 / 意図確認');
  if (report.needsConfirmation.length === 0) L.push('- なし');
  for (const n of report.needsConfirmation) L.push(`- ${n}`);
  L.push('');
  L.push('## 読まなかった対象');
  if (report.skipped.length === 0) L.push('- なし');
  for (const s of report.skipped) L.push(`- ${s.file}${s.line ? `:${s.line}` : ''} — ${s.reason}`);
  L.push('');
  L.push('## 修正差分案 (提示のみ)');
  if (report.proposals.length === 0) L.push('- なし');
  for (const p of report.proposals) {
    L.push(`### ${p.file}`);
    L.push(p.note);
    if (p.diff) {
      L.push('```diff');
      L.push(p.diff);
      L.push('```');
    }
  }
  L.push('');
  L.push('## 機械的検査の限界');
  for (const l of report.limits) L.push(`- ${l}`);
  L.push('');
  return L.join('\n');
}
