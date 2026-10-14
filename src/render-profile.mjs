// 運用の段階 (profile) ごとの追加内容。
//   minimal  : 最小の骨組み (render.mjs の出力そのまま)
//   standard : 日々の運用の決まりを足す (課題の個票、着手中の印、レビューの記録、ブランチ、報告の書き方、案件の知識の文書)
//   full     : さらに、検討から課題までの流れ、完了の記録と索引、公開・費用・引き継ぎの境界を足す
// 実運用で育った案件の決まりを、案件名・製品の内容・個別の承認を除いて一般化したもの。
// 作業文書 (TASKS / USER_TESTS / BACKLOG / CONTEXT) には担当名を書かない (役割を変えても古くならない)。
import { MODES, ENTRY_FILE } from './constants.mjs';
import { oneLine } from './text.mjs';

export const PROFILES = Object.freeze(['minimal', 'standard', 'full']);
export const DEFAULT_PROFILE = 'standard';
export const CONTEXT_FILE_NAME = 'CONTEXT.md';
export const USER_TESTS_FILE_NAME = 'USER_TESTS.md';
export const BACKLOG_FILE_NAME = 'BACKLOG.md';

export function profileOf(cfg) {
  return PROFILES.includes(cfg?.profile) ? cfg.profile : DEFAULT_PROFILE;
}
const atLeast = (cfg, level) => PROFILES.indexOf(profileOf(cfg)) >= PROFILES.indexOf(level);
export const isStandard = (cfg) => atLeast(cfg, 'standard');
export const isFull = (cfg) => atLeast(cfg, 'full');

const L = Object.freeze({
  WORKFLOW: '[WORKFLOW.md](WORKFLOW.md)',
  PROJECT: '[PROJECT.md](PROJECT.md)',
  TASKS: '[TASKS.md](TASKS.md)',
  VALIDATION: '[VALIDATION.md](VALIDATION.md)',
  START: '[START.md](START.md)',
  CONTEXT: `[${CONTEXT_FILE_NAME}](${CONTEXT_FILE_NAME})`,
  USER_TESTS: `[${USER_TESTS_FILE_NAME}](${USER_TESTS_FILE_NAME})`,
  BACKLOG: `[${BACKLOG_FILE_NAME}](${BACKLOG_FILE_NAME})`,
});

