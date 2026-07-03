# shinya-zumen — 深夜酒類提供飲食店 図面エディタ

深夜酒類営業許可申請用の図面（平面図・求積図・音響照明配置図）を作成するWebアプリ。
GitHub: `ito-sann/shinya-zumen` ／ 公開: https://ito-sann.github.io/shinya-zumen/ （GitHub Pages）

## 作業ルール

1. **作業開始前に必ず `git fetch origin && git status`** — 別マシンで開発が進んでいることがあり、古いコード前提で実装するとやり直しになる
2. **実装→Playwrightテスト→コミット→プッシュを1セットで、確認なしで実行してよい**（ユーザー指示済み）
3. コミット後は GitHub Pages のビルド完了を確認（`gh api repos/ito-sann/shinya-zumen/pages --jq .status` が built）し、公開URLを伝える
4. Gitの作者情報は仮のままでよい（登録不要と回答済み）

## バージョン更新（PWAキャッシュ対策・2箇所セット）

変更のたびに以下の**両方**を上げる：
- `index.html` 内のアセット版数 `?v=x.y.z`
- `service-worker.js` の `CACHE_NAME`

片方だけだと利用者のキャッシュが更新されない。

## ローカルプレビュー

`python3 -m http.server 4178 --directory /Users/itouyuutarou/dev/shinya-zumen`（Desktop/.claude/launch.json に "shinya-zumen" として登録済み）
