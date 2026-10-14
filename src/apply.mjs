// apply: このツールが生成した既存案件フォルダの管理文書を、設定に合わせて直接更新する。
// 差分提示 → 確認 digest 一致時のみ → 変更前をバックアップしてから書く。途中失敗は元へ戻す。
// 触るのは生成物 (管理文書 + manifest) だけ。案件のコードや他のファイルは読まない・書かない。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TOOL_NAME, ENTRY_FILE, CONFIG_FILE_NAME, MANIFEST_FILE_NAME, WORKING_DOCS, RULES_FILE_NAME } from './constants.mjs';
import { digestMatches } from './plan.mjs';
import { GenerateError, buildManifest, diffAgainstExisting } from './generate.mjs';
import { lstatSafe, isRegularFileNoLink, isDirNoLink } from './safepath.mjs';
import { sha256Hex, stableStringify } from './text.mjs';
import { findExisting, baseName, toNative, isManagedPlace, SETTINGS_DIR } from './layout.mjs';
import { parseConfigText, settingFollowups, keptDocFollowups, appendFollowups } from './followup.mjs';

// バックアップの置き場所。以前の配置 (root) ではルートの .psw-backup、いまの配置 (folders) では設定用フォルダの中。
export const BACKUP_DIR_NAME = '.psw-backup';
export const BACKUP_DIR_IN_SETTINGS = `${SETTINGS_DIR}/backup`;
export function backupRelOf(plan) {
  return plan?.layout === 'folders' ? BACKUP_DIR_IN_SETTINGS : BACKUP_DIR_NAME;
}

// 退避 (不要になった入口など) の対象にしてよい生成物名。manifest の記載は不信な資料なので、これ以外は触らない。
const GENERATED_NAMES = new Set([CONFIG_FILE_NAME, 'PROJECT.md', 'WORKFLOW.md', 'TASKS.md', 'VALIDATION.md', 'START.md', RULES_FILE_NAME, 'CONTEXT.md', 'USER_TESTS.md', 'BACKLOG.md', ...Object.values(ENTRY_FILE)]);
// 相対パスが、このツールの置き場所にある生成物の名前か
const isGeneratedPath = (rel) => isManagedPlace(rel) && GENERATED_NAMES.has(baseName(rel));
const abs = (target, rel) => path.join(target, toNative(rel));

