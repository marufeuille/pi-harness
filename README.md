# pi-harness-playground

Markdown のチケットを渡し、Pi のセッションで要件確認、プラン、worktree での実装、検品まで進めるハーネスです。

実行順序は `src/harness/workflow.ts` にあります。

```bash
npm test
npm run harness -- --ticket fixtures/sample-ticket.md --repo /path/to/git/app
```
