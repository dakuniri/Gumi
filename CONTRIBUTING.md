# 参加するには / Contributing

Issue・Pull Request を歓迎します。

## 開発の始め方

```bash
npm install
npm run dev
```

変更したら、次がすべて通ることを確認してください。

```bash
npm run typecheck
npm test
```

PC 操作エンジン (`src/services/automation/`) を変えた場合は、実機でも確認してください。

```bash
npm run test:system
```

## 方針

- **安全性を優先します。** AI ができることを増やす変更では、権限の分類 (`src/services/computer-use/tools.ts` の `category` と `risk`)・承認の要否・取り消せるかどうかを必ず考えてください
- **ローカルで完結させます。** 設定した AI プロバイダーと、Web 検索ツールの DuckDuckGo 以外へ通信する機能 (利用状況の収集など) は入れません
- Windows と macOS の両方で動くようにしてください。OS ごとの処理は `src/services/automation/win32/` と `src/services/automation/macos/` に分け、共通のインターフェースは `src/services/automation/types.ts` にあります
- UI・ログ・ドキュメントに絵文字は使いません
- コードのコメントと UI の文言は日本語です

## ライセンス

送っていただいた変更は、このリポジトリと同じ [MIT-0](LICENSE) で公開されることに同意したものとします。

---

Issues and pull requests are welcome. Please run `npm run typecheck` and `npm test` before submitting. Contributions are licensed under [MIT-0](LICENSE).
