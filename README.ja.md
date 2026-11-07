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

`id` または `ids` のどちらか一方を指定します。`ids` は1〜12件で、13件以上は分割します。返却された `clips` の各曲が `complete` か確認してください。約50秒後も生成中なら同じ待機リクエストを繰り返します。

IDの前後の空白は除去し、重複IDは1件にまとめてSunoへ送ります。1リクエストの上限は重複除去前の12件です。

## Max Mode

通常生成・サンプル・Cover・Extend・Mashupのリクエストに、トップレベルの `"max_mode":true` を指定できます。曲全体の声やスタイルの一貫性、Coverでの原曲の再現などを重視するオプションで、**通常より多くのクレジットを消費します**。[Suno公式の説明](https://help.suno.com/en/articles/13924481)も確認してください。

```bash
curl -X POST http://127.0.0.1:8787/api/songs \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"description":"Bright hi-fi pop with consistent female vocals", "max_mode":true}'
```

指定できるのはJSONの `true` / `false` です。文字列の `"true"` などは400になります。`false` はそのまま転送し、省略した場合はSunoにこの項目を送りません。`controls` の中には入れず、独立した項目として指定してください。曲の尺やモデルは自動変更せず、利用可否と消費クレジットはSuno側が決めます。

## Varietyと複数曲の参照

通常生成・サンプル・Cover・Extend・Mashupでは、`controls.variety` に整数の **0（Off）・1（Normal）・2（High）・3（Extra）・4（Max）** を指定できます。スタイル指定をどこまで再解釈するかを調整する値で、省略時はSunoの既定値を使います。Max Modeとは別の設定で、suno.comへのログインではVariety自体に有料機能の権限は不要です。

`POST /api/songs` と `/api/samples` は、最大10曲を `reference_audio_ids` で指定できます。

```json
{
  "description": "Sunriseのボーカルを切り出してローファイのビートにして",
  "reference_audio_ids": ["SOURCE_CLIP_ID"],
  "controls": {"variety": 2}
}
```

リミックス・サンプリング・リマスター・ステムの抽出や除去などの指示を `description` に書き、曲はタイトルで示します。Simpleモード専用のため、`instrumental:true` でも `lyrics`・`style`・`negative_style` は併用できません。参照する曲は完成済みで、自分の曲かリミックスが許可された曲に限ります。IDの前後の空白を除去し、重複は400で拒否します。曲の権限はSuno側が確認します。

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

Coverの `title`（最大256文字）も転送します。ただし、Sunoの入力定義には存在する一方、説明文には元曲のタイトルを使うと残っており、指定したタイトルが反映されるかは未確認です。

## 音源への質問

`POST /api/songs/:id/listen` に `{"question":"楽器の構成を説明して。最後にbpmとkeyをJSONで示して"}` を送ります。完成済みの音源が対象で、202と質問の受付IDが返ります。

その受付IDを `GET /api/listens/:id/wait` に指定して回答を待ちます。曲のIDではありません。応答は200で、`status` が `processing` なら同じ待機を繰り返します。回答やJSONブロックは `answer` の文字列として返り、ブリッジが自動解析することはありません。

suno.comへのログインが必要で、生成クレジットは使いません。未回答の質問は同時に5件、1日200件（UTC基準）まで。回答を読める期間は1日です。

## 効果音・ループ生成

`POST /api/sounds` に、たとえば次を送ります。

```json
{"description":"Boom bap drums", "loop":true, "tempo":90, "key":"Am", "idempotency_key":"drums-001"}
```

suno.comのPro以上のプランが必要で、2個の音源を生成し、1個につき1クレジットを使います。`description` は1〜500文字。任意項目は `loop`、整数の `tempo`（1〜300 BPM）、`key`、`title`、`idempotency_key` です。キーは `C#`・`C#m` などシャープ表記を使い、モデルと尺はSunoに任せます。

通常は202で、返却された `clip_ids` をすべて保持して既存の曲情報・待機APIを使います。`?wait=complete` も利用でき、既存の残高チェックと冪等キーの必須化も適用されます。

## MIDIから生成

`POST /api/midi/uploads/sessions` に `{}` または空の本文を送ると、201で `midi_upload_id`・`upload_url`・`upload_fields` が返ります。10分以内に、そのURLへ **multipart/form-dataでPOST** してください。返却された `upload_fields` の全項目を先に追加し、最後に `file` としてMIDIファイルを付けます。音声アップロードのPUTとは異なります。音符のある `.mid`・`.midi` が対象で、上限は256 KBです。URLと署名フィールドは非公開にしてください。

送信後、`POST /api/midi/uploads/MIDI_UPLOAD_ID/complete` に `{}` または空の本文を送ります。200の応答に含まれる `midi_upload_id` を通常生成・サンプルで使えます。

```json
{
  "midi_upload_id": "MIDI_UPLOAD_ID",
  "description": "このメロディを使ったシンセウェーブ",
  "idempotency_key": "melody-001"
}
```

MIDIのみでも生成でき、`description` は任意です。Simpleモード専用で、`lyrics`・`style`・`negative_style` は併用できません。`model` は省略時にSunoが `v6-wild` を選び、明示する場合も `v6-wild` に限ります。MIDIは参照10件のうち1件に数えるため、併用する `reference_audio_ids` は最大9件です。既存の残高・冪等キーの検査と `?wait=complete` なども使えます。著作権チェックが終わるまで曲は `queued` のままで、早期再生は始まりません。

添付済みMIDIのメタデータがある場合は、セッション作成に `file: {"download_url":"…","file_id":"…"}` を渡せます。`file_name`・`mime_type` と添付元の追加メタデータも保持します。この場合はSunoが直接取得・検証し、完了済みアップロードを200で返すため、別途送信・完了通知は不要です。suno.comへのログインが必要です。

## ステム分離・MIDI変換

`POST /api/songs/CLIP_ID/stems` に `{"mode":"two","idempotency_key":"stems-001"}` を送ると、202でグループが返ります。その `id` を `GET /api/songs/CLIP_ID/stems/GROUP_ID` に指定し、`status` が `pending` でなくなるまで取得します。

`two` はボーカル・伴奏を2テイクずつ（計4曲）、`twelve` は12パートを2テイクずつ（計24曲）に分離します。`partial` は一部失敗なので、各ステムの結果も確認してください。各 `audio_id` は通常の曲IDとして使えます。自分のライブラリの完成済み音源が対象で、ステムの再分離はできません。

現在のSunoの説明では `two` は10、`twelve` は50クレジットで、成功したテイクごとに課金されます。実行前にモードと費用を確認してください。残高検査と冪等キーの必須化が適用されます。再試行は同じキーを使います。ステム作成の `?wait=` は400になるため、専用のグループ取得APIを使ってください。

MIDI変換は `POST /api/songs/CLIP_ID/midi` に `{}` または空の本文を送り、繰り返し確認します。HTTP 200で、`status` が `processing` なら処理中、`ok` ならMIDIの `url` と `instruments`、`failed` なら変換失敗です。Studio対応のPremierプランが必要で、現在の説明では初回は10クレジット、変換済み曲の再取得と生成型Get Stems由来のステムは無料です。初回の費用と最新条件は `/api/tools` で確認してください。ブリッジは毎回残高を検査します。このツールには冪等キーの入力がなく、Sunoが曲IDごとに結果を再利用するため、`REQUIRE_IDEMPOTENCY_KEY` の対象外です。未完成の曲では `not_ready`（422）を返すので、完成後に再実行してください。

## caption・公開設定の編集

`PATCH /api/songs/CLIP_ID` は `caption`（最大500文字）にも対応します。単独でも `title`・`lyrics` と組み合わせても指定でき、空文字列で曲ページの説明を消せます。編集項目は最低1つ必要です。

`PATCH /api/songs/CLIP_ID/settings` は `visibility`（`public`・`private`）、`can_remix`（JSONの真偽値）、または両方を受け付けます。省略した項目はそのままで、`false` も保持します。`public` は曲を公開するので、ユーザーが希望した場合に指定してください。自分の曲と `library:write` 権限が必要です。

再生が始まった曲でも公開が保留される場合は、`publish_pending: true` と返却された `visibility` を確認します。Sunoは `can_remix` を先に変更するため、その後の公開が失敗した場合も `details` に変更済みの情報が含まれることがあります。ブリッジは自動再試行しません。

## その他のAPI

| メソッド・パス | 内容 |
|---|---|
| `GET /preview?ids=ID1,ID2` | 曲ごとのSunoプレーヤーを並べたWebページ。認証なし |
| `GET /api/account` | ログイン中のユーザーの公開プロフィール |
| `GET /api/account/upgrade` | プラン変更・クレジット購入のリンク |
| `GET /api/usage` | クレジット・プラン情報 |
| `GET /api/models` | このアカウントで `model` に指定できるラベル |
| `GET /api/library?query=...` | 既存楽曲の検索・参照 |
| `GET /api/library/liked` | いいね済みの曲 |
| `POST /api/songs` | 通常生成。曲数はSuno側の既定値 |
| `POST /api/speech` | `script` または `prompt` から音声を生成。モデルは既定のみ |
| `POST /api/sounds` | 効果音・ワンショット・ループを2個生成 |
| `POST /api/songs/wait` | 1件の `id` または最大12件の `ids` を待機 |
| `POST /api/songs/wait-all` | 最大20件の `ids` を、確定するまで繰り返し待機 |
| `GET /api/songs/events?ids=ID1,ID2` | 曲の状態変化をServer-Sent Eventsで通知 |
| `GET /api/songs/:id` | 曲情報・生成状態 |
| `PATCH /api/songs/:id` | 曲の `title`・`lyrics`・`caption` を変更 |
| `PATCH /api/songs/:id/settings` | 公開状態・リミックス許可を変更 |
| `POST /api/songs/:id/midi` | MIDI変換を開始・確認。初回はクレジット消費の場合あり |
| `POST /api/songs/:id/stems` | `two`・`twelve` でステム分離を開始 |
| `GET /api/songs/:id/stems/:group_id` | ステムの両テイクと各処理結果を取得 |
| `POST /api/midi/uploads/sessions` | MIDIのアップロード先を発行、または添付を取り込み |
| `POST /api/midi/uploads/:id/complete` | 送信済みMIDIを検証し、生成用IDを取得 |
| `GET /api/songs/:id/wait` | 再生可能まで待つ |
| `GET /api/songs/:id/analysis` | タグ、拍、テンポ、キー、セクションの取得。`status` が `processing` でなくなるまで再取得 |
| `POST /api/songs/:id/listen` | 完成済み音源に質問し、受付IDを取得 |
| `GET /api/listens/:id/wait` | 質問の受付IDで回答を待機 |
| `GET /api/songs/:id/lyrics-alignment` | 単語ごとのタイミング取得。`status` が `processing` でなくなるまで再取得 |
| `POST /api/songs/:id/download` | MP3・WAVのURLを取得。ダウンロードクレジットを使う場合あり |
| `POST`・`DELETE /api/songs/:id/like` | いいね・解除。POSTに `{"dislike":true}` を渡すと低評価 |
| `GET /api/voices` | `voice_id` に使えるボイスの一覧 |
| `POST /api/voices/start` | ボイスを作成するsuno.comのURLを取得 |
| `GET`・`POST /api/playlists` | プレイリストの一覧・作成 |
| `GET`・`POST`・`DELETE /api/playlists/:id/songs` | プレイリスト内の曲の一覧・追加・削除 |
| `GET`・`POST /api/workspaces` | ワークスペースの一覧・作成 |
| `PATCH /api/workspaces/:id/songs` | `add`・`remove` で曲を移動。応答の `skipped` を確認 |
| `POST /api/songs/:id/mashup` | `additional_audio_id` で2曲を合成 |
| `POST /api/songs/:id/extend` | `continue_at` 秒以降を生成 |
| `POST /api/songs/:id/full-song` | Extensionチェーンを結合 |
| `GET /api/tools` | Suno MCPのツール一覧・スキーマ |
| `POST /api/tools/:name/call` | 明示的に許可したツールの汎用呼び出し |

詳細なパラメータ・使用例・注意点は [README.md](README.md) に記載しています。

音声・画像・リソースを含むMCP応答は、元の `content` 配列と、存在する場合は `structuredContent` をまとめて返します。テキストだけの応答は、構造化データまたは単一のJSONデータを直接返し、補足の案内文は意図的に省略します。

Sunoのツールがリクエストを拒否した場合は、`details` にSuno側のエラーを入れて返します。`details` は通常 `code` を持つオブジェクトですが、`null`、文字列、配列など任意のJSON値になることがあるので、`details.code` を読む前に型を確認してください。HTTPステータスはこのコードで決まります。

| `details.code` | HTTPステータス |
|---|---|
| `invalid_request` | 400 |
| `insufficient_credits` | 402 |
| `forbidden`、`feature_not_on_plan`、`user_principal_required` | 403 |
| `not_found` | 404 |
| `idempotency_key_reused`、`idempotency_in_progress` | 409 |
| `not_ready` | 422 |
| `rate_limited`、`quota_exceeded`、`concurrency_limit_exceeded` | 429 |
| 上記以外、コードなし、または `details` がオブジェクトでない場合 | 502 |

接続エラーも502を返しますが、`details` は含みません。以前はツールの拒否もすべて502だったので、502だけをSunoのエラーとして扱うクライアントは修正が必要です。

## 便利機能

- **モデルの事前確認:** `model` がこのアカウントで使えない場合は、Sunoに送らず400を返します。クレジットは消費しません。
- **生成して待つ:** `/api/songs`、`/api/samples`、`/api/speech`、`/api/sounds`、`/cover`、`/mashup`、`/extend` に `?wait=playable` または `?wait=complete` を付けると、作成から待機までを1リクエストで行います。`timeout` は1〜600秒で、既定は300秒です。待機が失敗やタイムアウトになっても、作成済みの `created` と `pending` を202で返します。
- **クレジット上限:** `.env` の `MIN_CREDITS_REMAINING` を設定すると、残高がこの値を下回ったときに402を返して生成を止めます。残高を読めない場合は502で拒否します。
- **冪等キーの必須化:** `REQUIRE_IDEMPOTENCY_KEY=true` にすると、`idempotency_key` のない生成リクエストに400を返します。
- **ダウンロードの確認:** `requires_credit` が返ったら、ユーザーの承認を得てから `"confirm":true` で再度呼びます。ブリッジが自動で `confirm` を付けることはありません。

## ダウンロードクレジットを使わずに聴く

応答に `song_url` があれば、Sunoの埋め込みプレーヤーの `embed_url` を追加します。ダウンロードクレジットを使わずに再生できます。

複数の曲を聴き比べるときは、ブラウザで `/preview?ids=ID1,ID2` を開きます。最大20曲まで指定できます。`?wait=` と `wait-all` の応答、SSEの `done` イベントには、`embed_url` のある曲をまとめたリンクが `preview_url` として入ります。相対パスなので、ブリッジのアドレスを補ってください。`/api/tools/:name/call` はSunoの結果をそのまま返すので、`embed_url` は付きません。

ブラウザのページ遷移ではBearerヘッダーを送れないため、このページには認証がありません。ページに入るのはURLのIDだけで、Sunoも呼び出しません。ただし `HOST=0.0.0.0` にすると、ほかのルートと同様に外部からアクセスできるようになります。

- **共有リンクとして扱ってください。** 埋め込みプレーヤーはログインなしで開け、**非公開の曲でも**、URLや曲のIDを知っている人なら誰でも聴けます。
- **Suno MCPの機能ではありません。** 予告なく変更や停止される可能性があり、ブリッジでは検知できません。ほかのAPIはこのページに依存していません。
- **聴くのは `complete` になってからにしてください。** `song_url` と `embed_url` は曲が `streaming` になると付きますが、未ログインのブラウザで試したところ、この段階では2回とも再生できず、同じ曲が `complete` になると再生できました。すぐ開くリンクには `?wait=complete` を使うか、`?wait=playable` のリンクは曲の完成後に開き直してください。ログイン済みのブラウザでは確認していません。
- **聴くための機能です。** ファイルが必要なときは `/download` を使ってください。ブリッジは埋め込みページから音声を取り出しません。プレーヤーが読み込むファイルも、データが暗号化または難読化されていて、MP4としてそのまま読むことはできません。

## 制約

- ローカル・単一ユーザー用の構成です。`HOST=0.0.0.0` に変えて無条件で外部公開しないでください。
- アップロード後の参照生成は、元の音源が`complete`になる必要があります。
- 指定した尺で曲が終わらず、途中で打ち切られる場合があります。
- OAuthで利用できるMCPツールや機能はSuno側の権限・プランに依存します。

メンテナンスの手順は [MAINTENANCE.md](MAINTENANCE.md) にまとめています。
