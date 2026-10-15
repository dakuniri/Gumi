# Gumi

デスクトップに常駐する小さな円から、AI にパソコンの操作を頼めるアシスタントです (Windows / macOS)。
「メモ帳を開いて今日の予定を書いて」「〇〇について調べて」のように頼むと、AI が画面を見ながらマウス・キーボード・アプリ・ウィンドウ・ファイルを操作します。

> **English summary** — Gumi is a tiny always-on-top orb for Windows and macOS. Click it, type what you want done, and an AI model of your choice (Anthropic, OpenAI, Gemini, OpenRouter, any OpenAI-compatible API, or a local LLM such as Ollama / LM Studio) looks at the screen and operates the mouse, keyboard, apps, windows and files for you. Risky actions require your approval, you can pause or stop at any time, and everything runs locally except the requests to the AI provider you configure (and DuckDuckGo when the web search tool is used). Licensed under MIT-0.

- サーバーやアカウントは不要です。アプリはあなたのパソコンだけで動き、通信するのは**あなたが設定した AI プロバイダー**と、Web 検索を使ったときの **DuckDuckGo** だけです
- AI プロバイダーは Anthropic (Claude) / OpenAI / Google Gemini / OpenRouter / OpenAI 互換 API / ローカル LLM (Ollama, LM Studio など) から選べます
- 取り消せない操作 (送信・購入・削除・インストールなど) の前には必ずあなたの承認を求めます

> [!WARNING]
> Gumi は AI にあなたのパソコンを実際に操作させるソフトウェアです。AI は間違えることがあります。
> 大事な作業中や、見られて困る情報が画面に出ているときは使わないでください。作業中はいつでも一時停止・停止できます (下記の「止め方」)。

## できること

- **円にカーソルを合わせる** → 上に 2 つの小さな円が出ます (歯車: 設定 / 半分塗り: 白と黒の切り替え)
- **円をクリック** → 横に入力欄が伸びます。やってほしいことを入力して Enter
- 作業中は円の上に **一時停止** と **停止** のボタンが出ます
- 承認が必要な操作や AI からの質問は、円の横 (入力欄の位置) に「許可 / 拒否」や回答欄として出ます
- 作業が終わると、円の横に結果 (AI のまとめや失敗の理由) を吹き出しで表示します
- 円の中の記号で状態がわかります: 考え中「?」 / 検索中 虫眼鏡 / 操作中「・・・」 / 完了 チェックマーク
- AI がマウスを動かしている間は、その位置に「<」の形のカーソルを表示します
- 調べものには DuckDuckGo 検索を使い、1 回の検索で最大 3 サイトの本文を読みます
- 「N 秒後にここをクリック」のような予約もできます
- 色は 白 / 黒 / 亜夢 (緑) から選べます (亜夢は設定画面から)
- 会話・操作のログと過去のタスクは設定画面の「履歴」で見られます

## 動作環境

| | |
|---|---|
| Windows | Windows 10 (2004 以降) / Windows 11、x64 |
| macOS | macOS 12 以降、Apple Silicon / Intel。アクセシビリティと画面収録の許可が必要 |
| AI | 上記いずれかのプロバイダーの API キー (ローカル LLM なら不要)。画面を見るには画像入力に対応したモデルが必要 |

## インストール

