// 既存ルール優先の変更案。AI が作った文書案を CLI が差分・承認・バックアップ付きで反映する。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MODE_NAMES } from './constants.mjs';
import { normalizeAiPreferences } from './ai-preferences.mjs';
import { readConfigFile, detectSecretPatterns, scanSecrets, redactSecrets } from './config.mjs';
import { resolveLocal, isDirNoLink, isRegularFileNoLink, lstatSafe, isDeniedName } from './safepath.mjs';
import { sha256Hex, stableStringify } from './text.mjs';
import { formatDiff, countChanges } from './diff.mjs';
import { digestMatches } from './plan.mjs';
import { GenerateError } from './generate.mjs';

const DEFAULT_DOCUMENTS = ['AGENTS.md', 'CLAUDE.md', 'WORKFLOW.md', 'PROJECT.md', 'TASKS.md', 'VALIDATION.md', 'START.md', 'RULES.md'];
function documentName(name) {
  return typeof name === 'string' && name.length <= 255 && /^[^\\/:*?"<>|\x00-\x1f]+\.md$/i.test(name) && !name.startsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) && !isDeniedName(name);
}

export function validateManagedChanges(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GenerateError('変更案はオブジェクトで指定してください');
  const keys = ['schemaVersion', 'documents', 'files', 'remove', 'mode', 'handoff', 'ai'];
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new GenerateError('変更案に不明なキーがあります');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new GenerateError('変更案の schemaVersion は 1 です');
  if (scanSecrets(raw).length) throw new GenerateError('変更案に秘密らしい記述があります (値は非表示)');
  if (raw.mode && !MODE_NAMES.includes(raw.mode)) throw new GenerateError('変更案の mode が不正です');
  if (raw.handoff && !['manual', 'cli', 'none'].includes(raw.handoff)) throw new GenerateError('変更案の handoff が不正です');
  const documents = raw.documents ?? DEFAULT_DOCUMENTS;
  if (!Array.isArray(documents) || documents.some(name => !documentName(name))) throw new GenerateError('管理文書は対象直下の通常の md 名に限ります');
  const allowed = new Set([...DEFAULT_DOCUMENTS, ...documents]);
  if (!Array.isArray(raw.files) || (raw.remove !== undefined && !Array.isArray(raw.remove))) throw new GenerateError('files / remove は配列で指定してください');
  const seen = new Set();
  const check = name => {
    if (!allowed.has(name) || seen.has(name)) throw new GenerateError('管理文書以外、または重複した変更対象です');
    seen.add(name);
  };
  for (const file of raw.files) {
    if (!file || typeof file !== 'object' || Object.keys(file).some(key => !['path', 'content'].includes(key))) throw new GenerateError('変更ファイルの形が不正です');
    check(file.path);
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content) > 2 * 1024 * 1024) throw new GenerateError('文書案は 2 MiB 以下の文字列に限ります');
  }
  for (const name of raw.remove ?? []) check(name);
  let ai;
  try { ai = normalizeAiPreferences(raw.ai); } catch (error) { throw new GenerateError(error.message); }
  return { schemaVersion: 1, documents: [...allowed].sort(), files: raw.files.map(file => ({ ...file })), remove: [...(raw.remove ?? [])], mode: raw.mode ?? '', handoff: raw.handoff ?? '', ai };
}

export function loadManagedChanges(filename) { return validateManagedChanges(readConfigFile(filename)); }

