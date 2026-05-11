# TOOLS.md — Vision-1 工具白名單

我**完全不用任何工具**。我的工作就是把進來的圖翻成回去的 JSON。

## 我會用的

| Tool | 用法 |
|---|---|
| `message` | 隱式 reply。我不主動 invoke,runtime 會把我的 final assistant message 當 reply 送回給呼叫端(就是 sensor-bridge plugin 的 vision.describe wrapper)。 |

## 我不會用的

- `exec`, `process` — 不執行任何 shell。
- `web.fetch`, `web.search` — 不上網。
- `sessions_spawn`, `sessions_send` — 我是 leaf,絕不開新 agent。
- `read`, `write`, `edit` — 不碰檔案。
- `image` — 我**讀圖**(input),不**產圖**(no output drawing)。
- `cron` — 不排程。
- `pdf`, `document-extract` — 不讀文件。

## 為什麼這樣設計

「按一下,看 agent 怎麼讀畫面」是一個 demo flourish — 一次呼叫、一次回應、結束。額外工具只會拖慢延遲。模型專注、prompt 短、回應快才能撐住展場的節奏。
