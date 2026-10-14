// 設定 JSON の読み込み・検証・正規化。入力はデータとして扱い、指示へ昇格させない。
import fs from 'node:fs';
import { MODES, MODE_NAMES, HANDOFFS, AUDIENCE_NAMES, SCHEMA_VERSION } from './constants.mjs';
import { sanitizeText } from './text.mjs';
import { normalizeAiPreferences } from './ai-preferences.mjs';
import { PROFILES, DEFAULT_PROFILE, PUSH_POLICIES, DEFAULT_PUSH_POLICY, LAUNCH_POLICIES, DEFAULT_LAUNCH_POLICY, SOLO_LAUNCH_POLICY } from './render-profile.mjs';
import { LAYOUTS, DEFAULT_LAYOUT } from './layout.mjs';
import { resolveLocal, isRegularFileNoLink, hasDeniedSegmentAbs } from './safepath.mjs';

export class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

// 受け付けるキー (これ以外は拒否: 秘密らしい設定値の紛れ込み防止)
export const STRING_FIELDS = ['name', 'purpose', 'mvp', 'tech', 'mode', 'handoff', 'audience'];
export const LIST_FIELDS = ['outOfScope', 'phases', 'verifyCommands', 'projectRules', 'handover'];
export const KNOWN_KEYS = new Set([
  'schemaVersion',
  ...STRING_FIELDS,
  ...LIST_FIELDS,
  'permissions',
  'ai',
  'gitignore',
  'profile',
  'pushPolicy',
  'launchPolicy',
  'uiRules',
  'envSplit',
  'layout',
  'notes',
]);
export const PERMISSION_KEYS = new Set(['allowedPaths', 'forbidden']);

export const REQUIRED_FIELDS = Object.freeze([
  { key: 'name', label: '案件名' },
  { key: 'purpose', label: '目的' },
  { key: 'mvp', label: 'MVP' },
  { key: 'mode', label: 'モード' },
  { key: 'audience', label: '利用範囲' },
]);

// 任意欄 (空でも止まらない。未定として記録)
export const OPTIONAL_FIELDS = Object.freeze([
  { key: 'outOfScope', label: '対象外' },
  { key: 'phases', label: '段階' },
  { key: 'tech', label: '技術' },
  { key: 'verifyCommands', label: '検証コマンド' },
  { key: 'handoff', label: '引継ぎ' },
  { key: 'permissions.allowedPaths', label: '編集許可パス' },
  { key: 'permissions.forbidden', label: '禁止事項' },
]);

// --- 秘密らしい値の検出 (値は報告に転記しない) ---
const SECRET_KEY_RE = /(api[_-]?key|secret|token|passw(or)?d|credential|private[_-]?key|authorization|bearer|webhook)/i;
const SECRET_VALUE_PATTERNS = [
  { id: 'openai-like-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'anthropic-like-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'bearer-header', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { id: 'webhook-url', re: /https?:\/\/(hooks\.slack\.com|discord(app)?\.com\/api\/webhooks)\/\S+/i },
  { id: 'password-assignment', re: /\b(password|passwd|pwd|api_key|apikey|secret|token)\s*[=:]\s*['"]?[^\s'"]{8,}/i },
];

// 文字列からの秘密検出。見つかったパターン ID の配列 (値は返さない)。
export function detectSecretPatterns(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const p of SECRET_VALUE_PATTERNS) if (p.re.test(s)) hits.push(p.id);
  return hits;
}

export function isSecretLikeKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

// オブジェクト全体を走査し、秘密らしいキー/値の場所 (パス) を返す。値は返さない。
export function scanSecrets(obj, basePath = '') {
  const findings = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const cp = p ? `${p}.${k}` : k;
        if (isSecretLikeKey(k)) findings.push({ path: cp, kind: 'secret-like-key' });
        walk(x, cp);
      }
    } else if (typeof v === 'string') {
      for (const id of detectSecretPatterns(v)) findings.push({ path: p, kind: `secret-like-value:${id}` });
    }
  };
  walk(obj, basePath);
  return findings;
}

// --- 読み込み / 検証 ---
const MAX_CONFIG_BYTES = 256 * 1024;

export function readConfigFile(file) {
  const abs = resolveLocal(file, 'config');
  if (hasDeniedSegmentAbs(abs)) throw new ConfigError('設定ファイルの経路に秘密/認証/依存に該当する名前が含まれるため読みません');
  if (!isRegularFileNoLink(abs)) throw new ConfigError(`設定ファイルが見つかりません (またはリンクを経由しています): ${abs}`);
  const st = fs.lstatSync(abs);
  if (st.size > MAX_CONFIG_BYTES) throw new ConfigError('設定ファイルが大きすぎます');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    // JSON.parse のメッセージは入力の断片を含むことがあるため転記しない
    throw new ConfigError('設定 JSON を解析できません (構文エラー。内容は表示しません)');
  }
  return raw;
}

