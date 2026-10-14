// 更新後の対応: 設定の変更にともなって、案件側の AI にしかできない作業を課題表の末尾へ書く。
// 文書の更新 (正本・入口・START など) は apply が直接行う。ここに並べるのは、文書を直しただけでは終わらないこと
// (デザインルールを決めて適用する、起動の手段を確かめる、書き足した文書へ新しい欄を足す、など)。
// 課題の ID は発行しない (発行するのは案件の主導担当)。作業文書なので担当名 (Codex / Claude) は書かない。
import { TEMPLATE_VERSION, WORKING_DOCS } from './constants.mjs';
import { validateConfig } from './config.mjs';
import { PROFILES, profileOf, launchPolicyOf, pushPolicyOf, isStandard, audienceLabel, LAUNCH_SECTION_NAME } from './render-profile.mjs';
import { baseName } from './layout.mjs';

export const FOLLOWUP_HEADING = '## ウィザード更新後の対応';
const INTRO = '設定の変更にともなって、文書の更新だけでは終わらない作業です。主導担当が読み、必要なものを課題として発行します (ID はここでは振っていません)。済んだ行、不要と決めた行は消してかまいません。';

// 設定 JSON の文字列を、検証済みの設定にする。読めなければ null (不信な資料として扱い、推測しない)
// previous: 更新前の設定として読む。別AIの起動の項目がない設定は、その項目ができる前に作られたもので、
//           当時の文書は毎回承認だった。いまの既定 (主導担当が起動してよい) を当てはめず、毎回承認として読む。
export function parseConfigText(text, { previous = false } = {}) {
  try {
    const raw = JSON.parse(text);
    if (previous && raw && typeof raw === 'object' && !Array.isArray(raw) && raw.launchPolicy === undefined) raw.launchPolicy = 'approval';
    return validateConfig(raw).config;
  } catch {
    return null;
  }
}

const aiKey = (cfg, agent) => JSON.stringify(cfg.ai?.[agent] ?? {});

// 変更前後の設定から、案件側で行う作業を並べる。oldCfg がなければ (読めない・ない)、設定の変更は分からないので並べない。
export function settingFollowups(oldCfg, newCfg) {
  if (!oldCfg || !newCfg) return [];
  const out = [];
  const context = isStandard(newCfg) ? 'CONTEXT.md' : 'TASKS.md の再開メモ';
  if (oldCfg.mode !== newCfg.mode) {
    out.push('- 役割の変更: 課題表・再開メモ・レビューの記録にある担当の記述を、新しい分担に合わせて見直す。一方の AI だけが使える Skill や設定は、新しい分担で使える形に移す案をユーザーに示す (変更は承認後)。');
  }
  if (newCfg.audience && oldCfg.audience !== newCfg.audience) {
    out.push(`- 利用範囲: 「${audienceLabel(newCfg)}」になった。WORKFLOW.md の「利用範囲」を読み、いまのコード・文書・履歴に合わないもの (公開なら利用者に届くものに入った秘密や管理用の情報と、決まっていない個人情報の扱い、会社用なら社外へ出ている会社の情報) がないかを確かめ、直す作業をユーザーに示す。`);
  }
  if (launchPolicyOf(oldCfg) !== launchPolicyOf(newCfg)) {
    if (launchPolicyOf(newCfg) === 'lead-launch') {
      out.push(`- 別AIの起動: 起動の手段と、範囲が WORKFLOW.md の「${LAUNCH_SECTION_NAME}」のとおりでよいかをユーザーに確かめ、初期確認の承認記録に書く。`);
      out.push(`- 別AIの起動: 承認記録や再開メモに書き足した起動の決まりが、WORKFLOW.md の「${LAUNCH_SECTION_NAME}」と食い違っていないかを確かめる。食い違いはユーザーに確認し、古い記述には「正本へ移した」と書き添える。`);
      out.push(`- 別AIの起動: 起動される側の実行環境でできない操作 (コミット、プロセスの起動と停止、環境が要る検証) を確かめ、${context} に書く。`);
    } else {
      out.push('- 別AIの起動: 毎回承認に戻った。承認記録や再開メモに残る継続的な起動の承認は使えないので、ユーザーに確かめたうえで、その旨を書き添える。');
    }
  }
  if (newCfg.envSplit === true && oldCfg.envSplit !== true) {
    out.push(`- 開発用と本番用: それぞれの場所と切り替え方をユーザーに確かめ、${context} に書く (秘密の値は書かない。本番がまだなければ未作成と書く)。`);
    out.push('- 開発用と本番用: いまの認証・設定・接続先・データ・秘密情報・ログが開発用と本番用で共有されていないかを確かめ、分ける作業をユーザーに示す。');
  }
  if (newCfg.uiRules === true && oldCfg.uiRules !== true) {
    out.push(`- 画面の実装の基本: デザインルールをユーザーと決め、決まったことを \`docs/\` のデザインルールの文書に書いて正本にする (文書がなければ、最初に決まったときに作る。決まっていないことを推測で書かない)。場所を ${context} に書く。`);
    out.push('- 画面の実装の基本: 既存の画面で、色・書体・余白などの値や表示文言を直接書いている箇所と、共通部品にできる重複を洗い出す。値と文言の入口・共通部品を決め、移す作業を課題にする。');
    out.push('- 画面の実装の基本: 直接書いた値や文言が混ざっていないかを確かめる手段を決め、実在を確かめてから VALIDATION.md の検証レシピに登録する。');
  }
  for (const agent of ['codex', 'claude']) {
    if (aiKey(oldCfg, agent) !== aiKey(newCfg, agent)) {
      out.push('- モデルの設定: START.md のモデル・effort・代わりの順番が変わった。次に起動するときの設定を合わせ、再開メモや承認記録にある古いモデルの記述を見直す。');
      break;
    }
  }
  if (pushPolicyOf(oldCfg) !== pushPolicyOf(newCfg)) {
    out.push('- push の承認: 扱いが変わった。再開メモや承認記録にある push の記述が、WORKFLOW.md と食い違っていないかを確かめる。');
  }
  if (PROFILES.indexOf(profileOf(newCfg)) > PROFILES.indexOf(profileOf(oldCfg))) {
    out.push('- 運用の段階: 決まりが増えた。WORKFLOW.md の新しい節を読み、いまの課題表・レビューの記録の持ち方を合わせるかをユーザーに確かめる。');
  }
  return out;
}

// 書き足しがあるため上書きしなかった作業文書のうち、ひな型が変わったもの
export function keptDocFollowups(keptPaths) {
  return keptPaths
    .filter((p) => WORKING_DOCS.includes(baseName(p)) && baseName(p) !== 'TASKS.md')
    .map((p) => `- ${baseName(p)}: ウィザードのひな型が変わったが、書き足しがあるため上書きしていない。新しいひな型の欄や書き方のうち要るものを、いまの内容に合わせて足す。`);
}

// 既にある行は足さない (同じ更新を繰り返しても増えない)。足す行がなければ null。
export function appendFollowups(text, lines) {
  const fresh = [...new Set(lines)].filter((line) => !text.includes(line));
  if (fresh.length === 0) return null;
  const head = text.endsWith('\n') ? text : `${text}\n`;
  const block = `${FOLLOWUP_HEADING} (テンプレート版 ${TEMPLATE_VERSION})\n\n${INTRO}\n\n${fresh.join('\n')}\n`;
  return { lines: fresh, block, content: `${head}\n${block}` };
}