function readManifest(target) {
  const rel = findExisting(target, MANIFEST_FILE_NAME);
  if (!rel) return null;
  const p = abs(target, rel);
  if (!isRegularFileNoLink(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// 更新内容の確認 (読取のみ)。blockers があれば apply できない。
// adopt: このツールの生成物ではないフォルダ (manifest なし) へ管理文書を導入する。同名の既存ファイルは残し、
//        replace に挙げたものだけをバックアップして置き換える。
export function planApply(plan, targetDir, { adopt = false, replace = [] } = {}) {
  const report = diffAgainstExisting(plan, targetDir, { carry: false });
  const target = report.fromDir;
  const blockers = [];
  const manifest = readManifest(target);
  const generated = !!manifest && manifest.tool === TOOL_NAME && Array.isArray(manifest.files);
  const manifestRel = plan.manifestPath ?? MANIFEST_FILE_NAME;
  const manifestPath = abs(target, manifestRel);
  // 以前の配置の記録 (ルートの manifest) があり、新しい置き場所が違うとき: 書いたあとで古いほうを退避する
  const legacyManifestRel = report.manifestRel && report.manifestRel !== manifestRel ? report.manifestRel : null;
  if (!generated && !adopt) {
    blockers.push(`${MANIFEST_FILE_NAME} がないか読めません。このツールで生成していない案件へ導入するには --adopt を付けます (同名の既存ファイルは残し、--replace で指定したものだけ置き換えます)。`);
  }
  if (generated && adopt) blockers.push('このフォルダは既にこのツールの生成物です。--adopt は不要です。');
  if (lstatSafe(manifestPath) && !isRegularFileNoLink(manifestPath)) blockers.push(`${MANIFEST_FILE_NAME}: 既存だが通常ファイルではありません。`);
  // --replace は、生成対象のパス (docs/TASKS.md) でも名前 (TASKS.md) でも指定できる
  const planPaths = plan.files.map((f) => f.path);
  const replacePaths = new Set();
  for (const r of replace) {
    const hit = planPaths.find((p) => p === r) ?? planPaths.find((p) => baseName(p) === r);
    if (!hit) blockers.push(`--replace の ${r} は生成対象のファイル名ではありません。`);
    else replacePaths.add(hit);
  }
  const oldHash = new Map();
  for (const mf of manifest?.files ?? []) {
    if (mf && typeof mf.path === 'string' && typeof mf.sha256 === 'string') oldHash.set(mf.path, mf.sha256);
  }

  const entries = [];
  const removals = [];
  const kept = [];
  for (const e of report.entries) {
    const file = abs(target, e.path);
    if (e.status === 'removed') {
      if (!isGeneratedPath(e.path)) {
        kept.push({ path: e.path, note: '生成物の名前ではないため触らない' });
        continue;
      }
      if (!lstatSafe(file)) continue;
      if (!isRegularFileNoLink(file)) {
        kept.push({ path: e.path, note: '通常ファイルではない/リンクを経由するため触らない' });
        continue;
      }
      const cur = sha256Hex(fs.readFileSync(file, 'utf8'));
      if (cur === oldHash.get(e.path)) removals.push({ path: e.path, sha256: cur });
      else kept.push({ path: e.path, note: '生成後に手で変更されているため残す (要確認: 不要なら手動で整理)' });
      continue;
    }
    if (lstatSafe(file) && (e.status === 'added' || !isRegularFileNoLink(file))) {
      blockers.push(`${e.path}: 既存だが安全に読めません (リンク/通常ファイル以外/大きすぎる)。`);
    }
    if (adopt && e.status === 'changed' && !replacePaths.has(e.path)) {
      kept.push({ path: e.path, note: '既存のファイルのため残す (置き換えるには --replace に指定。置き換えた場合、変更前はバックアップへ)' });
      entries.push({ ...e, status: 'kept', skip: true, existing: true });
      continue;
    }
    // いまの内容が、記録 (manifest) の内容と違う = 生成後に手で変更されている。以前の配置から移す場合は、移す元で比べる
    const sourceRel = e.sourcePath ?? e.path;
    const sourceFile = abs(target, sourceRel);
    const handEdited =
      e.status === 'changed' && oldHash.has(sourceRel) && isRegularFileNoLink(sourceFile) && sha256Hex(fs.readFileSync(sourceFile, 'utf8')) !== oldHash.get(sourceRel);
    if (handEdited && WORKING_DOCS.includes(baseName(e.path))) {
      if (e.relocated) {
        // 書き足された作業文書: 中身は変えずに、新しい場所へ移す
        entries.push({ ...e, status: 'moved', diff: '', handEdited, carry: true });
      } else {
        kept.push({ path: e.path, note: '生成後に書き足された作業文書のため上書きしない (要確認: 役割の記述などは必要なら手で直す)' });
        entries.push({ ...e, status: 'kept', diff: '', handEdited, skip: true });
      }
      continue;
    }
    if (e.secretSuppressed) {
      blockers.push(`${e.path}: 秘密らしい記述があり差分を表示できないため更新しません。先に除去してください。`);
    }
    entries.push({ ...e, handEdited });
  }

  // 更新後の対応: 設定の変更にともなって案件側の AI が行う作業を、課題表の末尾へ追記する (既存の行は変えない)。
  // このツールの生成物の更新だけが対象。導入 (--adopt) では、同名の既存ファイルを変えない約束を守る。
  let followup = null;
  const tasksEntry = entries.find((e) => baseName(e.path) === 'TASKS.md');
  if (generated && !adopt && blockers.length === 0 && tasksEntry) {
    const oldCfgRel = findExisting(target, CONFIG_FILE_NAME);
    const oldCfgFile = oldCfgRel ? abs(target, oldCfgRel) : null;
    const oldCfg = oldCfgFile && isRegularFileNoLink(oldCfgFile) ? parseConfigText(fs.readFileSync(oldCfgFile, 'utf8'), { previous: true }) : null;
    const newCfgFile = plan.files.find((f) => baseName(f.path) === CONFIG_FILE_NAME);
    const newCfg = newCfgFile ? parseConfigText(newCfgFile.content) : null;
    const planHash = new Map(plan.files.map((f) => [f.path, f.sha256]));
    // 書き足しがあって残した作業文書のうち、ひな型そのものが生成時から変わったもの
    const keptChanged = entries.filter((e) => e.skip && e.handEdited && planHash.get(e.path) !== oldHash.get(e.sourcePath ?? e.path)).map((e) => e.path);
    const fromDisk = tasksEntry.skip || tasksEntry.carry;
    const base = fromDisk ? fs.readFileSync(abs(target, tasksEntry.sourcePath ?? tasksEntry.path), 'utf8') : plan.files.find((f) => f.path === tasksEntry.path).content;
    const appended = appendFollowups(base, [...settingFollowups(oldCfg, newCfg), ...keptDocFollowups(keptChanged)]);
    if (appended) followup = { path: tasksEntry.path, lines: appended.lines, block: appended.block, content: appended.content, sha256: sha256Hex(appended.content) };
  }

  // ないときだけ作るファイル。既にあれば内容を読まず、比較も上書きもしない。
  const seeds = [];
  const seedsExisting = [];
  for (const s of plan.seeds ?? []) {
    if (lstatSafe(abs(target, s.path))) seedsExisting.push(s.path);
    else seeds.push({ path: s.path, sha256: s.sha256 });
  }
  // 以前の配置から移すもの (移したあと、元のファイルはバックアップへ)
  const relocations = entries.filter((e) => e.relocated && !e.skip).map((e) => ({ from: e.sourcePath, to: e.path, sha256: e.sourceSha256 }));
  const todo = entries.filter((e) => e.status !== 'same' && !e.skip).length + removals.length + seeds.length + (legacyManifestRel ? 1 : 0) + (followup ? 1 : 0);
  const extra = `${seeds.length ? `|seeds|${stableStringify(seeds)}` : ''}${relocations.length || legacyManifestRel ? `|relocate|${stableStringify({ relocations, legacyManifestRel })}` : ''}${followup ? `|followup|${followup.path}|${followup.sha256}` : ''}`;
  return {
    targetDir: target,
    entries,
    removals,
    kept,
    seeds,
    seedsExisting,
    followup,
    relocations,
    legacyManifestRel,
    manifestRel,
    backupRel: backupRelOf(plan),
    // .git があるか (存在だけを見る。中は読まない)
    gitPresent: !!lstatSafe(path.join(target, '.git')),
    blockers,
    nothingToDo: todo === 0 && !(adopt && !generated),
    adopt,
    manifestExists: !!lstatSafe(manifestPath),
    newDigest: plan.digest,
    // regenerate の確認 digest とは別物にする (承認を使い回せない)。退避・移動・新規作成の対象も確認対象に含める。
    confirmDigest: sha256Hex(`apply|${report.confirmDigest}|${stableStringify(removals)}${extra}${adopt ? `|adopt|${stableStringify([...replacePaths].sort())}` : ''}`),
  };
}

function backupStamp(now) {
  return `${String(now).replace(/[^0-9TZ]/g, '')}-${randomBytes(3).toString('hex')}`;
}

// 書き込み先が、このツールの置き場所 (ルート直下、docs/、initial-settings/) であることを確かめ、必要ならフォルダを作る
function ensureManagedDest(target, rel) {
  if (!isManagedPlace(rel)) throw new GenerateError(`不正な出力パス: ${rel}`);
  const dest = abs(target, rel);
  const dir = path.dirname(dest);
  if (dir !== target) {
    if (path.dirname(dir) !== target) throw new GenerateError(`不正な出力パス: ${rel}`);
    if (!lstatSafe(dir)) fs.mkdirSync(dir, { recursive: false });
    if (!isDirNoLink(dir)) throw new GenerateError(`出力先のフォルダが通常フォルダではありません: ${dir}`);
  }
  return dest;
}

// onWrite: 1 ファイル置換するたびに呼ぶ (試験で途中失敗を起こすため)。
export function applyToDir({ plan, targetDir, confirmDigest, unattended = false, now = new Date().toISOString(), onWrite = null, adopt = false, replace = [] }) {
  if (unattended) throw new GenerateError('無人モード (--unattended) では更新しません。承認は推測しません。');
  if (!plan.canGenerate) {
    const req = plan.needsConfirmation.filter((n) => n.required).map((n) => `${n.field}: ${n.message}`);
    throw new GenerateError(`必須項目が未回答のため更新できません:\n  - ${req.join('\n  - ')}`);
  }
  const report = planApply(plan, targetDir, { adopt, replace });
  if (report.blockers.length) throw new GenerateError(`更新できません:\n  - ${report.blockers.join('\n  - ')}`);
  if (!digestMatches(confirmDigest, report.confirmDigest)) {
    throw new GenerateError(
      `確認済み digest が現在の差分 (設定 + 対象フォルダのスナップショット) と一致しません。設定か対象が確認後に変わった可能性があります。apply を再実行して確認し直してください。\n  期待: ${report.confirmDigest}`,
    );
  }
  if (report.nothingToDo) return { ...report, written: [], moved: [], backupDir: null };

  const target = report.targetDir;
  // 以前の記録を、書き換える前に読んでおく (履歴を引き継ぐ)
  const previousManifest = readManifest(target);
  const backupRoot = abs(target, report.backupRel);
  // 設定用フォルダの中に置く場合は、先にそのフォルダを用意する (リンクを経由しないことも確かめる)
  if (path.dirname(backupRoot) !== target) ensureManagedDest(target, `${SETTINGS_DIR}/backup`);
  if (lstatSafe(backupRoot) && !isDirNoLink(backupRoot)) throw new GenerateError(`バックアップ先が通常フォルダではありません: ${backupRoot}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  // フォルダ内に「全部無視」の .gitignore を置く。案件が git 管理でも未追跡に出ず、案件側の .gitignore を書き換えずに済む。
  const ignoreFile = path.join(backupRoot, '.gitignore');
  if (!lstatSafe(ignoreFile)) fs.writeFileSync(ignoreFile, '*' + String.fromCharCode(10), { encoding: 'utf8', flag: 'wx' });
  const backupDir = path.join(backupRoot, backupStamp(now));
  fs.mkdirSync(backupDir, { recursive: false });
  const backupPath = (rel) => {
    const p = path.join(backupDir, toNative(rel));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };

  const byPath = new Map(plan.files.map((f) => [f.path, f]));
  const writes = report.entries
    .filter((e) => e.status !== 'same' && !e.skip)
    .map((e) => ({
      path: e.path,
      // 書き足された作業文書を移すときは、いまの中身をそのまま新しい場所へ書く
      content: e.carry ? fs.readFileSync(abs(target, e.sourcePath), 'utf8') : byPath.get(e.path).content,
      // 移す場合、書き込み先にはまだ何もない
      existed: e.status === 'changed' && !e.relocated,
    }));
  const seedByPath = new Map((plan.seeds ?? []).map((s) => [s.path, s]));
  for (const s of report.seeds) writes.push({ path: s.path, content: seedByPath.get(s.path).content, existed: false });
  // 更新後の対応を、課題表の末尾へ追記する (残した課題表にも書く。変更前はバックアップへ)
  if (report.followup) {
    const w = writes.find((x) => x.path === report.followup.path);
    if (w) w.content = report.followup.content;
    else writes.push({ path: report.followup.path, content: report.followup.content, existed: true });
  }
  // 書いたあとでバックアップへ移すもの: 不要になった生成物、以前の配置の元ファイル、以前の配置の記録
  const toMove = [...report.removals.map((r) => r.path), ...report.relocations.map((r) => r.from)];
  if (report.legacyManifestRel) toMove.push(report.legacyManifestRel);
  const manifestContent = buildManifest(plan, now, {
    action: adopt ? 'adopt' : 'apply',
    previous: previousManifest,
    changed: writes.map((w) => w.path),
    moved: toMove,
    kept: report.kept.map((k) => k.path),
  });
  writes.push({ path: report.manifestRel, content: stableStringify(manifestContent, 2) + String.fromCharCode(10), existed: report.manifestExists });

  const done = [];
  const moved = [];
  try {
    // 1) 変更前を退避 (コピー)
    for (const w of writes) {
      if (!w.existed) continue;
      fs.copyFileSync(abs(target, w.path), backupPath(w.path), fs.constants.COPYFILE_EXCL);
    }
    // 2) 一時ファイルへ書いてから置き換える
    for (const w of writes) {
      const dest = ensureManagedDest(target, w.path);
      const tmp = `${dest}.psw-tmp-${randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, w.content, { encoding: 'utf8', flag: 'wx' });
      try {
        fs.renameSync(tmp, dest);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      done.push(w);
      if (onWrite) onWrite(w.path);
    }
    // 3) 不要になった生成物と、移し終えた元のファイルをバックアップへ移す。削除はしない。
    for (const rel of toMove) {
      if (!isManagedPlace(rel)) throw new GenerateError(`不正な退避対象: ${rel}`);
      fs.renameSync(abs(target, rel), backupPath(rel));
      moved.push(rel);
    }
  } catch (e) {
    for (const p of moved.reverse()) {
      try {
        fs.renameSync(path.join(backupDir, toNative(p)), abs(target, p));
      } catch {
        /* 復元失敗はバックアップに残る */
      }
    }
    for (const w of done.reverse()) {
      try {
        if (w.existed) fs.copyFileSync(path.join(backupDir, toNative(w.path)), abs(target, w.path));
        else fs.rmSync(abs(target, w.path), { force: true });
      } catch {
        /* 復元失敗はバックアップに残る */
      }
    }
    throw new GenerateError(`更新に失敗したため元へ戻しました (変更前はバックアップにもあります: ${backupDir}): ${e.message}`);
  }
  return { ...report, written: writes.map((w) => w.path), moved, backupDir };
}

export function formatApplyReport(report) {
  const L = [];
  L.push(`対象: ${report.targetDir}`);
  L.push(`新 plan digest: ${report.newDigest}`);
  L.push(`確認用 digest (設定 + 対象スナップショット): ${report.confirmDigest}`);
  for (const e of report.entries) {
    const extra = e.counts ? ` (+${e.counts.added} / -${e.counts.removed})` : '';
    if (e.skip) continue;
    const hand = e.handEdited && !e.carry ? ' ※生成後に手で変更されています (上書きされ、変更前はバックアップへ)' : '';
    if (e.carry) L.push(`- ${e.path}: ${e.sourcePath} から移す (書き足しがあるので中身は変えない)`);
    else if (e.relocated) L.push(`- ${e.path}: ${e.sourcePath} から移す${e.sameContent ? ' (中身は同じ)' : `。中身も更新${extra}`}${hand}`);
    else L.push(`- ${e.path}: ${e.status}${extra}${hand}`);
  }
  if (report.legacyManifestRel) L.push(`- ${report.manifestRel}: ${report.legacyManifestRel} から移す (記録)`);
  for (const r of report.removals) L.push(`- ${r.path}: 不要になるためバックアップへ移動 (削除はしない)`);
  for (const k of report.kept) L.push(`- ${k.path}: そのまま残す — ${k.note}`);
  if (report.followup) L.push(`- ${report.followup.path}: 末尾に「ウィザード更新後の対応」を追記する (案件側の AI が行う作業 ${report.followup.lines.length} 件。既存の行は変えない。変更前はバックアップへ)`);
  for (const s of report.seeds ?? []) L.push(`- ${s.path}: added (なかったので、おすすめの内容で新しく作る)`);
  for (const p of report.seedsExisting ?? []) L.push(`- ${p}: 既にあるので触らない`);
  if (report.gitPresent === false) L.push('- git: このフォルダは git 管理ではありません (.git がない)。開始は最初のセッションの初期確認で行います');
  for (const e of report.entries) {
    if (e.diff && (!e.skip || e.existing)) {
      L.push('');
      L.push(e.diff);
    }
  }
  if (report.followup) {
    L.push('');
    L.push(`+++ ${report.followup.path} (末尾に追記)`);
    for (const line of report.followup.block.trimEnd().split('\n')) L.push(`+${line}`);
  }
  L.push('');
  if (report.blockers.length) {
    L.push('更新不可:');
    for (const b of report.blockers) L.push(`  - ${b}`);
  } else if (report.nothingToDo) {
    L.push('差分はありません。更新するものはありません。');
  } else {
    if (report.adopt) L.push('導入: ない文書だけを新しく作ります。同名の既存ファイルは、--replace に指定したもの以外は変更しません (上の差分は置き換えた場合の内容)。');
    if (report.relocations?.length || report.legacyManifestRel) L.push('文書の置き場所を移します (入口はルート、ほかの文書は docs/、設定と記録は initial-settings/)。移したあと、元のファイルはバックアップへ移します。');
    L.push(`更新は対象フォルダの管理文書だけに行い、変更前を ${report.backupRel ?? BACKUP_DIR_NAME}/<日時>/ に残します。`);
  }
  return L.join('\n');
}