// 秘密らしい値を伏せる (差分・エラー表示用)。見逃しはあり得る。
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const p of SECRET_VALUE_PATTERNS) s = s.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'), '[REDACTED]');
  return s;
}

function asList(v, key, errors) {
  if (v === undefined || v === null || v === '') return [];
  if (typeof v === 'string') return v.split('\n').map((x) => sanitizeText(x).trim()).filter(Boolean);
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      if (typeof x !== 'string') {
        errors.push(`${key}: 文字列以外の要素があります`);
        continue;
      }
      const t = sanitizeText(x).trim();
      if (t) out.push(t);
    }
    return out;
  }
  errors.push(`${key}: 配列または文字列で指定してください`);
  return [];
}

function rejection(errors) {
  return new ConfigError(`設定を受け付けられません:\n  - ${errors.join('\n  - ')}`, errors);
}

// 正規化済み設定と、要確認 (needsConfirmation) / 警告を返す。例外は構造上の拒否のみ。
export function validateConfig(raw) {
  const errors = [];
  const needsConfirmation = [];
  const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('設定はオブジェクトである必要があります');
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) errors.push(`不明なキー: ${k} (受け付けるキー以外は拒否します)`);
  }
  if (raw.permissions !== undefined) {
    if (!raw.permissions || typeof raw.permissions !== 'object' || Array.isArray(raw.permissions)) {
      errors.push('permissions: オブジェクトで指定してください');
    } else {
      for (const k of Object.keys(raw.permissions)) {
        if (!PERMISSION_KEYS.has(k)) errors.push(`permissions の不明なキー: ${k}`);
      }
    }
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion は ${SCHEMA_VERSION} のみ対応です`);
  }

  // 秘密らしい値は拒否 (値は出さない)
  const secrets = scanSecrets(raw);
  for (const s of secrets) errors.push(`秘密らしい設定値を検出したため拒否します: ${s.path} (${s.kind})`);

  if (errors.length) throw rejection(errors);

  const cfg = {
    schemaVersion: SCHEMA_VERSION,
    name: '',
    purpose: '',
    mvp: '',
    outOfScope: [],
    phases: [],
    tech: '',
    verifyCommands: [],
    projectRules: [],
    handover: [],
    mode: '',
    handoff: 'manual',
    audience: '',
    permissions: { allowedPaths: [], forbidden: [] },
    notes: '',
    ai: normalizeAiPreferences(),
    gitignore: true,
    profile: DEFAULT_PROFILE,
    pushPolicy: DEFAULT_PUSH_POLICY,
    launchPolicy: DEFAULT_LAUNCH_POLICY,
    uiRules: false,
    envSplit: false,
    layout: DEFAULT_LAYOUT,
  };

  // 文書の配置: folders (入口だけルート、文書は docs/、設定と記録は initial-settings/。既定) / root (すべてルート)
  if (raw.layout !== undefined && raw.layout !== null && raw.layout !== '') {
    if (!LAYOUTS.includes(raw.layout)) errors.push(`layout は ${LAYOUTS.join(' | ')} のいずれかです`);
    else cfg.layout = raw.layout;
  }

  // push の承認: approval (毎回承認。既定) / work-branch (作業ブランチへの push は承認なし)
  if (raw.pushPolicy !== undefined && raw.pushPolicy !== null && raw.pushPolicy !== '') {
    if (!PUSH_POLICIES.includes(raw.pushPolicy)) errors.push(`pushPolicy は ${PUSH_POLICIES.join(' | ')} のいずれかです`);
    else cfg.pushPolicy = raw.pushPolicy;
  }

  // 別AIの起動: lead-launch (主導担当が、決めた範囲で実装担当を起動して課題を渡してよい。協働モードの既定) / approval (毎回承認)
  if (raw.launchPolicy !== undefined && raw.launchPolicy !== null && raw.launchPolicy !== '') {
    if (!LAUNCH_POLICIES.includes(raw.launchPolicy)) errors.push(`launchPolicy は ${LAUNCH_POLICIES.join(' | ')} のいずれかです`);
    else cfg.launchPolicy = raw.launchPolicy;
  }

  // 画面のある案件か (true なら「画面の実装の基本」を入れる。既定は入れない)
  if (raw.uiRules !== undefined && raw.uiRules !== null) {
    if (typeof raw.uiRules !== 'boolean') errors.push('uiRules: true / false で指定してください');
    else cfg.uiRules = raw.uiRules;
  }

  // 開発用と本番用を分けるか (true なら「開発用と本番用」の節を入れる。既定は入れない)
  if (raw.envSplit !== undefined && raw.envSplit !== null) {
    if (typeof raw.envSplit !== 'boolean') errors.push('envSplit: true / false で指定してください');
    else cfg.envSplit = raw.envSplit;
  }

  // 運用の段階: minimal / standard / full (未指定は standard)
  if (raw.profile !== undefined && raw.profile !== null && raw.profile !== '') {
    if (!PROFILES.includes(raw.profile)) errors.push(`profile は ${PROFILES.join(' | ')} のいずれかです`);
    else cfg.profile = raw.profile;
  }

  // おすすめの .gitignore を、ないときだけ作るか (既定は作る)
  if (raw.gitignore !== undefined && raw.gitignore !== null) {
    if (typeof raw.gitignore !== 'boolean') errors.push('gitignore: true / false で指定してください');
    else cfg.gitignore = raw.gitignore;
  }

  try { cfg.ai = normalizeAiPreferences(raw.ai); }
  catch (error) { errors.push(error.message); }

  for (const k of ['name', 'purpose', 'mvp', 'tech', 'notes']) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') {
      errors.push(`${k}: 文字列で指定してください`);
      continue;
    }
    cfg[k] = sanitizeText(v).trim();
  }
  cfg.name = cfg.name.replace(/\s+/g, ' ');
  for (const k of LIST_FIELDS) cfg[k] = asList(raw[k], k, errors);
  if (raw.permissions) {
    cfg.permissions.allowedPaths = asList(raw.permissions.allowedPaths, 'permissions.allowedPaths', errors);
    cfg.permissions.forbidden = asList(raw.permissions.forbidden, 'permissions.forbidden', errors);
  }

  // mode
  const mode = typeof raw.mode === 'string' ? raw.mode.trim() : '';
  if (mode === '') {
    cfg.mode = '';
  } else if (!MODE_NAMES.includes(mode)) {
    errors.push(`mode は ${MODE_NAMES.join(' | ')} のいずれかです`);
  } else {
    cfg.mode = mode;
  }

  // 利用範囲: personal (自分用) / company (会社用) / public (公開)。必須で、既定はない (未回答は要確認)
  const audience = typeof raw.audience === 'string' ? raw.audience.trim() : '';
  if (raw.audience !== undefined && raw.audience !== null && typeof raw.audience !== 'string') errors.push('audience: 文字列で指定してください');
  else if (audience && !AUDIENCE_NAMES.includes(audience)) errors.push(`audience は ${AUDIENCE_NAMES.join(' | ')} のいずれかです`);
  else cfg.audience = audience;

  // handoff
  const handoffRaw = raw.handoff === undefined || raw.handoff === null || raw.handoff === '' ? undefined : String(raw.handoff).trim();
  if (handoffRaw !== undefined && !HANDOFFS.includes(handoffRaw)) {
    errors.push(`handoff は ${HANDOFFS.join(' | ')} のいずれかです`);
  }
  if (cfg.mode && MODES[cfg.mode].solo) {
    if (handoffRaw && handoffRaw !== 'none') warnings.push(`単独モードのため handoff=${handoffRaw} は none に正規化しました`);
    cfg.handoff = 'none';
    // 単独モードには起動する相手がいないので、常に毎回承認にする (明示して lead-launch を指定したときだけ知らせる)
    if (raw.launchPolicy === 'lead-launch') warnings.push(`単独モードのため launchPolicy=lead-launch は ${SOLO_LAUNCH_POLICY} に正規化しました`);
    cfg.launchPolicy = SOLO_LAUNCH_POLICY;
  } else if (handoffRaw === undefined) {
    cfg.handoff = 'manual';
    if (cfg.mode) needsConfirmation.push({ field: 'handoff', message: '引継ぎ手段が未指定のため manual を仮置きしました' });
  } else if (handoffRaw === 'none' && cfg.mode) {
    errors.push('協働モードでは handoff=none は選べません (manual または cli)');
  } else {
    cfg.handoff = handoffRaw;
  }

  if (errors.length) throw rejection(errors);

  // 必須未回答は要確認 (例外ではない: plan は読めるが generate は止まる)
  for (const f of REQUIRED_FIELDS) {
    if (!cfg[f.key]) needsConfirmation.push({ field: f.key, message: `${f.label} が未回答です (必須)`, required: true });
  }
  // 任意欄の空は未定として記録 (止まらない)
  const undecided = [];
  if (!cfg.tech) undecided.push('tech');
  if (cfg.verifyCommands.length === 0) undecided.push('verifyCommands');
  if (cfg.outOfScope.length === 0) undecided.push('outOfScope');
  if (cfg.phases.length === 0) undecided.push('phases');
  if (cfg.permissions.allowedPaths.length === 0) undecided.push('permissions.allowedPaths');
  if (cfg.permissions.forbidden.length === 0) undecided.push('permissions.forbidden');

  return { config: cfg, needsConfirmation, warnings, undecided };
}

export function loadConfig(file) {
  return validateConfig(readConfigFile(file));
}

export function hasRequiredMissing(needsConfirmation) {
  return needsConfirmation.some((n) => n.required);
}
