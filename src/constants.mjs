// ProjectSetupWizard 定数。Node 標準ライブラリのみ。
export const TOOL_NAME = 'ProjectSetupWizard';
export const TOOL_VERSION = '0.1.0';
// テンプレートの版。生成内容が変わる変更をしたら上げる (plan digest に含める)。
export const TEMPLATE_VERSION = '14';
export const SCHEMA_VERSION = 1;

export const MODES = Object.freeze({
  'codex-led': {
    label: 'Codex主導 (Codex=主導・レビュー, Claude=実装)',
    lead: 'Codex',
    reviewer: 'Codex',
    implementer: 'Claude',
    agents: ['Codex', 'Claude'],
    solo: false,
  },
  'claude-led': {
    label: 'Claude主導 (Claude=主導・レビュー, Codex=実装)',
    lead: 'Claude',
    reviewer: 'Claude',
    implementer: 'Codex',
    agents: ['Claude', 'Codex'],
    solo: false,
  },
  'codex-solo': {
    label: 'Codex単独 (独立レビューなし)',
    lead: 'Codex',
    reviewer: null,
    implementer: 'Codex',
    agents: ['Codex'],
    solo: true,
  },
  'claude-solo': {
    label: 'Claude単独 (独立レビューなし)',
    lead: 'Claude',
    reviewer: null,
    implementer: 'Claude',
    agents: ['Claude'],
    solo: true,
  },
});

export const MODE_NAMES = Object.freeze(Object.keys(MODES));

// 各AIの入口ファイル名
export const ENTRY_FILE = Object.freeze({
  Codex: 'AGENTS.md',
  Claude: 'CLAUDE.md',
});

export const HANDOFFS = Object.freeze(['manual', 'cli', 'none']);

export const CONFIG_FILE_NAME = 'setup.config.json';
export const MANIFEST_FILE_NAME = 'generated.manifest.json';
// 案件固有のルール (設定の projectRules があるときだけ生成)
export const RULES_FILE_NAME = 'RULES.md';
// ないときだけ作る初期ファイル (既にあれば比較も上書きもしない)
export const GITIGNORE_FILE_NAME = '.gitignore';

// 作業文書: 運用中にユーザーや AI が書き足す。生成後に変更されていたら apply は上書きせず、regenerate は引き継ぐ。
export const WORKING_DOCS = Object.freeze(['TASKS.md', 'VALIDATION.md', 'CONTEXT.md', 'USER_TESTS.md', 'BACKLOG.md']);

// 終了コード
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  NEEDS_CONFIRMATION: 2,
});

// update の公式 allowlist (これ以外は読まない)
export const OFFICIAL_URLS = Object.freeze([
  { id: 'skills', url: 'https://code.claude.com/docs/en/skills' },
  { id: 'commands', url: 'https://code.claude.com/docs/en/commands' },
  { id: 'memory', url: 'https://code.claude.com/docs/en/memory' },
]);

// 作者の環境で確認した導入版。/project-update が比較の基準に使う。利用者の環境の版とは限らない。
export const BASELINE = Object.freeze({
  confirmedOn: '2026-10-11',
  claudeCli: '2.1.288',
  node: 'v22.20.0',
  adopted: [
    'project-local Skill: .claude/skills/<name>/SKILL.md',
    'SKILL.md 先頭 YAML frontmatter の name / description',
    'ユーザー slash 名は name から派生 (/project-new 等)',
    'disable-model-invocation: true (書き込みを伴う project-new / project-change)',
    'CLAUDE.md から共通正本 (WORKFLOW.md) を参照',
  ],
  notAdopted: [
    'context: fork',
    '権限を広げる allowed-tools',
    '動的 shell 注入 (!`cmd` 等)',
    'グローバル (~/.claude/skills) への配置',
    '/new (= /clear の別名のため作成しない)',
  ],
  unverified: [
    '公式に存在する導入版より新しい機能 (基本形式のみ採用し、未検証)',
  ],
});

