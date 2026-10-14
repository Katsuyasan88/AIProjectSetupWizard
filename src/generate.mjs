// generate / regenerate: 未作成または空のフォルダに書く。途中失敗は一時フォルダごと破棄。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TOOL_NAME, TOOL_VERSION, TEMPLATE_VERSION, MANIFEST_FILE_NAME, WORKING_DOCS } from './constants.mjs';
import { digestMatches } from './plan.mjs';
import { resolveLocal, lstatSafe, isRegularFileNoLink, isDirNoLink, isInside, hasLinkComponent } from './safepath.mjs';
import { findExisting, baseName, toNative } from './layout.mjs';
import { sha256Hex, stableStringify } from './text.mjs';
import { formatDiff, countChanges } from './diff.mjs';
import { detectSecretPatterns, redactSecrets } from './config.mjs';

export class GenerateError extends Error {}

const MAX_HISTORY = 200;
const HISTORY_ACTIONS = new Set(['generate', 'regenerate', 'apply', 'adopt']);

// manifest から実行履歴を読む。manifest は不信な資料なので、形の合う項目だけを、長さを切って引き継ぐ。
// 履歴のない古い manifest は、その manifest 自身を最初の 1 件として扱う。
export function readHistory(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const str = (v) => (typeof v === 'string' ? redactSecrets(v).slice(0, 200) : null);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 50).map((x) => redactSecrets(x).slice(0, 200)) : []);
  const clean = (h) => ({
    at: str(h.at),
    action: HISTORY_ACTIONS.has(h.action) ? h.action : 'generate',
    toolVersion: str(h.toolVersion),
    templateVersion: str(h.templateVersion),
    mode: str(h.mode),
    planDigest: str(h.planDigest),
    changed: list(h.changed),
    moved: list(h.moved),
    kept: list(h.kept),
  });
  if (Array.isArray(manifest.history)) return manifest.history.filter((h) => h && typeof h === 'object').slice(-MAX_HISTORY).map(clean);
  if (typeof manifest.generatedAt !== 'string') return [];
  return [clean({ at: manifest.generatedAt, action: 'generate', toolVersion: manifest.version, templateVersion: manifest.templateVersion, mode: manifest.mode, planDigest: manifest.planDigest, changed: Array.isArray(manifest.files) ? manifest.files.map((f) => f?.path) : [] })];
}

// history: 実行のたびに 1 件足す (どの版のツールとテンプレートで、何をしたか)。パスは案件内の相対名だけを記録する。
export function buildManifest(plan, now, { action = 'generate', previous = null, changed = null, moved = [], kept = [] } = {}) {
  const entry = {
    at: now,
    action,
    toolVersion: TOOL_VERSION,
    templateVersion: TEMPLATE_VERSION,
    mode: plan.mode,
    planDigest: plan.digest,
    changed: changed ?? plan.files.map((f) => f.path),
    moved,
    kept,
  };
  return {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    templateVersion: TEMPLATE_VERSION,
    generatedAt: now,
    mode: plan.mode,
    handoff: plan.handoff,
    planDigest: plan.digest,
    files: plan.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
    history: [...readHistory(previous), entry].slice(-MAX_HISTORY),
    note: '監査でこの manifest と差分があっても変更=違反ではない。history は、このツールがこのフォルダに対して行った生成・更新の記録。',
  };
}

