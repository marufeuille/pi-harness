# pi-harness-playground

Markdown チケットまたは Linear 課題を入力し、Pi のセッションで要件確認、プラン、worktree での実装、検品まで進めるハーネスです。実行順序は `src/harness/workflow.ts` にあります。

```bash
npm test
npm run test:e2e
npm run harness -- --ticket fixtures/sample-ticket.md --repo /path/to/git/app
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear ABC-123 --repo /path/to/git/app
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear https://linear.app/acme/issue/ABC-123/example --repo /path/to/git/app
```

## E2E テスト

`npm run test:e2e` は単体テストと独立して実行します。テスト自身が Markdown チケット、固定応答 JSON、専用の外部フェーズ無効設定、および一時 git リポジトリを作り、`npm run harness` と同じ入口を子プロセスで起動します。API キー不要でモデル API・Linear・GitHub へ接続せず、明確なチケットの実装取り込みと `ready`、曖昧なチケットの質問と `returned`、未実装を検証します。一時データは終了時に削除され、子プロセスには120秒の上限があります。`npm test` には含まれません。

## セッションログ

各段階・試行の `.harness/runs/<runId>/observability/<段階>/` には、そのセッションで新規作成された jsonl のみを保存します。開始行にはモデル名、ツール行には既存の計測値に加えて操作対象（読み書きのパス、コマンド、検索パターン）を最大500文字、失敗した場合のみ出力の先頭を最大500文字記録します。終了行には最後のアシスタントテキスト（要件確認・プラン・検品のJSONを含む）を文字数で切り詰めずに記録します。保存するテキストは認証情報をマスクします。

プロンプト全文、成功したツールの入出力本文、失敗出力の全文は保存しません。認証情報は保存対象全体から除去・マスクします。

Linear 認証には環境変数 `LINEAR_API_KEY` を使います。キーはリポジトリや fixture に保存しません。取得失敗、認証・権限エラー、課題不存在、本文が空の場合は理由を表示してワークフローを開始しません。秘密情報や API 応答の内容はエラー出力に含めません。

Linear から取り込むのは指定した課題 1 件のタイトルと本文のみです。`--linear` 実行では開始前に In Progress、ワークフローが `ready` または `production-ok` で終わった後に Done へ更新します。状態更新に失敗した場合は理由を表示して非ゼロ終了し、開始更新に失敗した場合はワークフローを開始しません。返却・エスカレーション・失敗時は Done にせず、状態を巻き戻しません。Markdown (`--ticket`) 実行では Linear の状態を更新しません。課題から実装手順を補完したり、マージ後に Linear へ起票したりする機能は対象外です。
