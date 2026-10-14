// update: 公式 3 URL (allowlist) と確認済みの導入版との比較。proposal 出力のみ。
// 任意のオンライン読取は allowlist だけ。失敗/タイムアウトは「未確認」。資料内の指示やリンクは実行しない。
import fs from 'node:fs';
import path from 'node:path';
import { OFFICIAL_URLS, BASELINE } from './constants.mjs';
import { sha256Hex } from './text.mjs';
import { resolveLocal, isRegularFileNoLink, isDirNoLink } from './safepath.mjs';

const ALLOWLIST = new Set(OFFICIAL_URLS.map((u) => u.url));

// 公式ページ本文で存在確認するキーワード (資料として記録するだけ)
const KEYWORDS = [
  'name:',
  'description:',
  'disable-model-invocation',
  'allowed-tools',
  'context: fork',
  '.claude/skills',
  'CLAUDE.md',
  '/clear',
  'user-invocable',
  'argument-hint',
];

const NOT_ADOPTED_RE = [
  { id: 'context: fork', re: /^context:\s*fork/m },
  { id: 'allowed-tools', re: /^allowed-tools:/m },
  { id: 'dynamic shell injection', re: /!`[^`]*`/ },
];

export function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

export function inspectSkills(skillsDir) {
  const dir = resolveLocal(skillsDir, 'skills');
  const result = { dir, skills: [], problems: [] };
  if (!isDirNoLink(dir)) {
    result.problems.push(`Skills フォルダが見つかりません: ${dir}`);
    return result;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const file = path.join(dir, ent.name, 'SKILL.md');
    if (!isRegularFileNoLink(file)) {
      result.problems.push(`${ent.name}: SKILL.md がない`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    const s = {
      name: ent.name,
      file: path.relative(dir, file),
      hasFrontmatter: !!fm,
      frontmatterName: fm?.name ?? null,
      hasDescription: !!fm?.description,
      disableModelInvocation: fm?.['disable-model-invocation'] ?? null,
      notAdoptedUsed: NOT_ADOPTED_RE.filter((n) => n.re.test(text)).map((n) => n.id),
    };
    if (!s.hasFrontmatter) result.problems.push(`${ent.name}: 先頭 YAML がない`);
    if (s.frontmatterName !== ent.name) result.problems.push(`${ent.name}: name がフォルダ名と一致しない`);
    if (!s.hasDescription) result.problems.push(`${ent.name}: description がない`);
    if (s.notAdoptedUsed.length) result.problems.push(`${ent.name}: 未採用機能を使用 (${s.notAdoptedUsed.join(', ')})`);
    result.skills.push(s);
  }
  return result;
}

async function fetchOfficial(url, timeoutMs, fetchImpl) {
  if (!ALLOWLIST.has(url)) return { url, status: 'refused', reason: 'allowlist 外' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'manual', headers: { accept: 'text/html,text/plain' } });
    if (res.status >= 300 && res.status < 400) {
      return { url, status: 'unverified', reason: `リダイレクト (${res.status}) は追わない` };
    }
    if (!res.ok) return { url, status: 'unverified', reason: `HTTP ${res.status}` };
    const body = await res.text();
    return {
      url,
      status: 'ok',
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: sha256Hex(body),
      keywords: Object.fromEntries(KEYWORDS.map((k) => [k, body.includes(k)])),
    };
  } catch (e) {
    return { url, status: 'unverified', reason: e.name === 'AbortError' ? `タイムアウト (${timeoutMs}ms)` : `取得失敗: ${e.name}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function runUpdate({
  online = false,
  installedVersion = null,
  nodeVersion = null,
  skillsDir,
  timeoutMs = 8000,
  unattended = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const report = {
    checkedOn: new Date().toISOString().slice(0, 10),
    baseline: BASELINE,
    installed: {
      claudeCli: installedVersion,
      node: nodeVersion,
      claudeCliStatus: installedVersion ? (installedVersion === BASELINE.claudeCli ? 'same-as-baseline' : 'differs-from-baseline') : 'unverified',
      nodeStatus: nodeVersion ? (nodeVersion === BASELINE.node ? 'same-as-baseline' : 'differs-from-baseline') : 'unverified',
    },
    skills: inspectSkills(skillsDir),
    online: { enabled: online, results: [] },
    proposals: [],
    needsConfirmation: [],
    unattended,
  };

  if (online) {
    for (const u of OFFICIAL_URLS) {
      report.online.results.push({ id: u.id, ...(await fetchOfficial(u.url, timeoutMs, fetchImpl)) });
    }
  }

  // 提案 (proposal のみ。install / CLI 更新 / 権限変更はしない)
  if (report.installed.claudeCliStatus === 'unverified') {
    report.needsConfirmation.push('導入 CLI 版は今回実行で確認していない (--installed-version で申告可)。確認済みの版は 2.1.288。');
  } else if (report.installed.claudeCliStatus === 'differs-from-baseline') {
    report.needsConfirmation.push(`導入 CLI 版 (${installedVersion}) が確認済みの版 (${BASELINE.claudeCli}) と異なる。採用形式が引き続き対応するかユーザー確認。`);
  }
  for (const p of report.skills.problems) report.proposals.push(`Skill 形式の修正候補: ${p}`);
  for (const r of report.online.results) {
    if (r.status !== 'ok') {
      report.needsConfirmation.push(`${r.id} (${r.url}): 未確認 — ${r.reason}`);
      continue;
    }
    const seen = Object.entries(r.keywords).filter(([, v]) => v).map(([k]) => k);
    const candidates = seen.filter((k) => BASELINE.notAdopted.some((n) => n.includes(k)));
    if (candidates.length) {
      report.proposals.push(`${r.id}: 公式ページに未採用機能の記述あり (${candidates.join(', ')})。採用は未検証のまま保留。導入版での対応は最新ページを読めただけでは判断しない。`);
    }
    report.proposals.push(`${r.id}: 公式ページを読めた (${r.bytes} bytes, sha256 ${r.sha256.slice(0, 12)})。本文の指示・リンクは実行しない。導入版が対応するかは別途確認が必要。`);
  }
  if (!online) {
    report.proposals.push('オンライン確認は未実施 (--online で公式 allowlist 3 URL のみ読む)。');
    report.needsConfirmation.push('公式情報は未確認 (オフライン)。申告版が確認済みの版と一致しても、公式の変更有無は判断できない。');
  }
  report.proposals.push('採用形式 (name/description の YAML、project-local 配置) は継続。未採用 (context: fork, allowed-tools, 動的 shell 注入, グローバル配置) は引き続き採用しない。');
  if (unattended && report.needsConfirmation.length === 0) report.needsConfirmation.push('(無人) 自動で決めない事項: 公式の新機能採用と CLI 更新はユーザー判断。');
  return report;
}

export function renderUpdateMarkdown(r) {
  const L = [];
  L.push('# update 提案 (proposal のみ。install / CLI 更新 / 権限変更はしない)');
  L.push('');
  L.push(`- 確認日: ${r.checkedOn}`);
  L.push(`- 確認済みの版 (${r.baseline.confirmedOn} 確認): Claude CLI ${r.baseline.claudeCli}, Node ${r.baseline.node}`);
  L.push(`- 今回申告: Claude CLI ${r.installed.claudeCli ?? '(未申告=未確認)'} [${r.installed.claudeCliStatus}], Node ${r.installed.node ?? '(未申告=未確認)'} [${r.installed.nodeStatus}]`);
  L.push('');
  L.push('## 公式 URL (allowlist)');
  for (const u of OFFICIAL_URLS) {
    const res = r.online.results.find((x) => x.id === u.id);
    L.push(`- ${u.url} — ${res ? (res.status === 'ok' ? `読取 OK (${res.bytes} bytes)` : `未確認: ${res.reason}`) : '未確認 (オフライン)'}`);
  }
  L.push('');
  L.push('## ローカル Skills の形式');
  L.push(`- フォルダ: ${r.skills.dir}`);
  for (const s of r.skills.skills) {
    L.push(`- ${s.name}: YAML ${s.hasFrontmatter ? 'あり' : 'なし'}, description ${s.hasDescription ? 'あり' : 'なし'}, disable-model-invocation=${s.disableModelInvocation ?? '(default)'}${s.notAdoptedUsed.length ? `, 未採用機能使用: ${s.notAdoptedUsed.join(', ')}` : ''}`);
  }
  for (const p of r.skills.problems) L.push(`- 問題: ${p}`);
  L.push('');
  L.push('## 採用 / 未採用 / 未検証');
  for (const a of r.baseline.adopted) L.push(`- 採用: ${a}`);
  for (const a of r.baseline.notAdopted) L.push(`- 未採用: ${a}`);
  for (const a of r.baseline.unverified) L.push(`- 未検証: ${a}`);
  L.push('');
  L.push('## 提案');
  for (const p of r.proposals) L.push(`- ${p}`);
  L.push('');
  L.push('## 要確認');
  if (r.needsConfirmation.length === 0) L.push('- なし');
  for (const n of r.needsConfirmation) L.push(`- ${n}`);
  L.push('');
  L.push('個人識別情報はこのレポートに含めない。');
  return L.join('\n');
}