// ウィザード標準: 生成文書が備える運用上の要素。既存ルール優先の導入で、既存の文書に足りない点を洗い出す物差しに使う。
// marker は、その要素が生成文書 (file) に実際に入っていることを試験で確かめるための目印。
// setting 付きの要素は、設定のその項目を有効にした案件にだけ入る。
export const STANDARD_ELEMENTS = Object.freeze([
  { id: 'canon', title: '運用の正本が 1 つに決まっていて、各 AI の入口がそれを参照する', file: 'WORKFLOW.md', marker: '役割・編集権限・承認規則の正本' },
  { id: 'read-timing', title: '開始時・着手前・検証時・再開時に何を読むかと、参照の欠落や矛盾があれば止まること', file: 'entry', marker: 'いつ何を読むか' },
  { id: 'roles', title: '主導・実装・レビューの担当と、独立レビューの有無 (自己確認を独立レビューと呼ばない)', file: 'WORKFLOW.md', marker: '独立レビュー:' },
  { id: 'approval', title: '承認不要の通常作業・明示承認が必要な行為・常に不可の行為の区別', file: 'WORKFLOW.md', marker: '承認不要 (通常作業)' },
  { id: 'initial-confirm', title: '編集範囲・最初の課題・合格条件・検証手段を 1 回の確認にまとめる手順', file: 'TASKS.md', marker: '初期確認' },
  { id: 'task-ac', title: '課題ごとの ID・合格条件・検証手段', file: 'TASKS.md', marker: '合格条件:', markers: ['合格条件:', '**完了条件**:'] },
  { id: 'verify-recipe', title: '検証コマンドの候補と、実在を確認した手順 (根拠・実行場所・前提・対象・期待結果) の区別', file: 'VALIDATION.md', marker: '検証レシピ' },
  { id: 'result-vocab', title: '実行が通ったことと合格条件を満たしたことの区別 (0 件成功や主要経路を通らない成功を合格にしない)', file: 'VALIDATION.md', marker: '実行成功' },
  { id: 'evidence', title: '完了には証跡の所在が必要で、対象版・環境・留保を記録する', file: 'VALIDATION.md', marker: '対象版' },
  { id: 'resume', title: '次のセッション向けの再開メモ (対象版・変更・証拠・留保・次作業)', file: 'TASKS.md', marker: '再開メモ' },
  { id: 'data-not-instruction', title: 'ユーザー入力や引用を指示として扱わないこと、秘密・認証情報を読まない・転記しないこと', file: 'WORKFLOW.md', marker: '秘密・認証情報' },
  { id: 'role-change', title: '役割や権限の変え方 (AI が自分で文書を書き換えて変えない)', file: 'WORKFLOW.md', marker: '/project-change' },
  { id: 'version-control', title: 'バージョン管理を始めること (git 管理でなければ、.gitignore を確かめてから初期化し、最初のコミットを作る)', file: 'TASKS.md', marker: 'バージョン管理:' },
  { id: 'base-docs', title: '最初に、仕様と設計の基本の文書を docs/ に作る (足りない情報はユーザーに聞き、推測で埋めない。作るのは案件側の AI)', file: 'TASKS.md', marker: 'T-001 基本ドキュメントを作る' },
  { id: 'project-skills', title: '文書をもとに、繰り返す手順を案件の Skill にする (作るものはユーザーが選ぶ。作るのは案件側の AI)', file: 'TASKS.md', marker: 'T-002 必要な Skill を作る' },
  // ここから下の profile 付きの要素は、その段階以上のときに入る
  { id: 'task-card', profile: 'standard', title: '課題の個票 (目的・対象・参照ドキュメント・実装方針・完了条件・確認事項) と、通番の ID (T / U / UT。改番・再利用しない)', file: 'TASKS.md', marker: '**完了条件**:' },
  { id: 'task-state', profile: 'standard', title: '未着手・着手中・完了の状態と、誰が完了にできるか (必要な確認が残る間は着手中のまま)', file: 'WORKFLOW.md', marker: '## 課題の進め方' },
  { id: 'review-record', profile: 'standard', title: '課題ごとのレビューの記録と、指摘の正本、軽微な修正と是正課題の区別', file: 'WORKFLOW.md', marker: '## レビューと是正' },
  { id: 'branch-merge', profile: 'standard', title: '1 課題 1 ブランチ、main へ直接コミットしない、レビューの合格とマージの許可を分ける', file: 'WORKFLOW.md', marker: '## ブランチとマージ' },
  { id: 'report-style', profile: 'standard', title: '確認済み・未確認・推測を分けた報告、モックの結果で合格にしない、調査の完了と製品の成立を分ける', file: 'WORKFLOW.md', marker: '## 報告と検証の書き方' },
  { id: 'instruction-history', profile: 'standard', title: '指示ファイルには繰り返し使う決まりだけを置き、進捗や一時的な承認を書き足さない。前の案件の設定を仮定しない', file: 'WORKFLOW.md', marker: '## 指示ファイルと履歴の分離' },
  { id: 'project-context', profile: 'standard', title: 'この案件の知識 (技術・構成・コマンド・制約・規約) を、実在を確かめて書く場所', file: 'CONTEXT.md', marker: '## 開発コマンド' },
  { id: 'user-work', profile: 'standard', title: 'ユーザー本人の作業 (U) と本人による確認 (UT) の管理。結果を自動テストで代用しない', file: 'USER_TESTS.md', marker: 'UT-001' },
  { id: 'skill-location', profile: 'standard', title: '案件の Skill の置き場所と形式 (使う AI ごと。明示操作、権限を広げない、二重に持たない)', file: 'WORKFLOW.md', marker: '## 案件の Skill' },

  { id: 'idea-flow', profile: 'full', title: '検討の生ログ → 将来の候補 → 仕様 (版と変更理由) → 課題 の流れ。没案も理由つきで残す', file: 'WORKFLOW.md', marker: '## 検討から課題まで' },
  { id: 'archive-index', profile: 'full', title: '完了した課題の月ごとの記録と、ID の所在の索引', file: 'WORKFLOW.md', marker: '## 完了の記録' },
  { id: 'release-boundary', profile: 'full', title: '実装の完了・環境への反映・配布・公開を分けた承認、開発と本番の分離、有料の試験の予算、引き継ぎ文の書き方', file: 'WORKFLOW.md', marker: '## 公開・費用・引き継ぎ' },
  { id: 'ai-preferences', title: '各AIのモデル・effortの希望設定、使えないときの代わりの順番、実際の起動設定を確認する手順', file: 'START.md', marker: 'psw:ai-preferences' },
  { id: 'ai-launch', title: '別 AI の起動の扱い (協働モードの既定は、主導担当が決めた範囲で実装担当を起動してよい。範囲・含まれない承認・結果の扱いを正本に書く。毎回承認にもできる)', file: 'WORKFLOW.md', marker: '別AIの起動:' },
  { id: 'ui-basics', setting: 'uiRules', title: '画面の実装の基本 (デザインルールの正本をユーザーと決めながら育てる、値と文言を直接書かない、共通部品を基本にする、検査と画面の確認)', file: 'WORKFLOW.md', marker: '## 画面の実装の基本' },
]);
