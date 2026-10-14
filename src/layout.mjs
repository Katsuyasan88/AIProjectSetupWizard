// 文書の配置。
//   folders (既定): 入口 (AGENTS.md / CLAUDE.md) だけをルートに置き、ほかの文書は docs/、
//                   設定と記録 (setup.config.json / generated.manifest.json) は initial-settings/ に置く。
//   root          : すべてルートに置く (以前の配置)。
// テンプレート (render*.mjs) はルート前提の名前とリンクで書き、生成の最後にここで配置を変える。
import path from 'node:path';
import { ENTRY_FILE, CONFIG_FILE_NAME, MANIFEST_FILE_NAME } from './constants.mjs';
import { lstatSafe } from './safepath.mjs';

export const LAYOUTS = Object.freeze(['folders', 'root']);
export const DEFAULT_LAYOUT = 'folders';
export const DOCS_DIR = 'docs';
export const SETTINGS_DIR = 'initial-settings';
// このツールがファイルを置いてよいフォルダ (ルート以外)
export const MANAGED_DIRS = Object.freeze([DOCS_DIR, SETTINGS_DIR]);

const ENTRY_NAMES = new Set(Object.values(ENTRY_FILE));
const SETTINGS_NAMES = new Set([CONFIG_FILE_NAME, MANIFEST_FILE_NAME]);

export function layoutOf(cfg) {
  return LAYOUTS.includes(cfg?.layout) ? cfg.layout : DEFAULT_LAYOUT;
}

// 名前 (ルート前提) → その配置での相対パス ('/' 区切り)
export function placeOf(name, layout) {
  if (layout !== 'folders' || ENTRY_NAMES.has(name)) return name;
  if (SETTINGS_NAMES.has(name)) return `${SETTINGS_DIR}/${name}`;
  return name.endsWith('.md') ? `${DOCS_DIR}/${name}` : name;
}

export const baseName = (rel) => rel.split('/').pop();
// 相対パスが、このツールの置き場所 (ルート直下、docs/、initial-settings/) にあるか
export function isManagedPlace(rel) {
  const parts = rel.split('/');
  return parts.length === 1 || (parts.length === 2 && MANAGED_DIRS.includes(parts[0]));
}
export const toNative = (rel) => rel.split('/').join(path.sep);

// 既存のフォルダで、その名前のファイルがどこにあるか (新しい配置を先に見る)。なければ null
export function findExisting(targetDir, name) {
  for (const rel of [placeOf(name, 'folders'), name]) {
    if (lstatSafe(path.join(targetDir, toNative(rel)))) return rel;
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 文中の「NAME.md」を「docs/NAME.md」にする (既にパスの一部になっているものは除く)
function prefixNames(text, names) {
  let out = text;
  for (const n of names) out = out.replace(new RegExp(`(?<![\\w/.-])${escapeRe(n)}`, 'g'), `${DOCS_DIR}/${n}`);
  return out;
}

// files: [{ path, content }] をその配置へ移し、リンクと文中のパスを直す
export function applyLayout(files, layout) {
  if (layout !== 'folders') return files;
  const moved = files.map((f) => f.path).filter((p) => placeOf(p, layout).startsWith(`${DOCS_DIR}/`));
  for (const f of files) {
    const name = f.path;
    const dest = placeOf(name, layout);
    if (ENTRY_NAMES.has(name)) {
      // ルートの入口: docs/ へ移った文書への参照をすべて docs/NAME にする
      f.content = prefixNames(f.content, moved);
    } else if (dest.startsWith(`${DOCS_DIR}/`)) {
      // docs/ の文書: 同じフォルダの文書へのリンクはそのまま。入口へのリンクは 1 つ上を指す
      let text = f.content;
      for (const e of ENTRY_NAMES) text = text.split(`](${e})`).join(`](../${e})`);
      if (name === 'START.md') {
        // 開始文 (コードブロックの中) は案件のルートで貼って使うので、ルートからのパスで書く
        text = text
          .split('```')
          .map((seg, i) => (i % 2 === 1 ? prefixNames(seg, moved) : seg))
          .join('```');
      }
      f.content = text;
    }
    f.path = dest;
  }
  return files;
}