// ---------- 課題の ID 表記を T-000 / T-001 の形にそろえる (全段階) ----------
// render.mjs のテンプレートは `#t0` / `#t1` / `#id` と書いているので、生成の最後にここで置き換える。
export function useTaskIds(text) {
  return text
    .split('課題には `#id` (例: `#t1`) を付け').join('課題には ID (例: `T-001`) を付け')
    .replace(/#t0(?![0-9A-Za-z_-])/g, 'T-000')
    .replace(/#t1(?![0-9A-Za-z_-])/g, 'T-001')
    .split('課題 (#id)').join('課題 (T-xxx)')
    .split('`#id`').join('課題 ID');
}

// ---------- push の承認 (設定の pushPolicy) ----------
//   approval    : push は毎回ユーザーの明示承認が要る (既定)
//   work-branch : 課題の作業ブランチへの push は承認なしでよい。main などほかのブランチへの push、マージ、公開は承認が要る
export const PUSH_POLICIES = Object.freeze(['approval', 'work-branch']);
export const DEFAULT_PUSH_POLICY = 'approval';
export function pushPolicyOf(cfg) {
  return PUSH_POLICIES.includes(cfg?.pushPolicy) ? cfg.pushPolicy : DEFAULT_PUSH_POLICY;
}
const PUSH_BULLET_APPROVAL = '- push は「承認の扱い」のとおり、ユーザーの明示承認が要る。';
const PUSH_BULLET_WORK_BRANCH = '- 課題を提出するときは、作業ブランチへコミットして push してよい (承認は不要)。`main` などほかのブランチへの push、マージ、公開は承認が要る。remote がなければ push せず、その状態を報告する。公開先を独断で作らない。';
// approval の言い回しを work-branch の言い回しへ置き換える対 (テストが、置き換え漏れがないことを確かめる)
export const PUSH_REWRITES = Object.freeze([
  ['承認不要 (通常作業): 編集許可パス内の編集、', '承認不要 (通常作業): 編集許可パス内の編集、課題の作業ブランチへの push (remote が設定済みのとき。`main` などほかのブランチへは push しない)、'],
  ['別AIプロセスの起動、外部公開、push、', '別AIプロセスの起動、外部公開、作業ブランチ以外への push、'],
  ['別AIの起動・公開・push・権限変更は', '別AIの起動・公開・作業ブランチ以外への push・権限変更は'],
  [PUSH_BULLET_APPROVAL, PUSH_BULLET_WORK_BRANCH],
]);
export function applyPushPolicy(text, cfg) {
  if (pushPolicyOf(cfg) !== 'work-branch') return text;
  let out = text;
  for (const [from, to] of PUSH_REWRITES) out = out.split(from).join(to);
  return out;
}

// ---------- 別AIの起動 (設定の launchPolicy) ----------
//   lead-launch : 主導担当が、決めた範囲で実装担当を起動して課題を渡してよい。ほかの承認は変わらない (協働モードの既定)
//   approval    : 別AIの起動は毎回ユーザーの明示承認が要る (単独モードは常にこちら)
export const LAUNCH_POLICIES = Object.freeze(['approval', 'lead-launch']);
export const DEFAULT_LAUNCH_POLICY = 'lead-launch';
export const SOLO_LAUNCH_POLICY = 'approval';
export function launchPolicyOf(cfg) {
  if (!cfg?.mode || MODES[cfg.mode]?.solo) return SOLO_LAUNCH_POLICY;
  return LAUNCH_POLICIES.includes(cfg?.launchPolicy) ? cfg.launchPolicy : DEFAULT_LAUNCH_POLICY;
}
export const LAUNCH_SECTION_NAME = '実装担当の起動';
// approval の言い回しを lead-launch の言い回しへ置き換える対 (push の置き換えのあとにかける。テストが置き換え漏れを確かめる)
export function launchRewrites(m) {
  return [
    ['承認不要 (通常作業): 編集許可パス内の編集、', `承認不要 (通常作業): 編集許可パス内の編集、${m.lead} による ${m.implementer} の起動 (「${LAUNCH_SECTION_NAME}」の範囲内)、`],
    ['別AIプロセスの起動、', `別AIプロセスの起動 (「${LAUNCH_SECTION_NAME}」の範囲を除く)、`],
    ['別AIの起動・', `別AIの起動 (WORKFLOW.md の「${LAUNCH_SECTION_NAME}」の範囲を除く)・`],
  ];
}
export function applyLaunchPolicy(text, cfg) {
  if (launchPolicyOf(cfg) !== 'lead-launch') return text;
  let out = text;
  for (const [from, to] of launchRewrites(MODES[cfg.mode])) out = out.split(from).join(to);
  return out;
}
// WORKFLOW.md の「引継ぎ」に必ず入る 1 行 (どの設定でも、別AIの起動の扱いが分かるようにする)
export function launchLine(cfg) {
  if (MODES[cfg.mode].solo) return '- 別AIの起動: 単独モードのため想定しない。行うときは、毎回ユーザーの明示承認が要る。';
  if (launchPolicyOf(cfg) === 'lead-launch') return `- 別AIの起動: 「${LAUNCH_SECTION_NAME}」の範囲内なら承認不要 (この案件の設定)。範囲外は、毎回ユーザーの明示承認が要る。`;
  return '- 別AIの起動: 毎回ユーザーの明示承認が要る。';
}
// 実運用で育った決まりを一般化したもの (具体的なコマンド名・モデル名・時間の目安は含めない)
export function launchSection(cfg) {
  if (launchPolicyOf(cfg) !== 'lead-launch') return '';
  const { lead, implementer: impl } = MODES[cfg.mode];
  return `## ${LAUNCH_SECTION_NAME}

- この案件の設定により、${lead} は ${impl} を起動して課題を渡してよい。1 回ごとの承認は要らない。ユーザーはいつでも取り消せる (毎回承認へ変えるときは /project-change)。
- 範囲: 合格条件と確認事項がすべて決まった課題の実装と、その差し戻しの修正だけ。${impl} がさらに別の AI を起動することは含まない。
- 含まれない承認: 公開、マージ、作業ブランチ以外への push、依存追加、編集許可パス外の編集、費用を伴う操作は、これまでどおり別に承認を取る。起動された側にも本文書の承認規則がそのまま適用される。
- 起動の設定: ${L.START} のモデルと effort を使う。起動の手段は初期確認 (#t0) でユーザーに確かめ、承認記録に書く。
- 結果の扱い: 起動された側の報告は自己確認として記録する。${lead} が検証レシピを自分で実行してから判定する。
- 肩代わり: ${impl} の実行環境でできない操作 (コミット、プロセスの起動と停止、環境が要る検証) は ${lead} が行い、誰が何をしたかを記録 (レビューの記録、なければ検証の結果記録) に書く。これは実装ファイルを編集する許可ではない。
- 拒否の扱い: 起動された側の実行環境が操作を拒否したら、迂回せずユーザーに判断を求める。
- 終了の確認: 実行が裏で続いている間は判定しない。終わったことを確かめてからレビューする。
- ユーザーが ${L.START} の開始文を貼って引き継ぐこともできる。

`;
}
const LAUNCH_CONFIRM = `実装担当の起動: 起動の手段と、範囲が WORKFLOW.md の「${LAUNCH_SECTION_NAME}」のとおりでよいか`;
export const launchConfirmLine = (cfg) => (launchPolicyOf(cfg) === 'lead-launch' ? LAUNCH_CONFIRM : '');

// ---------- 画面の実装の基本 (設定の uiRules。画面のある案件だけ) ----------
export const UI_SECTION_HEADING = '## 画面の実装の基本';
export const hasUiRules = (cfg) => cfg?.uiRules === true;
const UI_CONTEXT_HEADING = '## 表示の値と文言の入口・共通部品・デザインルールの正本の場所';
export function uiSection(cfg) {
  if (!hasUiRules(cfg)) return '';
  const where = isStandard(cfg) ? `${L.CONTEXT} の「表示の値と文言の入口・共通部品・デザインルールの正本の場所」` : `${L.TASKS} の再開メモ`;
  return `${UI_SECTION_HEADING}

- デザインはユーザーと一緒に決める。決まったこと (色・書体・余白などの値、文言の方針、共通部品) は、そのつど \`docs/\` のデザインルールの文書に書き足し、それを正本にする。文書は最初に決まったときに作る。決まっていないことを推測で書かない。場所は ${where} に書く。
- 正本ができたら、画面を変える前に読む。正本にないことを決める必要があれば、ユーザーに確かめてから正本に足す。
- 色・書体・余白・大きさなどの値と、画面に出す文言を、画面のコードに直接書かない。値と文言の入口を決め、そこを通して使う。
- 画面は共通部品の組み合わせで作る。新しく作る前に既存の共通部品を探し、同じ見た目や操作を画面ごとに作り直さない。一般的な推奨を、既存の共通部品を置き換える理由にしない。
- 直接書いた値や文言が混ざっていないかを確かめる手段を、実在を確かめてから ${L.VALIDATION} の検証レシピに登録する。既存の逸脱は課題にして移す。
- 画面を変えたら、空・読み込み中・エラーの状態、押せる範囲の大きさ、文字を拡大した表示を確かめる。

`;
}
export const uiEntryLine = (cfg) => (hasUiRules(cfg) ? `- 画面を変える前: ${L.WORKFLOW} の「画面の実装の基本」と、デザインルールの正本 (できていれば)。\n` : '');

// 生成の最後に、文書へ共通の仕上げをかける
export function finalizeDocument(text, cfg) {
  return applyLaunchPolicy(applyPushPolicy(useTaskIds(text), cfg), cfg);
}

// ---------- WORKFLOW.md に足す節 ----------
const NOTATION_HEADING = '## TASKS.md の記法';
const CHANGE_HEADING = '## 変更の扱い';

function taskSection(m) {
  const done = m.solo
    ? `完了条件を満たす証拠がそろってから \`[x]\` にする。`
    : `${m.implementer} は着手時に \`[~]\` にできる。\`[x]\` にするのは ${m.lead} だけ (レビューで完了条件を確かめたあと)。`;
  const found = m.solo ? '課題として起こす' : `${m.lead} へ報告し、課題にするかを決めてもらう`;
  return `## 課題の進め方

- 課題は \`T-001\` からの通番。ユーザー本人にしかできない作業は \`U-001\`、本人による確認の手順は \`UT-001\` (${L.USER_TESTS})。発行した ID は改番も再利用もしない。
- ${L.TASKS} は「実行キュー / 一覧 / 詳細」の 3 つで持つ。状態は一覧だけに書く: \`[ ]\` 未着手 / \`[~]\` 着手中 / \`[x]\` 完了。
- 実行キューに入れる課題は、詳細の 6 項目 (目的 / 対象 / 参照ドキュメント / 実装方針 / 完了条件 / 確認事項) を書いてから着手する。完了条件は第三者が判定できる粒度にする。未決の確認事項が残る課題はキューに入れない。
- ${done}本人確認 (UT) や環境での確認が完了条件に含まれる間は \`[~]\` のまま。
- \`[x]\` にする行には必ず \`証跡:\` に続けて所在 (検証結果・レビューの記録・ログ) を書く。空、なし、未確認は証跡ではない。${L.VALIDATION} で同じ ID の結果が OK 以外なら \`[x]\` にしない。
- 実装中に見つけたバグ・TODO・追加の要件は、実装で吸収せず、${found}。
- 課題の ID、ファイル、仕様の版に言及する前に所在を確かめる。存在しないものを推測で扱わない。`;
}

function reviewSection(m) {
  const lines = [
    `- 課題を提出するときに \`reviews/<担当名>/YYYYMMDD_T-xxx_review.md\` を作る。書くこと: 対象の課題、変更したファイル、完了条件ごとの結果、実行した検証、仕様との差と独自の判断、未確認事項、ブランチとコミット。あとで埋めるつもりの空欄を残さない。`,
  ];
  if (m.solo) {
    lines.push('- 自己レビューは自己確認であり、独立レビューではない。記録にもそう書く。');
  } else {
    lines.push(`- ${m.reviewer} の指摘は、全文を \`reviews/${m.reviewer}/YYYYMMDD_T-xxx_review.md\` に保存し、それを指摘の正本にする。「上記の指摘」「コードのコメント」だけで伝えない。${m.implementer} は本文を読めなければ、内容を推測せず提示を求める。`);
    lines.push(`- ${m.reviewer} は、差分・完了条件・検証の証跡・未確認事項を自分で確かめる。判定を返すときは、残る作業・担当・開始条件を示す。`);
  }
  lines.push('- 軽微な修正は、同じ課題・同じブランチ・同じレビュー記録への追記で行う (最初の内容は消さない)。仕様や挙動に関わる是正は、新しい ID を発行する。');
  return `## レビューと是正\n\n${lines.join('\n')}`;
}

function branchSection(m) {
  const who = m.solo ? 'ユーザー' : `ユーザーまたは ${m.reviewer} `;
  return `## ブランチとマージ

- 作業の前に、git 管理かどうか、現在のブランチ、未コミットの差分を確かめる。ほかの作業の差分を混ぜない・消さない。git 管理でなければ、その制約を報告する (開始は初期確認で扱う)。
- git 管理なら 1 課題 1 ブランチ (\`<担当名>/T-xxx-short-name\`)。\`main\` へ直接コミットしない。コミットには対象の課題以外の差分を混ぜない。
- レビューの合格と、マージ・環境への反映・公開の許可は別のもの。マージは、${who}の明示があったときだけ行う。
- 主要な体験、データの構造、API、認証や公開範囲、費用に関わる変更は、ユーザーの判断なしにマージしない。
${PUSH_BULLET_APPROVAL}`;
}

const REPORT_SECTION = `## 報告と検証の書き方

- 確認済み・未確認・推測を分けて書く。
- 実機や外部のアカウントが要る確認を、モックやシミュレーターの結果で合格にしない。実行できなければ、理由・未確認の範囲・次の担当を書く。
- 調査が終わったことと、製品として成立したことを分ける。
- 検証の結果には、対象版・環境・日時・結果・証跡を含める (${L.VALIDATION} の結果記録)。秘密の値や個人情報は書かない。`;

const SEPARATION_SECTION = `## 指示ファイルと履歴の分離

- 入口と本文書には、繰り返し使う決まりだけを置く。進捗、版、一時的な承認、完了の報告を末尾に書き足さない。
- 現在の状態は ${L.TASKS}、この案件の知識 (技術・構成・コマンド・制約) は ${L.CONTEXT}、検証は ${L.VALIDATION}、個別の判断はレビューの記録に書く。
- 前の案件のコマンド・設定・承認・環境・鍵が、この案件にもあると仮定しない。`;

// 案件の Skill の置き場所 (使う AI の分だけ書く)。作業文書には担当名を書かないので、形式はここ (正本) に置く。
const SKILL_LOCATIONS = Object.freeze({
  Claude: '`.claude/skills/<名前>/SKILL.md` (先頭に `name` と `description`。書き込みや外部への操作を伴うものは `disable-model-invocation: true`)',
  Codex: '`.agents/skills/<名前>/SKILL.md` (先頭に `name` と `description`。書き込みや外部への操作を伴うものは `agents/openai.yaml` の `policy.allow_implicit_invocation: false`)',
});
function skillSection(m) {
  const places = m.agents.map((a) => `- ${a}: ${SKILL_LOCATIONS[a]}`).join('\n');
  const both = m.agents.length > 1 ? '\n- 手順の本体は 1 か所にだけ書き、もう一方はそれを読むよう案内する短い入口にする (同じ手順を二重に持たない)。' : '';
  return `## 案件の Skill

この案件で繰り返す手順は、Skill にしてこのフォルダの中に置く (${L.TASKS} の T-002)。

${places}${both}
- Skill には手順だけを書く。仕様や決まりは \`docs/\` と本文書を参照させ、転載しない。
- Skill の追加と変更は、ユーザーの承認後に行う。権限を広げる指定、ユーザーの個人設定や全体設定への配置はしない。`;
}

const FLOW_SECTION = `## 検討から課題まで

- 思いつきや外部での議論は、まず \`discussions/YYYYMMDD_topic.md\` に生ログとして残す。生ログは正本ではない。あとから足すときは既存の節を書き換えず、日付つきの節を末尾に足す。
- 将来の候補は ${L.BACKLOG} に置く (概要 / 判断の状態 / 今は入れない理由 / 参照元)。没にした案も理由つきで残し、同じ議論を繰り返さない。
- 採用する内容は、仕様の文書へ反映し、版 (\`vMAJOR.MINOR.PATCH\`) と変更の理由を記録してから課題にする。課題へ昇格したら ${L.BACKLOG} から消す (二重に持たない)。
- 調査や実証の課題は、問い・試す範囲・証跡・費用と環境操作の境界・続けるかやめるかの条件を決めてから発行する。`;

const ARCHIVE_SECTION = `## 完了の記録

- 完了した課題の詳細は \`tasks/archive/YYYY-MM.md\` へ移し、\`tasks/INDEX.md\` に ID の所在を書く。完了ログには、完了日・確認の手順・証跡・判断・反映先を残す。完了した本人確認 (UT) も月ごとの記録へ移す。
- 過去の課題は、索引から記録へたどる。過去のレビューや生ログの内容を、そのまま現在の仕様として扱わない。`;

function releaseSection(m) {
  const lines = [
    '- 実装の完了、環境への反映、配布、公開は別々に記録し、それぞれ今回の操作への明示承認を取る。ひと続きの許可と解釈しない。',
    '- 開発用と本番用で、認証・データ・接続先・秘密情報・ログを分ける。本番のデータを開発用にコピーしない。',
    '- 本番への反映は、対象・差分・旧版との互換・検証・止める条件・戻し方をそろえてから承認を得る。',
    '- 有料のサービスや試験は、対象・回数や予算・止める条件を決めてから行う。失敗や再試行も回数に数える。',
  ];
  if (!m.solo) {
    lines.push('- 別の担当へ依頼するのは、次の具体的な作業があるときだけ。依頼文は短くする: 課題の ID、正本のパス、今回だけの注意、検証と記録、してはいけない境界。共通の手順は入口を参照させ、転載しない。');
  }
  return `## 公開・費用・引き継ぎ\n\n${lines.join('\n')}`;
}

export function extendWorkflow(text, cfg) {
  if (!isStandard(cfg)) return text;
  const m = MODES[cfg.mode];
  const i = text.indexOf(NOTATION_HEADING);
  const j = text.indexOf(CHANGE_HEADING);
  if (i < 0 || j < 0 || j < i) throw new Error('WORKFLOW のテンプレートに想定の見出しがありません');
  const sections = [taskSection(m), reviewSection(m), branchSection(m), REPORT_SECTION, SEPARATION_SECTION, skillSection(m)];
  if (isFull(cfg)) sections.push(FLOW_SECTION, ARCHIVE_SECTION, releaseSection(m));
  const head = useTaskIds(text.slice(0, i))
    .split(`製品説明は ${L.PROJECT}、課題は ${L.TASKS}、検証は ${L.VALIDATION}。`)
    .join(`製品説明は ${L.PROJECT}、この案件の知識は ${L.CONTEXT}、仕様と設計は \`docs/\`、課題は ${L.TASKS}、検証は ${L.VALIDATION}。`)
    // 仕様・設計の文書 (docs/) と CONTEXT.md を、文書を管理する担当の編集範囲に含める
    .split(`(${L.PROJECT} / ${L.VALIDATION})、TASKS.md の状態更新。`)
    .join(`(${L.PROJECT} / ${L.VALIDATION} / ${L.CONTEXT} / \`docs/\` 配下の仕様・設計の文書)、TASKS.md の状態更新。`)
    .split(`(${L.PROJECT} / ${L.TASKS} / ${L.VALIDATION}) の更新も`)
    .join(`(${L.PROJECT} / ${L.TASKS} / ${L.VALIDATION} / ${L.CONTEXT} / \`docs/\` 配下の仕様・設計の文書) の更新も`);
  return `${head}${sections.join('\n\n')}\n\n${useTaskIds(text.slice(j))}`;
}

// ---------- 入口 (AGENTS.md / CLAUDE.md) に足す節 ----------
export function extendEntry(text, cfg, agent) {
  if (!isStandard(cfg)) return text;
  const m = MODES[cfg.mode];
  const lines = [];
  if (m.solo) {
    lines.push('- 着手する課題を一覧で `[~]` にし、詳細の 6 項目がそろっていることを確かめてから始める。');
    lines.push('- 提出時に自己レビューの記録を作る。自己確認であり、独立レビューではないと書く。');
  } else if (agent === m.lead) {
    lines.push('- 課題を発行し、順位を決め、詳細の 6 項目を書く。完了条件は第三者が判定できる粒度にする。');
    lines.push(`- 指摘は全文をレビューの記録に保存してから ${m.implementer} に伝える。レビューの合格と、マージ・反映・公開の許可を分けて示す。`);
    lines.push('- 完了にするのはこの担当だけ。必要な本人確認や環境での確認が残る間は `[~]` のままにする。');
  } else {
    lines.push('- 着手時に一覧の `[ ]` を `[~]` にできる。課題の発行、順位の変更、`[x]` 化はしない。');
    lines.push(`- 仕様を独断で変えない。矛盾・未決事項・改善の提案は実装で吸収せず ${m.lead} へ戻す。実行キューにない機能を作らない。`);
    lines.push(`- 提出時に自己レビューの記録を作り、\`[~]\` のまま ${m.lead} へ渡す。指摘の本文を読めないときは、推測で直さない。`);
  }
  lines.push('- 1 課題 1 ブランチで作業し、`main` へ直接コミットしない。合格だけを理由にマージ・反映・公開へ進まない。');
  lines.push(`- 報告は、確認済み・未確認・推測を分けて書く。この案件の技術・構成・コマンドは ${L.CONTEXT} を見る (書いていないことを、前の案件の知識で補わない)。`);
  return `${useTaskIds(text)}\n## 課題・レビュー・git の要点 (詳しくは WORKFLOW.md)\n\n${lines.join('\n')}\n`;
}

// ---------- TASKS.md (standard 以上) ----------
export function renderTasksProfile(cfg, meta, { hasHandover = false } = {}) {
  const undecided = meta.undecided || [];
  const confirm = [];
  if ((meta.needsConfirmation || []).length) confirm.push('- PROJECT.md の「要確認」を解消する');
  confirm.push(
    undecided.includes('permissions.allowedPaths')
      ? '- 編集範囲: (未定) WORKFLOW.md の編集許可パスを決める。まず最初の課題に必要な範囲だけでよい'
      : '- 編集範囲: WORKFLOW.md の編集許可パスのとおりでよいか',
  );
  confirm.push(
    undecided.includes('verifyCommands')
      ? '- 検証手段: (未定) VALIDATION.md の検証コマンドを決める。決まらなければ手動確認の手順でよい。存在しないスクリプトやビルド手順を補わない'
      : '- 検証手段: VALIDATION.md の候補が実在するか確認し、検証レシピに登録する',
  );
  if (undecided.includes('tech')) confirm.push('- 技術: (未定) 技術を決めて PROJECT.md に反映する (未定でも開始は可)');
  confirm.push(`- この案件の知識: ${L.CONTEXT} の各欄を、実在を確かめて埋める (まだ決まっていない欄は「未定」と書く)`);
  confirm.push('- 基本ドキュメント (T-001) で作る文書の範囲と、そのためにユーザーへ聞くこと');
  confirm.push('- MVP の課題 (T-003) の対象 (完了条件は T-001 の文書ができてから確定する)');
  confirm.push('- バージョン管理: このフォルダが git 管理でなければ、`.gitignore` の内容を確かめてから git を初期化し、最初のコミットを作る (実行はユーザーの承認後。push はしない)');
  if (launchConfirmLine(cfg)) confirm.push(`- ${launchConfirmLine(cfg)}`);
  if (hasHandover) confirm.push(`- 導入時の引継ぎ: ${L.START} の「導入時の引継ぎ」の各項目の対応案`);
  const phases = cfg.phases.length
    ? cfg.phases.map((p, i) => `### 段階${i + 1}\n\n段階名 (ユーザー入力の引用):\n\n> ${oneLine(p)}\n\n(この段階の課題は、主導担当が T-xxx として発行する)`).join('\n\n')
    : '### 段階 (未定)\n\n(PROJECT.md の段階が未定。決まったら主導担当が書く)';
  const archive = isFull(cfg)
    ? '完了した課題は、一覧で `[x]` にして証跡を書いたあと、詳細を `tasks/archive/YYYY-MM.md` へ移し、`tasks/INDEX.md` に所在を書く。'
    : '完了した課題は、一覧で `[x]` にして証跡を書く。詳細はこのファイルの「完了済み」へ移す。';
  return `# TASKS.md — 現役の課題

<!-- psw:tasks -->

進め方は ${L.WORKFLOW} の「課題の進め方」。状態は一覧だけに書く: \`[ ]\` 未着手 / \`[~]\` 着手中 / \`[x]\` 完了。\`[x]\` にする行には課題 ID と \`証跡:\` と所在を必ず書く。検証の結果は ${L.VALIDATION} に同じ ID で記録する。

## 実行キュー (この順で進める)

1. T-000 初期確認
2. T-001 基本ドキュメントを作る
3. T-002 必要な Skill を作る
4. T-003 MVP の最小の 1 経路を動かす

## 一覧

- [ ] T-000 初期確認
- [ ] T-001 基本ドキュメントを作る
- [ ] T-002 必要な Skill を作る
- [ ] T-003 MVP の最小の 1 経路を動かす

## ユーザーの作業 (U-xxx)

ユーザー本人にしかできない作業 (アカウントの取得、契約、実機の用意、外部サービスの設定など)。AI は準備と依頼までを行う。本人による確認の手順は ${L.USER_TESTS} に UT-xxx として書く。

(なし)

書き方: \`- [ ] U-001 題名 — 関連: T-xxx / AI が準備するもの / 本人がすること / 完了の目安\`

## 詳細

### T-000: 初期確認

**目的**: 作業を始める前に、未定のことと最初の課題を、1 回の確認でそろえる。

**対象**: 次の項目を 1 つの要約にまとめてユーザーに確認する。承認済みの範囲では、同じ確認を繰り返さない。

${confirm.join('\n')}

**完了条件**: ユーザーが要約を承認し、その内容が下の承認記録に書かれている。

**承認記録**: (未記入)

### T-001: 基本ドキュメントを作る

**目的**: 実装を始める前に、仕様と設計の正本を \`docs/\` に用意する。

**対象**: \`docs/\` 配下の基本の文書。この案件に要るものだけを作り、中身のないひな型は並べない。目安:

- \`docs/PROJECT_OVERVIEW.md\` — コンセプト、対象のユーザー、変えない要件
- \`docs/MVP_SPEC.md\` — MVP の範囲、画面や操作、受け入れ条件、対象外
- \`docs/ARCHITECTURE.md\` — 構成、採用する技術と理由、データの持ち方
- \`docs/DECISIONS.md\` — 採用した判断と、まだ決まっていないこと
- 必要に応じて: データモデル、API、環境の準備、試験の計画、プライバシーとセキュリティ

**参照ドキュメント**: ${L.PROJECT} / ${L.CONTEXT}

**実装方針**: ${L.PROJECT} を読み、文書を書くのに足りない情報を質問にまとめて、ユーザーに 1 回で聞く。推測で埋めない。答えをもとに文書を書き、決まっていないことは「未確定」と書いて \`docs/DECISIONS.md\` に集める。作った文書の一覧と、どれが何の正本かを ${L.CONTEXT} の「仕様・設計の文書」に書く。

**完了条件**: 必要と合意した文書が \`docs/\` にあり、ユーザーが内容を確認した。${L.CONTEXT} に文書の一覧がある。未確定のことが \`docs/DECISIONS.md\` に並んでいる。

**確認事項**: どの文書を作るか。ユーザーに聞く質問の一覧。

**検証**: ユーザーによる内容の確認 (結果を VALIDATION.md に記録する)

### T-002: 必要な Skill を作る

**目的**: T-001 の文書をもとに、この案件で繰り返す手順を Skill にして、毎回の説明と手戻りを減らす。

**対象**: この案件のフォルダの中の Skill。置き場所と形式は ${L.WORKFLOW} の「案件の Skill」。

**参照ドキュメント**: T-001 で作った \`docs/\` の文書 / ${L.CONTEXT}

**実装方針**: 文書から、繰り返す手順の候補を挙げる (例: 始業時の現状把握、仕様を変えたときの記録、レビューの提出、リリース前の確認)。候補ごとに、何をするか・いつ使うか・根拠の文書を示し、作るものをユーザーに選んでもらう。Skill には手順だけを書き、仕様は文書を参照させる (転載しない)。書き込みや外部への操作を伴う Skill は、明示して呼んだときだけ動くようにする。権限を広げる指定はしない。

**完了条件**: 選ばれた Skill があり、それぞれを一度呼び出して手順どおりに動くことを確かめた。${L.CONTEXT} に Skill の一覧がある。作らないと決めた場合は、その理由を記録して完了にする。

**確認事項**: 作る Skill の候補と、ユーザーの選択。Skill の作成はユーザーの承認後に行う。

**検証**: 各 Skill を一度呼び出した結果 (VALIDATION.md に記録する)

### T-003: MVP の最小の 1 経路を動かす

**目的**: ${L.PROJECT} の MVP (ユーザー入力の引用) のうち、最小の 1 経路を実際に動かす。

**対象**: (初期確認で確定する)

**参照ドキュメント**: ${L.PROJECT} / ${L.CONTEXT} / T-001 で作った \`docs/\` の文書

**実装方針**: (着手前に書く)

**完了条件**: (T-001 の文書ができてから確定する。第三者が判定できる、観察できる結果で書く)

**確認事項**: (未決のことがあれば書く。残っている間は着手しない)

**検証**: (VALIDATION.md の検証レシピの番号、または手動確認の手順)

## 段階

${phases}

## 再開メモ

作業を区切るたびに上書きする。秘密・認証情報は書かない。

- 対象版: (commit。なければ変更したファイルと日時)
- 直近の変更:
- 証拠: (VALIDATION.md の該当行、レビューの記録)
- 留保・未検証:
- 次の作業と開始条件:

## 完了済み

${archive}

(なし)
`;
}

// ---------- TASKS.md (minimal): 最初の課題に、基本ドキュメントと Skill を足す ----------
// render.mjs の最小のテンプレート (初期確認 + MVP の課題) へ、MVP の前に 2 つの課題を差し込む。
// 文書と Skill を作るのは案件側の AI で、このツールは課題として置くだけ。
const MINIMAL_MVP_LINE = '- [ ] #t1 MVP の最小の1経路を動かす';
const MINIMAL_CONFIRM_LINE = '  - 最初の課題 (#t1) の合格条件';
export function extendMinimalTasks(text) {
  if (!text.includes(MINIMAL_MVP_LINE) || !text.includes(MINIMAL_CONFIRM_LINE)) throw new Error('TASKS の最小のテンプレートに想定の行がありません');
  const added = [
    '- [ ] T-001 基本ドキュメントを作る (`docs/` に仕様と設計の文書を作る。足りない情報はユーザーに 1 回でまとめて聞き、推測で埋めない)',
    '  - 合格条件: 必要と合意した文書が `docs/` にあり、ユーザーが内容を確認した。決まっていないことは「未確定」と書いてある',
    '  - 検証: ユーザーによる内容の確認',
    '  - 残作業・留保: (なし)',
    '- [ ] T-002 必要な Skill を作る (T-001 の文書をもとに、繰り返す手順をこの案件の Skill にする。作るものはユーザーが選び、作成は承認後。権限を広げる指定はしない)',
    '  - 合格条件: 選ばれた Skill があり、それぞれを一度呼び出して動くことを確かめた。作らないと決めた場合は、その理由を記録した',
    '  - 検証: 各 Skill を一度呼び出した結果',
    '  - 残作業・留保: (なし)',
  ].join('\n');
  return text
    .split(MINIMAL_CONFIRM_LINE).join('  - 基本ドキュメント (T-001) で作る文書の範囲と、MVP の課題 (T-003) の合格条件')
    .split(MINIMAL_MVP_LINE).join(`${added}\n- [ ] T-003 MVP の最小の1経路を動かす`);
}

// ---------- CONTEXT.md (この案件の知識。ウィザードは中身を書かない) ----------
export function renderContext(cfg) {
  const blank = '(未記入)';
  const ui = hasUiRules(cfg) ? `\n${UI_CONTEXT_HEADING}\n\n${blank}\n` : '';
  return `# ${CONTEXT_FILE_NAME} — この案件の知識

<!-- psw:context -->

この案件にしかない知識を書く場所です。最初のセッションの初期確認 (T-000) で、担当が実在を確かめてから埋めます。
確かめていないことは書かず、推測には「未確認」と付けます。秘密の値は書きません。内容が変わったら該当箇所を直接直します (末尾に書き足さない)。
ほかの案件の技術・コマンド・設定を、確かめずに持ち込みません。

## 技術スタック (採用している技術と版、選んだ理由)

${blank}

## フォルダ構成

${blank}

## 開発コマンド (実在を確かめたものだけ。検証に使うものは VALIDATION.md の検証レシピにも登録する)

${blank}

## 設計上の制約・壊してはいけないもの

${blank}

## コードと文言の規約

${blank}

## 仕様・設計の文書 (何がどこにあり、どれが正本か)

${blank}
${ui}`;
}

// ---------- USER_TESTS.md ----------
export function renderUserTests() {
  return `# ${USER_TESTS_FILE_NAME} — 本人による確認の手順

<!-- psw:user-tests -->

実機・ブラウザ・アカウントなど、ユーザー本人にしかできない確認を書きます。番号は \`UT-001\` からの通番で、改番も再利用もしません。関連する課題 (T-xxx) と相互に書きます。
結果はユーザーの報告だけで埋めます (自動テストやモックの結果で代用しない)。秘密の値や個人情報は書きません。必須の確認が残っている課題は、完了にしません。

状態: 未実施 / 確認中 / 完了。あわせて、確認可能 / 実装待ち / 環境待ち を書きます (まだ試せないものを、今すぐ試せる手順として渡さない)。

## 一覧

(なし)

## 書き方

\`\`\`
### UT-001: 題名 (目的の単位で短く)

- 関連: T-xxx
- 状態: 未実施 (確認可能 / 実装待ち / 環境待ち)
- 前提:
- 手順:
- 期待する結果:
- 結果 (ユーザーが記入):
\`\`\`
`;
}

// ---------- BACKLOG.md (full) ----------
export function renderBacklog() {
  return `# ${BACKLOG_FILE_NAME} — 将来の候補と見送り

<!-- psw:backlog -->

${L.TASKS} に入れる前の候補を置きます。実装できる粒度に固まり、未決事項がなくなったものだけを課題へ昇格し、昇格したらここから消します。没にした案も、理由と一緒に残します。

## 候補

(なし)

書き方: \`- 題名 — 概要 / 判断の状態 (候補・保留・却下・昇格) / 今は入れない理由 / 参照元\`

## 見送り・却下

(なし)
`;
}

// 入口のファイル名 (担当ごと)
export function entryFileOf(agent) {
  return ENTRY_FILE[agent];
}