// 未作成、またはリンクを経由しない空フォルダだけを出力先にする (隠し項目も数える)。
export function inspectOutputDirectory(outDir) {
  const out = resolveLocal(outDir, 'out');
  const parent = path.dirname(out);
  if (!isDirNoLink(parent) || hasLinkComponent(out)) {
    throw new GenerateError(`出力先の親フォルダが存在しないか、リンクを経由しています: ${parent}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(out);
  } catch (error) {
    if (error.code === 'ENOENT') return { out, identity: null };
    throw error;
  }
  if (!stat.isDirectory() || !isDirNoLink(out) || fs.readdirSync(out).length !== 0) {
    throw new GenerateError(`出力先が既に存在し、空の通常フォルダではないため停止します: ${out}`);
  }
  return { out, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` };
}

// 生成の前提確認 (書き込みなし)
export function checkGeneratePreconditions({ plan, outDir, confirmDigest, unattended }) {
  if (unattended) {
    throw new GenerateError('無人モード (--unattended) では生成しません。承認は推測せず、要確認として記録します。');
  }
  if (!plan.canGenerate) {
    const req = plan.needsConfirmation.filter((n) => n.required).map((n) => `${n.field}: ${n.message}`);
    throw new GenerateError(`必須項目が未回答のため生成できません:\n  - ${req.join('\n  - ')}`);
  }
  if (!digestMatches(confirmDigest, plan.digest)) {
    throw new GenerateError(
      `確認済み digest が現在の plan と一致しません (確認後に入力が変わった可能性)。plan を再実行して確認し直してください。\n  期待: ${plan.digest}`,
    );
  }
  return inspectOutputDirectory(outDir).out;
}

// overrides: path → content。plan の内容の代わりに書く (regenerate が書き足された作業文書を引き継ぐときに使う)。
export function generateToDir({ plan, outDir, confirmDigest, unattended = false, now = new Date().toISOString(), overrides = null, action = 'generate' }) {
  const out = checkGeneratePreconditions({ plan, outDir, confirmDigest, unattended });
  const initialOutput = inspectOutputDirectory(out);
  const tmp = `${out}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
  if (lstatSafe(tmp)) throw new GenerateError(`一時フォルダが既に存在します: ${tmp}`);
  fs.mkdirSync(tmp, { recursive: false });
  let removedEmptyOutput = false;
  try {
    for (const f of plan.files) {
      const dest = path.join(tmp, toNative(f.path));
      if (!dest.startsWith(tmp + path.sep)) throw new GenerateError(`不正な出力パス: ${f.path}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, overrides?.get(f.path) ?? f.content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const s of plan.seeds ?? []) {
      const dest = path.join(tmp, s.path);
      if (path.dirname(dest) !== tmp) throw new GenerateError(`不正な出力パス: ${s.path}`);
      fs.writeFileSync(dest, s.content, { encoding: 'utf8', flag: 'wx' });
    }
    const manifest = buildManifest(plan, now, { action, changed: [...plan.files, ...(plan.seeds ?? [])].map((f) => f.path), kept: overrides ? [...overrides.keys()] : [] });
    const manifestDest = path.join(tmp, toNative(plan.manifestPath ?? MANIFEST_FILE_NAME));
    fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
    fs.writeFileSync(manifestDest, stableStringify(manifest, 2) + String.fromCharCode(10), { encoding: 'utf8', flag: 'wx' });
    // 最終確認: 生成中の内容追加・作成・置き換えを拒否する。
    const currentOutput = inspectOutputDirectory(out);
    if (currentOutput.identity !== initialOutput.identity) {
      throw new GenerateError(`出力先が生成中に変わったため停止します: ${out}`);
    }
    if (currentOutput.identity !== null) {
      // rmdir は空でなければ失敗する。利用者のフォルダを再帰削除しない。
      fs.rmdirSync(out);
      removedEmptyOutput = true;
    }
    fs.renameSync(tmp, out);
    return { outDir: out, manifest };
  } catch (e) {
    // 空フォルダの置換に失敗した場合は、空の出力先を復元する。
    // 同時に作られた別の出力先には触れない。
    if (removedEmptyOutput && !lstatSafe(out) && isDirNoLink(path.dirname(out)) && !hasLinkComponent(out)) {
      try { fs.mkdirSync(out, { recursive: false }); } catch { /* 元のエラーを返す */ }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 一時フォルダの削除失敗は無視 (エラーは元のものを返す) */
    }
    throw e;
  }
}

