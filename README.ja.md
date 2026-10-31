# Suno MCP → REST API ブリッジ v0.3

**非公式のローカル用アダプター**です。Suno公式MCP（`https://api.suno.com/mcp`）にOAuthで接続し、自作アプリからREST APIを呼び出せるようにします。別会社の非公式Suno APIは使いません。楽曲生成時には、接続したSunoアカウントのクレジットが使われます。

## 0.3.0への移行

既存リクエストの `clip_count` を削除してください。指定すると、移行方法を含むHTTP 400エラーを返します。曲数はSuno側が決めるため、1回で複数曲分のクレジットが使われる場合があります。返却された `clip_ids` をすべて保持し、`POST /api/songs/wait` で待機してください。

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

ブラウザで <http://127.0.0.1:8787/> を開くとAPIの案内をJSONで表示します。Web操作画面はありません。<http://127.0.0.1:8787/health> は認証なしで起動確認でき、`/api/*` の呼び出しには `Authorization: Bearer YOUR_KEY` が必要です。コードを変更した場合は `npm run dev` を再起動してください。

以下の例では `YOUR_KEY` を `.env` の `API_KEY` に置き換えてください。

## 短尺サンプル（15秒）

```bash
curl -X POST http://127.0.0.1:8787/api/samples \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"description":"Bright hi-fi future pop with female vocals", "duration":15}'
```

指定できる尺は15〜60秒です。既定値は **15秒・指定尺で打ち切り**。現行Suno MCPには `clip_count` がないため、曲数はSuno側の既定動作に従います。通常生成・サンプル・Cover・Mashup・Extendに `clip_count` を指定すると400になります。1回のリクエストで複数曲が生成され、各曲のクレジットが使われる場合があります。Suno MCPの15秒未満の直接生成には対応していません（5〜10秒の切り出しは別途音声編集が必要）。

生成結果の `clip_ids` に含まれるIDをすべて待機します。1曲の場合は `id` を使えます。

```bash
curl -X POST http://127.0.0.1:8787/api/songs/wait \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"ids":["FIRST_CLIP_ID","SECOND_CLIP_ID"], "until":"complete"}'
```

`id` または `ids` のどちらか一方を指定します。`ids` は1〜4件で、5件以上は分割します。返却された `clips` の各曲が `complete` か確認してください。約50秒後も生成中なら同じ待機リクエストを繰り返します。

IDの前後の空白は除去し、重複IDは1件にまとめてSunoへ送ります。1リクエストの上限は重複除去前の4件です。

## 参照音源のアップロード

```bash
curl -X POST http://127.0.0.1:8787/api/uploads/file \
  -H 'Authorization: Bearer YOUR_KEY' \
  -F 'file=@./reference.wav' -F 'title=Reference'
```

処理結果の `clip_id` を取得し、`GET /api/songs/{clip_id}` で `status=complete` になるまで確認します。`MAX_UPLOAD_MB=32` がブリッジの初期上限です。大きい音源は `POST /api/uploads/sessions` で署名付きURLを取得し、直接PUTしてから `POST /api/uploads/{session_id}/complete` します。

チャット添付のメタデータがある場合、`POST /api/uploads/sessions` に `file: {"download_url":"https://files.example.net/reference.wav","file_id":"ATTACHMENT_ID"}` も指定できます。`file_name` と `mime_type` は `file` 内の任意項目です。ブリッジはフィールドの型を検査し、添付元の追加メタデータも保持して転送します。実際に取得できる添付かどうかはSunoが検証します。Sunoが直接取得して処理中の曲を返すため、この場合はHTTP 202となり、追加のPUT・完了通知は不要です。`file` なしの従来のセッション作成はHTTP 201です。添付URLは実際のものを使い、非公開にしてください。

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
| `POST /api/songs` | 通常生成。曲数はSuno側の既定値 |
| `POST /api/songs/wait` | 1件の `id` または最大4件の `ids` を待機 |
| `GET /api/songs/:id` | 曲情報・生成状態 |
| `GET /api/songs/:id/wait` | 再生可能まで待つ |
| `POST /api/songs/:id/mashup` | `additional_audio_id` で2曲を合成 |
| `POST /api/songs/:id/extend` | `continue_at` 秒以降を生成 |
| `POST /api/songs/:id/full-song` | Extensionチェーンを結合 |
| `GET /api/tools` | Suno MCPのツール一覧・スキーマ |
| `POST /api/tools/:name/call` | 明示的に許可したツールの汎用呼び出し |

詳細なパラメータ・使用例・注意点は [README.md](README.md) に記載しています。

音声・画像・リソースを含むMCP応答は、元の `content` 配列と、存在する場合は `structuredContent` をまとめて返します。テキストだけの応答は、構造化データまたは単一のJSONデータを直接返し、補足の案内文は意図的に省略します。

Sunoのツールがリクエストを拒否した場合は、`details` にSuno側のエラーを入れて返します。HTTPステータスは `details.code` で決まります。

| `details.code` | HTTPステータス |
|---|---|
| `invalid_request` | 400 |
| `insufficient_credits` | 402 |
| `forbidden`、`feature_not_on_plan` | 403 |
| `not_found` | 404 |
| `rate_limited`、`quota_exceeded` | 429 |
| 上記以外、またはコードなし | 502 |

接続エラーも502を返しますが、`details` は含みません。以前はツールの拒否もすべて502だったので、502だけをSunoのエラーとして扱うクライアントは修正が必要です。

## 制約

- ローカル・単一ユーザー用の構成です。`HOST=0.0.0.0` に変えて無条件で外部公開しないでください。
- アップロード後の参照生成は、元の音源が`complete`になる必要があります。
- 指定した尺で曲が終わらず、途中で打ち切られる場合があります。
- OAuthで利用できるMCPツールや機能はSuno側の権限・プランに依存します。
- `npm test` は2026-10-31取得の公式入力スキーマに照らしてモックの引数を検査します。Suno認証や実際の楽曲生成は検証しません。
