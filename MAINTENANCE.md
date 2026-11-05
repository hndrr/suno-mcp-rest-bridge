# メンテナンス

## 検証

```bash
npm run typecheck
npm test
npm run test:upload-smoke
```

## スキーマ差分の確認

```bash
npm run check:schema
```

終了コードは、`0` が差分なし、`1` が差分あり、`2` が取得失敗。

変更があれば、作成されたDraft PRの差分を確認し、必要なブリッジ修正と検証を済ませてからマージする。

基準スキーマを手動で更新するときは、変更内容を確認してから実行する。

```bash
npm run check:schema -- --update
```

## 監視の再実行・再認証

Actionsの **Suno MCP schema watch** で結果を確認し、手動実行は **Run workflow** を使う。

認証エラーが出たら、次を実行して監視を再実行する。

```bash
npm run setup:schema-monitor -- hndrr/suno-mcp-rest-bridge
```