const MAX_COMPARE_BYTES = 2 * 1024 * 1024;

function readExistingSafe(p) {
  if (!isRegularFileNoLink(p)) return null;
  const st = fs.lstatSync(p);
  if (st.size > MAX_COMPARE_BYTES) return null;
  return fs.readFileSync(p, 'utf8');
}

// 既存出力と plan の差分 (読取のみ)。比較元のスナップショット hash を含む確認 digest を返す。
// carry: 生成後に書き足された作業文書 (TASKS / VALIDATION) を、新しい出力へそのまま引き継ぐ対象として扱う。
export function diffAgainstExisting(plan, fromDir, { carry = true } = {}) {
  const from = resolveLocal(fromDir, 'from');
  if (!isDirNoLink(from)) throw new GenerateError(`比較元フォルダが存在しないか、リンクを経由しています: ${from}`);
  let oldManifest = null;
  const manifestRel = findExisting(from, MANIFEST_FILE_NAME);
  const manifestText = manifestRel ? readExistingSafe(path.join(from, toNative(manifestRel))) : null;
  if (manifestText !== null) {
    try {
      oldManifest = JSON.parse(manifestText);
    } catch {
      oldManifest = null;
    }
  }
  const oldHashes = new Map();
  for (const mf of Array.isArray(oldManifest?.files) ? oldManifest.files : []) {
    if (mf && typeof mf.path === 'string' && typeof mf.sha256 === 'string') oldHashes.set(mf.path, mf.sha256);
  }
  const entries = [];
  const carried = [];
  const snapshot = [];
  const planPaths = new Set(plan.files.map((f) => f.path));
  const usedSources = new Set();
  for (const f of plan.files) {
    // 以前の配置 (ルート) で生成された案件: 記録 (manifest) にルートの名前で載っているものだけを、移す元として扱う。
    // 記録にない同名のファイル (ウィザードなしで作った案件のもの) は、移す元にしない。
    let sourcePath = f.path;
    let oldText = readExistingSafe(path.join(from, toNative(f.path)));
    if (oldText === null && f.path.includes('/') && oldHashes.has(baseName(f.path))) {
      const legacy = readExistingSafe(path.join(from, baseName(f.path)));
      if (legacy !== null) {
        oldText = legacy;
        sourcePath = baseName(f.path);
        usedSources.add(sourcePath);
      }
    }
    const relocated = sourcePath !== f.path;
    if (oldText === null) {
      snapshot.push({ path: f.path, sha256: null });
      entries.push({ path: f.path, status: 'added', diff: formatDiff('', f.content, { oldLabel: `(なし)`, newLabel: f.path }) });
      continue;
    }
    const oldHash = sha256Hex(oldText);
    snapshot.push({ path: f.path, sha256: oldHash });
    if (oldHash === f.sha256 && !relocated) {
      entries.push({ path: f.path, status: 'same', diff: '' });
    } else {
      const hasSecret = detectSecretPatterns(oldText).length > 0;
      // manifest の記録と違う = 生成後に書き足された。manifest がなければ判別できないので、失わない側 (引き継ぐ) に倒す。
      if (carry && WORKING_DOCS.includes(baseName(f.path)) && oldHashes.get(sourcePath) !== oldHash) {
        if (hasSecret) {
          entries.push({ path: f.path, status: 'changed', secretSuppressed: true, notCarried: true, diff: `(${f.path}: 書き足しがあるが、秘密らしい記述があるため引き継がない。先に除去してください)` });
        } else {
          carried.push({ path: f.path, content: oldText });
          entries.push({ path: f.path, status: 'carried', diff: '' });
        }
        continue;
      }
      entries.push({
        path: f.path,
        status: 'changed',
        // relocated: 以前の配置 (sourcePath) から新しい場所へ移す
        ...(relocated ? { relocated: true, sourcePath, sourceSha256: oldHash, sameContent: oldHash === f.sha256 } : {}),
        counts: countChanges(oldText, f.content),
        secretSuppressed: hasSecret,
        diff: hasSecret
          ? `(${f.path}: 比較元に秘密らしい記述があるため差分を表示しない。先に除去してください)`
          : redactSecrets(formatDiff(oldText, f.content, { oldLabel: `${f.path} (既存)`, newLabel: `${f.path} (新)` })),
      });
    }
  }
  if (manifestText !== null) snapshot.push({ path: manifestRel, sha256: sha256Hex(manifestText) });
  if (oldManifest && Array.isArray(oldManifest.files)) {
    for (const mf of oldManifest.files) {
      if (mf && typeof mf.path === 'string' && !planPaths.has(mf.path) && !usedSources.has(mf.path)) {
        entries.push({ path: mf.path, status: 'removed', diff: '' });
      }
    }
  }
  const sourceDigest = sha256Hex(stableStringify(snapshot));
  return {
    fromDir: from,
    oldManifestDigest: oldManifest?.planDigest ?? null,
    newDigest: plan.digest,
    sourceDigest,
    // 確認対象 = 新 plan + 比較元スナップショット。どちらかが変わると一致しない。
    confirmDigest: sha256Hex(carry ? `${plan.digest}|${sourceDigest}` : `${plan.digest}|${sourceDigest}|fresh`),
    entries,
    carried,
    manifestRel,
  };
}

