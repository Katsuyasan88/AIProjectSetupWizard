# 前提にしている Claude Code と Codex の Skill の形式

## 公式ドキュメント (`update --online` が読むのはこの 3 ページだけ)

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/commands
- https://code.claude.com/docs/en/memory

## 確認した環境

| 項目 | 値 |
| --- | --- |
| 確認日 | 2026-10-11 |
| Claude Code CLI | 2.1.288 |
| Node | v22.20.0 |
| OS | Windows 11 |

作者の環境で確認した版です。`/project-update` はこれを比較の基準に使います。利用者の環境がこの版と違う場合、対応しているかは別に確かめてください (最新のページを読めたことは、導入している版が対応していることを意味しません)。

## 使っている形式

- プロジェクト内の Skill: `.claude/skills/<name>/SKILL.md`
- `SKILL.md` 先頭の YAML の `name` / `description`
- スラッシュコマンドの名前は `name` から決まる (`/project-new` など)
- `disable-model-invocation: true` (書き込みを伴う `project-new` / `project-change`)
- 生成文書では、入口 (`CLAUDE.md` / `AGENTS.md`) から正本 (`WORKFLOW.md`) を通常の Markdown リンクで参照する

## 使っていないもの

- `context: fork`
- 権限を広げる `allowed-tools`
- 動的な shell 注入
- グローバル (`~/.claude/skills`) への配置
- `/new` という名前 (`/clear` の別名のため)
- 入口からの `@` による取り込み (起動時に全文が読み込まれるため。必要なときに読む指示にしている)

## Codex

公式ドキュメント: https://developers.openai.com/codex/skills (2026-10-12 に確認)

使っている形式:

- リポジトリ内の Skill: `.agents/skills/<name>/SKILL.md` (先頭の YAML に `name` / `description`)
- 明示的な呼び出しは `$<name>`、または `/skills` から選ぶ
- 自動で使わせない指定: `.agents/skills/<name>/agents/openai.yaml` の `policy.allow_implicit_invocation: false` (書き込みを伴う `project-new` / `project-change`)
- リポジトリの決まりは `AGENTS.md` (Claude Code は `CLAUDE.md` からこのファイルを読み込む)

`.agents/skills/` の中身は、手順の本体 (`.claude/skills/`) を読むよう案内する短い入口で、`node scripts/sync-agent-skills.mjs` が作ります。

確かめていないこと:

- Codex 上での Skill の発見、`$<name>` での起動、対話の進み方。
- `update --online` は Claude Code のドキュメントだけを読みます。Codex 側の形式の変更は自動では比べません。

## 確認の記録

### 2026-10-14

- `node scripts/cli.mjs update` (オフライン) を実行。公式 3 URL と導入版は未確認。採用・未採用の形式に変更なし。
- 案件からの学び: ユーザーが指定した 2 案件の管理文書を読取のみで確認し、次を採用した (テンプレート版14)。
  - 採用: 別 AI の起動の設定 (`launchPolicy`) と「実装担当の起動」の節。AI に任せる範囲を広げる設定だが、ユーザーの判断で協働モードの既定にした (毎回承認も選べる。単独モードは常に毎回承認)。
  - 採用: モデルの代わりの順番 (`fallbackModels`)。
  - 採用: 画面の実装の基本 (`uiRules`)。デザインルールの正本は、最初から用意せず、ユーザーと決めながら育てる形にした。
  - 不採用 (案件固有): 具体的なモデル名、プラグインやコマンドの名前、時間の目安、予算、個別のファイルの読取承認、ファイルや関数の名前、具体的な寸法、文言の調子。
  - 未検証: 生成した決まりで AI が別の AI を起動して動くか、代わりのモデルへの切り替え、直接書いた値の検査。どれも文書の生成だけを確かめた。

## 更新の手順

`node scripts/cli.mjs update [--online]` の提案を見て、判断したうえでこの文書を直します。
