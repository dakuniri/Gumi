# セキュリティポリシー / Security Policy

Gumi は AI にパソコンを操作させるソフトウェアなので、安全性の問題はとくに重要です。

## 脆弱性の報告

公開の Issue には書かず、GitHub の **Security > Report a vulnerability** (Private vulnerability reporting) から報告してください。
次のような問題を歓迎します。

- AI (または Web ページ・画面上の文字などから AI に紛れ込んだ指示) が、承認なしに危険な操作をできてしまう
- 権限設定 (許可 / 毎回確認 / 禁止) や、保護しているフォルダ・キー操作の制限を回避できる
- API キーや画面の内容が、設定した AI プロバイダー以外へ送られる
- Renderer (画面) から Node.js や OS の機能を直接使えてしまう

報告には、再現手順・影響・使っている OS と Gumi のバージョンを書いてください。確認でき次第、修正版を公開します。

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Security > Report a vulnerability** (private vulnerability reporting) and include reproduction steps, impact, your OS and the Gumi version.

## 対象のバージョン

最新のリリースだけを修正の対象にします。