// 差分確認済みの regenerate。比較元が確認後に変わっていれば拒否。比較元は変更しない。
// fresh: 書き足された作業文書を引き継がず、すべてテンプレートから作る。
export function regenerateToDir({ plan, fromDir, outDir, confirmDigest, unattended = false, fresh = false, now = new Date().toISOString() }) {
  if (unattended) throw new GenerateError('無人モード (--unattended) では生成しません。');
  const report = diffAgainstExisting(plan, fromDir, { carry: !fresh });
  const out = resolveLocal(outDir, 'out');
  if (out.toLowerCase() === report.fromDir.toLowerCase() || isInside(report.fromDir, out)) {
    throw new GenerateError('--out は比較元 (--from) と別の新規フォルダにしてください');
  }
  if (!digestMatches(confirmDigest, report.confirmDigest)) {
    throw new GenerateError(
      `確認済み digest が現在の差分 (設定 + 比較元スナップショット) と一致しません。設定か比較元が確認後に変わった可能性があります。regenerate を再実行して確認し直してください。\n  期待: ${report.confirmDigest}`,
    );
  }
  const overrides = new Map(report.carried.map((c) => [c.path, c.content]));
  const r = generateToDir({ plan, outDir: out, confirmDigest: plan.digest, unattended, now, overrides, action: 'regenerate' });
  return { ...r, report };
}

export function formatDiffReport(report) {
  const lines = [];
  lines.push(`比較元: ${report.fromDir}`);
  lines.push(`既存 manifest digest: ${report.oldManifestDigest ?? '(manifest なし)'}`);
  lines.push(`新 plan digest: ${report.newDigest}`);
  lines.push(`確認用 digest (設定 + 比較元スナップショット): ${report.confirmDigest}`);
  for (const e of report.entries) {
    const extra = e.counts ? ` (+${e.counts.added} / -${e.counts.removed})` : '';
    const label = e.status === 'carried' ? '引き継ぐ (書き足しがあるため、比較元の内容をそのまま新しい出力へコピー)' : e.status;
    lines.push(`- ${e.path}: ${label}${extra}`);
  }
  for (const e of report.entries) {
    if (e.diff) {
      lines.push('');
      lines.push(e.diff);
    }
  }
  lines.push('');
  if (report.carried.length) lines.push('引き継ぐ文書には新しいテンプレートの変更は入りません。すべてテンプレートから作り直すには --fresh を付けます。');
  lines.push('比較元は変更しません。確認後に別の新規出力フォルダへ生成します。');
  return lines.join('\n');
}