[Releases](https://github.com/dakuniri/Gumi/releases) から入手してください。

- **Windows**: `Gumi-Setup-<バージョン>.exe` を実行します。コード署名をしていないため、「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」を選んでください
- **macOS**: お使いの Mac に合う dmg (`arm64` = Apple Silicon / `x64` = Intel) を開き、Gumi をアプリケーションフォルダへドラッグします。開発者証明書で署名していないため、初回は Finder で Gumi を右クリック →「開く」で起動してください

ソースからビルドする方法は「開発」を見てください。

## 使い方

1. 円にカーソルを合わせ、歯車の円から設定を開きます
2. 「AI プロバイダー」でプロバイダー・モデル・API キーを設定し、「接続テスト」を押します
3. 円をクリックし、入力欄にやってほしいことを入力して Enter

### 止め方

- 円の上の **停止** ボタン (押されたままのキー・マウスボタンも離します)
- 緊急停止ショートカット: `Ctrl+Alt+Esc` (macOS は `Control+Option+Esc`)
- 一時停止 / 再開: `Ctrl+Alt+P` (macOS は `Control+Option+P`)
- AI がマウス・キーボードを操作している最中にあなたがマウスやキーボードを使うと、自動で一時停止します
- タスクトレイ (macOS はメニューバー) のアイコンからも停止できます

ショートカットは設定画面で変更できます。

### macOS の許可

最初に指示を送ると macOS の確認が出ます。**システム設定 > プライバシーとセキュリティ** で次の 2 つを Gumi に許可してください (設定画面の「システム」タブからも開けます)。

- **アクセシビリティ**: マウス・キーボードの操作と、ボタンなどの UI 要素の取得に使います
- **画面収録**: 画面を見るのに使います。許可した後は Gumi の再起動が必要です

開発者証明書で署名していないため、新しいバージョンに入れ替えると許可をやり直す必要がある場合があります (一覧から Gumi を一度削除して追加し直してください)。

## プライバシーと送信する情報

AI プロバイダーへ送るもの:

- あなたの指示文
- 画面のスクリーンショット (縮小した JPEG)。範囲は「カーソルのあるディスプレイ / メインディスプレイ / アクティブウィンドウのみ」から選べます
- ウィンドウのタイトル、ボタンなどの UI 要素の名前と位置、操作の結果

次のようにして、余計な情報が送られないようにしています。

- タイトルに機密を示す言葉 (既定: パスワード、1Password、KeePass など) を含むウィンドウが表示されているときは、スクリーンショットを送りません
- クリップボード・ファイル・UI 要素の値に含まれる API キー・トークン・カード番号・パスワード表記は伏せ字にしてから送ります
- Gumi 自身の円とカーソルは、AI のスクリーンショットに写らないようにしています (OS のキャプチャ除外機能を使うため、環境によっては写ることがあります)
- 送信内容の概要 (文字数・画像の枚数・送信先) はタスクトレイのアイコンに表示します

Web 検索を使うと、検索語が DuckDuckGo に送られます (設定で「毎回確認」「禁止」にできます)。
それ以外の送信 (利用状況の収集・自動アップデートの確認など) は一切ありません。

## データの保存場所

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\Gumi` |
| macOS | `~/Library/Application Support/Gumi` |

| ファイル | 内容 |
|---|---|
| `settings.json` | すべての設定 (AI プロバイダー・モデル・権限・見た目など) |
| `secrets.json` | API キー。OS の仕組み (Windows: DPAPI / macOS: キーチェーン) で暗号化し、同じユーザーでしか読めません |
| `history.json` | 会話と操作の履歴 (スクリーンショットは保存しません。設定で無効にできます) |

設定は入力すると自動で保存されます。アンインストールしてもこのフォルダは残るので、完全に消したいときは手動で削除してください。

## 安全のしくみ

- AI はプログラムを実行できず、決められた操作 (ツール) だけを使えます。不正な引数は実行前に拒否します
- 操作の種類ごとに「許可 / 毎回確認 / 禁止」を設定できます
- ファイルの削除はごみ箱への移動だけです (完全削除はできません)。システムのフォルダや Gumi 自身のデータは操作できません
- 画面ロックやログアウト、Gumi の緊急停止ショートカットなど、一部のキー操作は AI から送れません
- 詳しくは [docs/security.md](docs/security.md) を見てください

## 開発

必要なもの: Node.js 22.12 以上、npm。

```bash
npm install
npm run dev
```

`npm run dev` で開発モードで起動します (Vite + esbuild watch + Electron)。

npm 11 以降で install script がブロックされた場合は、`koffi`・`esbuild`・`electron-winstaller` を許可してください (`package.json` の `allowScripts` に記載しています)。

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発モードで起動 |
| `npm run build` | 型チェック + Renderer / Main のビルド |
| `npm start` | ビルド済みのアプリを起動 |
| `npm test` | 単体テスト (Vitest) |
| `npm run test:system` | 実機での PC 操作エンジンの動作確認 (読み取りのみ)。`-- --input` でマウス移動、`-- --web` で DuckDuckGo 検索も確認 |
| `npm run dist` | Windows インストーラーを `release/` に作成 |
| `npm run dist:mac` | macOS の dmg を作成 (macOS 上でのみ) |
| `npm run icons` | アイコンを作り直す |

GitHub Actions では、push と pull request ごとに Windows と macOS で型チェック・テスト・PC 操作エンジンの確認を行い、`v` で始まるタグを push するとインストーラーを作って下書きの Release に添付します。

### 構成

```text
electron/        Main Process (ウィンドウ・IPC・トレイ・ショートカット・ユーザー操作の検知・OS の許可) / Preload
src/services/    PC 操作エンジン (Windows / macOS)・AI プロバイダー・エージェント・タスク管理・設定・Web 検索、
                 配置計算などの純粋関数
src/components/  React の UI (円、入力欄・ボタン、設定画面)
tests/           単体テスト
docs/            設計ドキュメント
```

PC 操作は、Windows では Win32 API (SendInput など) と UI Automation、macOS では CoreGraphics (CGEvent) とアクセシビリティ API (AXUIElement) を使います。どちらも [koffi](https://koffi.dev/) 経由で呼ぶため、ネイティブアドオンのビルドは不要です。

詳しくは次を見てください。

- [docs/architecture.md](docs/architecture.md): 全体の構成
- [docs/computer-use.md](docs/computer-use.md): PC 操作エンジンとツール
- [docs/security.md](docs/security.md): セキュリティと安全性
- [docs/ui-behavior.md](docs/ui-behavior.md): 円と UI の振る舞い

### 検証状況

| 区分 | 状態 |
|---|---|
| 単体テスト (キー解析・座標変換・ツール検証と権限・伏せ字処理・各 AI プロバイダーの変換・エージェントループ・タスク管理・設定・IPC 検証・配置計算など) | `npm test` で確認 |
| Windows 実機 (入力・ウィンドウ・UI Automation・画面キャプチャ・Web 検索) | 開発機で確認 (1920x1080、倍率 100%) |
| macOS (CoreGraphics・アクセシビリティ API・画面キャプチャ・マウス移動) | GitHub Actions の macOS ランナーで確認。実際の Mac での長時間の利用は十分に確認できていません |
| マルチモニター・高 DPI・日本語 IME 有効時の入力 | 十分に確認できていません |

不具合や提案は [Issues](https://github.com/dakuniri/Gumi/issues) へどうぞ。参加方法は [CONTRIBUTING.md](CONTRIBUTING.md) を見てください。

## ライセンス

[MIT No Attribution (MIT-0)](LICENSE)。著作権表示なしで自由に使用・改変・再配布できます。
本ソフトウェアは無保証です。AI による操作の結果について、作者は責任を負いません。
