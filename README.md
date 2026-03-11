# Netflix OpenAI Dualsub — Surge iOS Module

Netflix 雙語字幕，用 OpenAI GPT 翻譯（繁體中文），快取 24 小時。

## 安裝方式

### 1. 安裝 Module

Surge → Module → 安裝外部模組，貼上：

```
https://raw.githubusercontent.com/<你的repo>/main/Netflix-OpenAI-Dualsub.sgmodule
```

### 2. MITM 設定

Module 會自動加入，只需確認 MITM hostname 有這一行：

```
*.oca.nflxvideo.net
```

**不要加其他 Netflix domain**，否則會轉圈圈。

### 3. 設定 OpenAI API Key

用 BoxJs（推薦）或直接在 Surge Script 環境變數設定：

| Key | 說明 | 預設值 |
|-----|------|--------|
| `openai_api_key` | OpenAI API Key（**必填**） | — |
| `openai_model` | 模型 | `gpt-4o-mini` |
| `subtitle_position` | `original_top` / `translation_top` | `original_top` |
| `target_language` | 目標語言描述 | `繁體中文` |

### 4. BoxJs 設定（可選）

BoxJs App → 搜尋 "Netflix Dualsub" → 填入上方 key。

不用 BoxJs 也可以直接用 `$persistentStore.write()` 在 Surge Script 裡手動寫入：

```javascript
// 在 Surge Script console 執行一次
$persistentStore.write("sk-xxxxxxxx", "openai_api_key");
```

## 運作原理

```
Netflix App → *.oca.nflxvideo.net（字幕 VTT/TTML）
                    ↓ MITM 攔截
              Surge 執行 Script
                    ↓
              快取檢查（24h）
                    ↓ miss
              OpenAI API 翻譯（批次 30 行）
                    ↓
              原文 + 譯文合併 → 回傳
```

## 費用估算

- `gpt-4o-mini`：約 $0.0002 / 集（一集 ~400 字幕行）
- 快取命中 → 免費

## 與其他方案比較

| | Neurogram-R | DualSubs | 本 Module |
|---|---|---|---|
| 最後更新 | 2022 | 2025-2026 | 2026 |
| 快取 | ❌ | ✅ | ✅ (24h) |
| 翻譯品質 | 普通 | Google/DeepL | GPT-4o-mini |
| MITM 精準度 | ✅ | ✅ | ✅ |
| BoxJs 支援 | ❌ | ✅ | ✅ |
| 需要 API Key | ❌ | ❌ | ✅ (OpenAI) |
