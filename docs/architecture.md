# アーキテクチャ

## プロセス構成

```text
┌────────────────────────── Main Process (Node.js) ──────────────────────────┐
│ electron/main        起動・単一インスタンス・セキュリティ・サービス結線          │
│ electron/windows     CharacterController (円 / 入力欄 / ボタン の制御)          │
│                      SettingsWindow                                          │
│ electron/ipc         IPC ハンドラー (送信元確認 + zod 検証)                    │
│ electron/system      トレイ・ショートカット・ユーザー操作検知・自動起動・OS の許可 │
│ src/services/*       PC 操作エンジン / AI / エージェント / タスク / 設定        │
└──────────────┬──────────────────────────────────────────────┬──────────────┘
               │ contextBridge (window.gumi のみ)               │
┌──────────────┴───────────┐ ┌────────────────────┐ ┌──────────┴─────────┐
│ #face  円 + 入力欄・ボタン │ │ #cursor AI カーソル │ │ #settings 設定画面 │
└──────────────────────────┘ └────────────────────┘ └────────────────────┘
          Renderer (React, sandbox, contextIsolation, nodeIntegration 無効)
```

Renderer は 1 つの Vite ビルドをハッシュ (`#face` / `#cursor` / `#settings`) で切り替えて使います。

## src/services の役割

| ディレクトリ | 実行場所 | 内容 |
|---|---|---|
| `automation/` | Main | PC 操作エンジン。OS 共通のインターフェース (`types.ts`) と、Windows 実装 (`win32/`: Win32 API + UI Automation) / macOS 実装 (`macos/`: CoreGraphics + アクセシビリティ API)。アプリ起動、ファイル操作、キー配列 |
| `computer-use/` | Main | ツール定義 (zod)、権限判定、座標変換、機密マスキング、実行器 (`ComputerUseExecutor`) |
| `screenshots/` | Main | desktopCapturer による撮影、画面変化検知 |
| `ai/` | Main | プロバイダー別セッション (Anthropic / OpenAI 互換 / Gemini / JSON フォールバック)、HTTP 再試行 |
| `web/` | Main | DuckDuckGo 検索、ページ本文の取得 (公開サイトのみ・1 回 3 サイトまで) |
| `agent/` | Main | エージェントループ、システムプロンプト、繰り返し検出 |
| `tasks/` | Main | タスク状態 (開始・一時停止・再開・停止・承認・質問)、履歴保存 |
| `settings/` | Main (`constants.ts` は共有) | 設定スキーマ・移行・保存、API キーの暗号化保存 |
| `layout/` | 共有 | 円の配置、入力欄・ボタン・小さな円の配置と当たり判定、AI カーソルの形 (純粋関数) |
| `expressions/` | 共有 | 円の状態表現の一元決定 (純粋関数) |

## データの流れ (タスク実行)

1. 円の横の入力欄で指示を入力 → `agent:start`
2. `TaskManager` が設定を検証して `runAgent` を開始
3. `runAgent`: 初期画面の観察 → モデル呼び出し → ツール呼び出しを検証 (zod) → 権限判定 → 必要なら承認待ち → `ComputerUseExecutor` で実行 → 再撮影して結果確認 → モデルへ結果を返す
4. 状態とログは `agent:status` / `agent:log` イベントで Renderer に配信、履歴に保存
5. `task_complete` (またはテキストのみの応答) で終了 → 円の中にチェックマーク (失敗は揺れ) と、円の横に結果の吹き出しを表示。円が非表示のときだけ OS の通知

## OS ごとの PC 操作エンジン

`src/services/automation/index.ts` の `createAutomation` が、実行中の OS に合った実装を返します。上位 (`ComputerUseExecutor` など) は OS を意識せず、`Automation` インターフェース (入力 / ウィンドウ / プロセス / UI 要素 / アプリ起動) だけを使います。

| | Windows | macOS |
|---|---|---|
| 座標 | 物理ピクセル (Per-Monitor DPI V2) | ポイント (= Electron の DIP) |
| 入力 | `SendInput` | `CGEventPost` (CGEvent) |
| ウィンドウ列挙 | `EnumWindows` + DWM | `CGWindowListCopyWindowInfo` |
| UI 要素・ウィンドウ操作 | UI Automation (常駐の PowerShell プロセス `uia-host.ps1`、JSON Lines 通信) | アクセシビリティ API (`AXUIElement`)。応答しないアプリで UI が固まらないよう worker_threads 上で実行 (`ax-worker.ts`) |
| プロセス一覧 | Toolhelp32 | libproc |
| アプリ起動 | エイリアス / スタートメニュー / PATH | エイリアス / アプリケーションフォルダ / `open -a` |
| 必要な許可 | なし | アクセシビリティ・画面収録 (`electron/system/permissions.ts`) |

OS の API はすべて [koffi](https://koffi.dev/) (FFI) で Node.js から直接呼ぶため、ネイティブアドオンのビルドは不要です。macOS のアクセシビリティ ワーカーはビルド時に 1 つのスクリプトにまとめて Main に埋め込み (`scripts/build-electron.mjs`)、`worker_threads` で実行します。

## 通信

Gumi が通信するのは、設定した AI プロバイダーの API と、Web 検索ツールを使ったときの DuckDuckGo (検索と結果ページの本文取得) だけです。利用状況の収集や自動アップデートの確認などは行いません。