export function planManagedEdits(raw, targetDir) {
  const changes = validateManagedChanges(raw);
  const target = resolveLocal(targetDir, 'target');
  if (!isDirNoLink(target)) throw new GenerateError('更新対象が存在しないか、リンクを経由しています');
  const entries = [];
  for (const item of [...changes.files, ...changes.remove.map(name => ({ path: name, content: null }))]) {
    const filename = path.join(target, item.path);
    const exists = lstatSafe(filename);
    let original = null;
    if (exists) {
      if (!isRegularFileNoLink(filename) || exists.size > 2 * 1024 * 1024) throw new GenerateError(`${item.path}: 安全に読めない管理文書です`);
      original = fs.readFileSync(filename);
      if (detectSecretPatterns(original.toString('utf8')).length) throw new GenerateError(`${item.path}: 秘密らしい記述があるため変更しません (値は非表示)`);
    }
    const content = item.content;
    const oldText = original?.toString('utf8') ?? '';
    const status = content === null ? (original ? 'removed' : 'same') : original && original.equals(Buffer.from(content)) ? 'same' : original ? 'changed' : 'added';
    entries.push({ path: item.path, content, originalHash: original ? sha256Hex(original) : null, status, counts: countChanges(oldText, content ?? ''), diff: redactSecrets(formatDiff(oldText, content ?? '', { oldLabel: item.path + ' (既存)', newLabel: item.path + ' (変更後)' })) });
  }
  const basis = { changes, snapshots: entries.map(entry => ({ path: entry.path, originalHash: entry.originalHash })) };
  return { targetDir: target, changes, entries, blockers: [], nothingToDo: entries.every(entry => entry.status === 'same'), editDigest: sha256Hex(stableStringify(basis)), confirmDigest: sha256Hex('revise|' + target + '|' + stableStringify(basis)) };
}

export function applyManagedEdits({ changes, targetDir, confirmDigest, unattended = false, now = new Date().toISOString(), onWrite = null }) {
  if (unattended) throw new GenerateError('無人モードでは更新しません');
  const report = planManagedEdits(changes, targetDir);
  if (!digestMatches(confirmDigest, report.confirmDigest)) throw new GenerateError('変更案か対象が確認後に変わったため digest が一致しません');
  if (report.nothingToDo) return { ...report, written: [], backupDir: null };
  const root = path.join(report.targetDir, '.psw-backup');
  if (lstatSafe(root) && !isDirNoLink(root)) throw new GenerateError('バックアップ先がリンクまたは通常フォルダ以外です');
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!lstatSafe(ignore)) fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
  const backup = path.join(root, String(now).replace(/[^0-9TZ]/g, '') + '-' + randomBytes(4).toString('hex'));
  fs.mkdirSync(backup);
  const done = [];
  try {
    for (const entry of report.entries.filter(entry => entry.status !== 'same')) {
      const destination = path.join(report.targetDir, entry.path);
      if (entry.originalHash) {
        if (!isRegularFileNoLink(destination) || sha256Hex(fs.readFileSync(destination)) !== entry.originalHash) throw new GenerateError('書き込み前に対象文書が変わりました');
        fs.copyFileSync(destination, path.join(backup, entry.path), fs.constants.COPYFILE_EXCL);
      } else if (lstatSafe(destination)) throw new GenerateError('書き込み前に文書が作られました');
      if (entry.content === null) fs.unlinkSync(destination);
      else if (!entry.originalHash) fs.writeFileSync(destination, entry.content, { flag: 'wx' });
      else {
        const temporary = destination + '.psw-tmp-' + randomBytes(4).toString('hex');
        fs.writeFileSync(temporary, entry.content, { flag: 'wx' });
        try { fs.renameSync(temporary, destination); }
        catch (error) { fs.unlinkSync(temporary); throw error; }
      }
      done.push(entry);
      if (onWrite) onWrite(entry.path);
    }
  } catch (error) {
    for (const entry of done.reverse()) {
      const destination = path.join(report.targetDir, entry.path);
      if (entry.originalHash) fs.copyFileSync(path.join(backup, entry.path), destination);
      else if (isRegularFileNoLink(destination)) fs.unlinkSync(destination);
    }
    throw new GenerateError(`変更を戻しました。バックアップ: ${backup} (${redactSecrets(error.message)})`);
  }
  return { ...report, written: done.map(entry => entry.path), backupDir: backup };
}

export function formatManagedReport(report) {
  return [`対象: ${report.targetDir}`, `確認用 digest: ${report.confirmDigest}`, ...report.entries.map(entry => `- ${entry.path}: ${entry.status} (+${entry.counts.added} / -${entry.counts.removed})`), ...report.entries.filter(entry => entry.status !== 'same').map(entry => entry.diff)].join('\n');
}
