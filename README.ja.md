# Suno MCP → REST API ブリッジ v0.2

**非公式のローカル用アダプター**です。Suno公式MCP（`https://api.suno.com/mcp`）にOAuthで接続し、自作アプリからREST APIを呼び出せるようにします。別会社の非公式Suno APIは使いません。楽曲生成時には、接続したSunoアカウントのクレジットが使われます。

## 起動

Node.js 22以上が必要です。

```bash
npm install
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

生成したランダムな文字列を `.env` の `API_KEY` に設定します。これはローカルREST APIを保護するためのキーで、Sunoの認証キーではありません。

```bash
npm run auth  # ブラウザでSuno認証
npm run dev   # 127.0.0.1:8787で起動
npm run typecheck
npm test      # Sunoにはアクセスしないモックテスト
npm run test:upload-smoke  # Node.js標準機能だけで動くアップロード単体テスト
```

以下の例では `YOUR_KEY` を `.env` の `API_KEY` に置き換えてください。

## 短尺サンプル（15秒・1曲）

```bash
curl -X POST http://127.0.0.1:8787/api/samples \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"description":"Bright hi-fi future pop with female vocals", "duration":15}'
```

指定できる尺は15〜60秒です。既定値は **15秒・1曲・指定尺で打ち切り**。Suno MCPの15秒未満の直接生成には対応していません（5〜10秒の切り出しは別途音声編集が必要）。

## 参照音源のアップロード

```bash
curl -X POST http://127.0.0.1:8787/api/uploads/file \
  -H 'Authorization: Bearer YOUR_KEY' \
  -F 'file=@./reference.wav' -F 'title=Reference'
```

処理結果の `clip_id` を取得し、`GET /api/songs/{clip_id}` で `status=complete` になるまで確認します。`MAX_UPLOAD_MB=32` がブリッジの初期上限です。大きい音源は `POST /api/uploads/sessions` で署名付きURLを取得し、直接PUTしてから `POST /api/uploads/{session_id}/complete` します。

## 参照音源からCover（30秒）

```bash
curl -X POST http://127.0.0.1:8787/api/songs/SOURCE_CLIP_ID/cover \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"style":"Bright future pop", "duration":30, "controls":{"audio_influence":0.7}}'
```

`audio_influence` は対応プランのみ利用可能です。Coverは元曲の歌詞を引き継ぎません。ボーカルを残したい場合は `lyrics` や `voice_id` を指定します。

## その他のAPI

| メソッド・パス | 内容 |
|---|---|
| `GET /api/usage` | クレジット・プラン情報 |
| `GET /api/library?query=...` | 既存楽曲の検索・参照 |
| `GET /api/library/liked` | いいね済みの曲 |
| `POST /api/songs` | 通常生成。既定1曲 |
| `GET /api/songs/:id` | 曲情報・生成状態 |
| `GET /api/songs/:id/wait` | 再生可能まで待つ |
| `POST /api/songs/:id/mashup` | `additional_audio_id` で2曲を合成 |
| `POST /api/songs/:id/extend` | `continue_at` 秒以降を生成 |
| `POST /api/songs/:id/full-song` | Extensionチェーンを結合 |
| `GET /api/tools` | Suno MCPのツール一覧・スキーマ |
| `POST /api/tools/:name/call` | 明示的に許可したツールの汎用呼び出し |

詳細なパラメータ・使用例・注意点は [README.md](README.md) に記載しています。

## 制約

- ローカル・単一ユーザー用の構成です。`HOST=0.0.0.0` に変えて無条件で外部公開しないでください。
- アップロード後の参照生成は、元の音源が`complete`になる必要があります。
- 指定した尺で曲が終わらず、途中で打ち切られる場合があります。
- OAuthで利用できるMCPツールや機能はSuno側の権限・プランに依存します。
- `npm test` はモックであり、Suno認証や実際の楽曲生成は検証しません。
