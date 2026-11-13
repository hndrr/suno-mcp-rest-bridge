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

差分があれば、管理用リポジトリが作成したDraft PR、または手動確認の出力で変更内容を確認し、必要なブリッジ修正と検証を済ませてから基準スキーマを更新する。

基準スキーマを手動で更新するときは、変更内容を確認してから実行する。

```bash
npm run check:schema -- --update
```

## 自動監視

自動監視、監視専用OAuthの設定、認証状態の保存、更新PRの作成は管理用リポジトリで実行する。再実行・再認証はそちらの運用メモに従う。

このリポジトリでは `test/fixtures/suno-input-schemas.json` を基準データとして管理し、差分判定とREST APIの互換性テストを行う。`check:schema` は開発者がローカルのSuno認証で実行する手動確認用コマンド。通常のGitHub CIは型チェックとテストを実行し、監視用の認証情報は使わない。
