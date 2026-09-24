# pi-harness-playground

Markdown チケットまたは Linear 課題を入力し、Pi のセッションで要件確認、プラン、worktree での実装、検品まで進めるハーネスです。実行順序は `src/harness/workflow.ts` にあります。

```bash
npm test
npm run test:e2e
npm run harness -- --ticket fixtures/sample-ticket.md --repo /path/to/git/app
npm run harness -- --ticket fixtures/sample-ticket.md --repo /path/to/git/app --base abc1234
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear ABC-123 --repo /path/to/git/app
LINEAR_API_KEY='your-linear-api-key' npm run harness -- --linear https://linear.app/acme/issue/ABC-123/example --repo /path/to/git/app
npm run harness -- --resume .harness/runs/<runId> --repo /path/to/git/app --extra-rounds 2
npm run harness -- --resume .harness/runs/<runId> --repo /path/to/git/app --hint "テストを先に直す"
npm run harness -- --resume .harness/runs/<runId> --repo /path/to/git/app --replan-remaining
npm run harness -- --resume .harness/runs/<runId> --repo /path/to/git/app --answer "400 を返す"
npm run harness -- --resume .harness/runs/<runId> --repo /path/to/git/app --continue-from-ingest
```

## 作業の起点

起点を省略すると、実行開始前に `origin/main` を取得し、その先端を固定起点として作業します（チェックアウト中のブランチやローカル `main` ではありません）。Markdown (`--ticket`) と Linear (`--linear`) のどちらでも `--base <revision>` を指定でき、SHA またはタグの例は `--base abc1234`、`--base v1.2.3` です。既定の PR ベースは `main` です。指定時はそのリビジョンを起点とし、PR のベースにはその起点を指す専用ブランチを使います。値が空の場合や取得・リビジョン解決に失敗した場合は理由を表示して停止し、ワークフローを開始しません。

## 停止結果と再開

修正ループや取り込みで止まった実行の結果には、種類、最後の指摘またはチェック出力、周ごとの傾向、残っている統合ブランチと作業ツリー、推奨する次の一手が 1 つ含まれます。衝突で止めたときは残っている衝突パスも入ります。種類は次のとおりです。

| 種類 | いつ止まるか | 再開 |
|---|---|---|
| 要求を満たし懸念だけ | 人に戻さず、懸念を持ったまま PR 以降へ進む | 再開しない |
| `decreasing-fatal` | 致命的な残件が減ったまま上限 | `--extra-rounds <回数>` だけ。同じ統合ブランチの残件をその回数続ける。元の `review.maxLoops` は変えない |
| `stalled` | 同じ指摘または同じチェック失敗が続いたとき（残り周は使わない） | `--hint` または `--replan-remaining`。回数追加は不可 |
| `changing` | チェック失敗の中身が周ごとに変わり続けたまま上限（要求を満たしていれば懸念を持って進む） | `--extra-rounds` / `--hint` / `--replan-remaining` のいずれか |
| `insufficient-requirements` | 途中で要求が足りない | `--answer`（複数可）。回答は仮定として同じブランチの残件に足る |
| `conflict` / `branch-deviation` / `environment-check` | 衝突、作業ツリーのブランチ逸脱、作業ツリーでは直せないチェック失敗。通常の傾向分類より優先する | `--continue-from-ingest`。人が解消した同じブランチの取り込み位置以降から続ける。未解消なら再停止する |

`--resume` には停止した実行の run ディレクトリ、またはその中の `loop-state.json` を渡します。再開の一手は 1 つだけです。不許可の方法や矛盾した入力は作業開始前に拒否します。別プロセスから再開しても、同じ統合ブランチ・作業ツリー・差分・仮定を引き継ぎ、新しい統合ブランチは切りません。並列 wave の未取り込み成果は残し、完了済み実装はやり直しません。通常の新規実行はこれまでどおり HEAD から新しい統合ブランチを切ります。

