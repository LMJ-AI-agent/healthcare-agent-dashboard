# Healthcare Agent

Health Auto ExportがGoogle Driveへ保存した前日分JSONを読み、Codex CLIで日次ヘルスレポートを作り、Slackへ投稿する独立エージェントです。

このフォルダは既存の `slack-codex-bridge` とは分離されています。`.env` は使いません。

## 入力

```text
G:\共有ドライブ\90_AIエージェント連携用\iPhoneヘルスデータ_JSON
```

Health Auto Export側では、前日分のみをJSONでこのフォルダへ自動保存します。

## Slack Webhook

Slack Webhook URLは以下のファイルに1行だけ入れます。

```text
secrets/slack-webhook.txt
```

このファイルは `.gitignore` 済みです。

## 実行

```powershell
.\scripts\run-daily-health-report.ps1 --dry-run --no-codex --yesterday
```

本投稿:

```powershell
.\scripts\run-daily-health-report.ps1 --yesterday
```

## 自動実行

```powershell
.\scripts\register-daily-health-report-task.ps1
```

平日は7:00、土日は8:00に前日分だけを処理します。同じ日付は二重投稿しません。

## HealthPlanet連携

`secrets/healthplanet-client.json` を作成します。

```json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "redirect_uri": "https://www.healthplanet.jp/success.html"
}
```

認証URLを表示します。

```powershell
npm run healthplanet:auth-url
```

ブラウザで開いて許可し、表示された `code` を使ってトークンを保存します。

```powershell
npm run healthplanet:token -- --code YOUR_CODE
```

前日分を取得します。

```powershell
npm run healthplanet:fetch -- --yesterday
```

## GitHub Dashboard

Static dashboard files are generated under `docs/`.
This folder is safe to publish with GitHub Pages because it contains only summarized health metrics and does not include secrets.

Build:

```powershell
npm run dashboard:build
```

Preview locally:

```powershell
npm run dashboard:serve
```

Open:

```text
http://localhost:4177
```

Generated files:

```text
docs/index.html
docs/styles.css
docs/app.js
docs/health-data.json
```

GitHub Pages recommendation:

```text
Settings > Pages > Build and deployment > Deploy from a branch
Branch: main
Folder: /docs
```
