# pi-harness-playground

Markdown チケットまたは Linear 課題を入力し、Pi のセッションで要件確認、プラン、worktree での実装、検品まで進めるハーネスです。実行順序は `src/harness/workflow.ts` にあります。

```bash
npm test
npm run harness -- --ticket fixtures/sample-ticket.md --repo /path/to/git/app
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear ABC-123 --repo /path/to/git/app
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear https://linear.app/acme/issue/ABC-123/example --repo /path/to/git/app
```

Linear 認証には環境変数 `LINEAR_API_KEY` を使います。キーはリポジトリや fixture に保存しません。取得失敗、認証・権限エラー、課題不存在、本文が空の場合は理由を表示してワークフローを開始しません。秘密情報や API 応答の内容はエラー出力に含めません。

Linear から取り込むのは指定した課題 1 件のタイトルと本文のみです。課題から実装手順を補完したり、マージ後に Linear へ起票したりする機能は対象外です。Markdown ファイルを直接渡す入口も引き続き利用できます。