Linear (`--linear`) 実行では、停止中も In Progress のままです。再開時は開始状態を書き直さず、`ready` または `production-ok` のときだけ Done にします。返却・エスカレーション・失敗時は Done にせず、状態を巻き戻しません。

## E2E テスト

`npm run test:e2e` は単体テストと独立して実行します。テスト自身が Markdown チケット、`fixtures/resume/` の固定応答 JSON、専用の外部フェーズ無効設定、および一時 git リポジトリを使い、`npm run harness` と同じ入口を子プロセスで起動します。API キー不要でモデル API・Linear・GitHub へ接続せず、明確なチケットの実装取り込みと `ready`、曖昧なチケットの質問と `returned`、全停止種類と再開、未実装を検証します。固定応答による受け入れテストであり、プロバイダへの実際のパラメータ送信は検証しません。一時データは終了時に削除され、子プロセスには120秒の上限があります。`npm test` には含まれません。

## モデル設定

`models.smart` と `models.cheap` には別名ではなく `{ "provider": "...", "id": "...", "parameters": { ... } }` を指定します。バージョンはモデル ID で選びます。たとえば `grok-4.7` を xhigh で fast を無効にする指定は次の通りです。

```json
{ "provider": "xai", "id": "grok-4.7", "parameters": { "effort": "xhigh", "fast": false } }
```

`parameters` には `effort`（例: `low` / `medium` / `high` / `xhigh`）、`fast`、`contextWindow` と、モデル実行に必要な追加パラメータを指定できます。項目を省略すると、そのモデルのカタログ既定値が使われます。未知のモデル ID、非対応の effort / fast、範囲外のコンテキストウィンドウは実行前に理由を示して停止します。

| 既存別名 | provider | id | effort |
|---|---|---|---|
| astra | openai-codex | gpt-6-astra | high |
| luna | openai-codex | gpt-6-luna | medium |
| grok | cursor | grok-4.6 | medium |
| fable | anthropic | claude-fable-5-1 | high |

Cursor の Grok は `pi-cursor-sdk` 経由です。`CURSOR_API_KEY` または Pi の `.pi-clean` に保存した Cursor API キーを使い、キーをリポジトリに置かないでください。Cursor デスクトップやエージェント CLI へのログイン、xAI API キーは不要です。利用可能な ID は Cursor が返す一覧に限られ、一覧外の ID はプロンプト送信前に失敗します。

## セッションログ

各段階・試行の `.harness/runs/<runId>/observability/<段階>/` には、そのセッションで新規作成された jsonl のみを保存します。開始行にはモデル名、ツール行には既存の計測値に加えて操作対象（読み書きのパス、コマンド、検索パターン）を最大500文字、失敗した場合のみ出力の先頭を最大500文字記録します。終了行には最後のアシスタントテキスト（要件確認・プラン・検品のJSONを含む）を文字数で切り詰めずに記録します。保存するテキストは認証情報をマスクします。

プロンプト全文、成功したツールの入出力本文、失敗出力の全文は保存しません。認証情報は保存対象全体から除去・マスクします。

Linear 認証には環境変数 `LINEAR_API_KEY` を使います。キーはリポジトリや fixture に保存しません。取得失敗、認証・権限エラー、課題不存在、本文が空の場合は理由を表示してワークフローを開始しません。秘密情報や API 応答の内容はエラー出力に含めません。

Linear から取り込むのは指定した課題 1 件のタイトルと本文のみです。`--linear` 実行では開始前に In Progress、ワークフローが `ready` または `production-ok` で終わった後に Done へ更新します。状態更新に失敗した場合は理由を表示して非ゼロ終了し、開始更新に失敗した場合はワークフローを開始しません。返却・エスカレーション・失敗時は Done にせず、状態を巻き戻しません。Markdown (`--ticket`) 実行では Linear の状態を更新しません。課題から実装手順を補完したり、マージ後に Linear へ起票したりする機能は対象外です。
