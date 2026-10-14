# 診断を定期的に回す場合の手順の例

このツールは、スケジュールへの登録や常駐を自分では行いません。ここにあるのは手順の例だけです。
定期的に回すのは **CLI の無人診断** (`audit` / `update` の `--unattended`) だけにしてください。AI の実行をスケジュールで起動する設定は含みません。`/project-new` と `/project-change` は無人では動きません。

## 1. 無人診断の内容

```
node scripts/cli.mjs audit  --target <案件フォルダ> --unattended --report <新規ファイル>
node scripts/cli.mjs update --unattended --report <新規ファイル>
```

- 既存のファイルには書かないので、レポートの名前に日付を入れます (例: `reports/audit-2026-10-11.md`)。レポート用のフォルダは自分で用意します。
- 終了コード `2` は要確認あり、`1` はエラーです。
- `update --online` は公式の 3 ページだけを読みます。定期実行では付けない (既定はオフライン) か、自分で決めてください。

## 2. Windows のタスク スケジューラに登録する例 (自分で行う)

PowerShell (管理者権限は不要):

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument '"C:\path\to\ProjectSetupWizard\scripts\cli.mjs" audit --target "C:\path\to\project" --unattended --report "C:\path\to\reports\audit.md"' `
  -WorkingDirectory "C:\path\to\ProjectSetupWizard"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9:00
Register-ScheduledTask -TaskName "ProjectSetupWizard audit" -Action $action -Trigger $trigger
```

- レポートは既存のファイルに書けないので、実際には、日付入りのファイル名を作る小さなスクリプトを `-Execute` にするほうが確実です。
- `node.exe` のフルパスは自分の環境で確かめてください。

macOS / Linux では cron などで同じコマンドを呼べますが、このツールはそれらの環境では確かめていません。
