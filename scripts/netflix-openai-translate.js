/**
 * Netflix OpenAI Dualsub
 * Surge iOS Script (http-response)
 *
 * 功能：
 *   - 攔截 Netflix VTT/TTML 字幕
 *   - 用 OpenAI GPT 翻譯成繁體中文
 *   - 原文在上、譯文在下（或反過來，可設定）
 *   - $persistentStore 快取 24 小時，避免 20 分鐘失效
 *
 * BoxJs 設定 key（需安裝 BoxJs）：
 *   openai_api_key     — OpenAI API Key（必填）
 *   openai_model       — 模型，預設 gpt-4o-mini
 *   subtitle_position  — "original_top"（原文在上）| "translation_top"（譯文在上），預設 original_top
 *   target_language    — 目標語言，預設 ZH-HANT（繁體中文）
 */

// 優先從 Module Arguments ($argument) 讀取，fallback 到 $persistentStore（BoxJs）
function parseArguments() {
  const args = {};
  if (typeof $argument !== "undefined" && $argument) {
    $argument.split("&").forEach((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return;
      const k = decodeURIComponent(pair.substring(0, eqIdx).trim());
      let v = decodeURIComponent(pair.substring(eqIdx + 1).trim());
      // 去掉 Surge 傳入時可能帶的前後引號
      v = v.replace(/^["']|["']$/g, "");
      if (k) args[k] = v;
    });
  }
  console.log("[Netflix-Dualsub] Arguments parsed: " + JSON.stringify(Object.keys(args)));
  console.log("[Netflix-Dualsub] ApiKey prefix: " + (args["ApiKey"] || "").substring(0, 8));
  return args;
}

const _args = parseArguments();

const CONFIG = {
  apiKey:
    _args["ApiKey"] ||
    $persistentStore.read("openai_api_key") ||
    "",
  model:
    _args["Model"] ||
    $persistentStore.read("openai_model") ||
    "gpt-4o-mini",
  position:
    _args["Position"] ||
    $persistentStore.read("subtitle_position") ||
    "original_top",
  targetLang:
    _args["Language"] ||
    $persistentStore.read("target_language") ||
    "繁體中文",
  cacheExpireMs: 24 * 60 * 60 * 1000, // 24 hours
  batchSize: 30, // lines per API call
};

// ─── Entry Point ──────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log("[Netflix-Dualsub] Script triggered. URL: " + $request.url.substring(0, 80));

    if (!CONFIG.apiKey) {
      console.log("[Netflix-Dualsub] No OpenAI API key set. Pass-through.");
      $done({});
      return;
    }

    const body = $response.body;
    const url = $request.url;
    const status = $response.status;
    console.log("[Netflix-Dualsub] Status: " + status + " | Body length: " + (body ? body.length : "null"));

    if (!body || body.length === 0) {
      console.log("[Netflix-Dualsub] Empty body, pass-through.");
      $done({});
      return;
    }

    // Cache check — 用內容 hash 而非 URL（URL 每次不同但字幕內容一樣）
    const cacheKey = "nf_sub_" + simpleHash(body.substring(0, 512));
    const cached = readCache(cacheKey);
    if (cached) {
      console.log("[Netflix-Dualsub] Cache hit.");
      $done({ body: cached });
      return;
    }

    const contentType = ($response.headers["Content-Type"] || $response.headers["content-type"] || "").toLowerCase();
    const bodyStart = body.trimStart().substring(0, 50);
    console.log("[Netflix-Dualsub] Content-Type: " + contentType + " | Body start: " + bodyStart);

    let result;

    if (body.trimStart().startsWith("WEBVTT") || contentType.includes("vtt") || contentType.includes("text/vtt")) {
      console.log("[Netflix-Dualsub] Format: VTT");
      result = await processVTT(body);
    } else if (
      body.trimStart().startsWith("<?xml") ||
      body.trimStart().startsWith("<tt") ||
      contentType.includes("ttml") ||
      contentType.includes("xml") ||
      contentType.includes("dfxp")
    ) {
      console.log("[Netflix-Dualsub] Format: TTML/XML");
      result = await processTTML(body);
    } else {
      // Unknown format — log and pass through
      console.log("[Netflix-Dualsub] Unknown format, pass-through. Length: " + body.length);
      $done({});
      return;
    }

    if (result) {
      writeCache(cacheKey, result);
      $done({ body: result });
    } else {
      $done({});
    }
  } catch (e) {
    console.log("[Netflix-Dualsub] Error: " + e.message);
    $done({});
  }
})();

// ─── VTT Processing ───────────────────────────────────────────────────────────

async function processVTT(body) {
  const lines = body.split("\n");
  const cues = []; // { index, start, end, text: [lines] }
  let i = 0;

  // Parse
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const timeParts = line.split("-->").map((s) => s.trim());
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }
      if (textLines.length > 0) {
        cues.push({
          timing: line,
          text: textLines,
          rawText: stripVTTTags(textLines.join("\n")),
        });
      }
    } else {
      i++;
    }
  }

  if (cues.length === 0) return null;

  // Translate in batches
  const allTexts = cues.map((c) => c.rawText);
  const translations = await translateBatch(allTexts);

  // Rebuild VTT
  let out = "WEBVTT\n\n";
  for (let j = 0; j < cues.length; j++) {
    const cue = cues[j];
    const trans = translations[j] || "";
    out += cue.timing + "\n";
    if (CONFIG.position === "translation_top") {
      if (trans) out += trans + "\n";
      out += cue.text.join("\n") + "\n";
    } else {
      out += cue.text.join("\n") + "\n";
      if (trans) out += trans + "\n";
    }
    out += "\n";
  }
  return out;
}

// ─── TTML Processing ──────────────────────────────────────────────────────────

async function processTTML(body) {
  // Extract all <p> text content
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  const matches = [];
  let m;
  while ((m = pRegex.exec(body)) !== null) {
    matches.push({
      full: m[0],
      attrs: m[1],
      inner: m[2],
      rawText: stripXMLTags(m[2]).trim(),
    });
  }

  if (matches.length === 0) return null;

  const allTexts = matches.map((p) => p.rawText).filter(Boolean);
  const translations = await translateBatch(allTexts);

  let result = body;
  let tIdx = 0;
  for (const match of matches) {
    if (!match.rawText) continue;
    const trans = translations[tIdx++] || "";
    if (!trans) continue;

    let newInner;
    if (CONFIG.position === "translation_top") {
      newInner = trans + '<br />' + match.inner;
    } else {
      newInner = match.inner + '<br />' + trans;
    }
    result = result.replace(match.full, `<p${match.attrs}>${newInner}</p>`);
  }
  return result;
}

// ─── OpenAI Translation ───────────────────────────────────────────────────────

// 去重翻譯：相同原文只翻一次，大幅減少 token 數與 API 呼叫次數
async function translateBatch(texts) {
  // 建立唯一文字 map
  const uniqueMap = {};
  const uniqueTexts = [];
  texts.forEach((t) => {
    if (t && !uniqueMap.hasOwnProperty(t)) {
      uniqueMap[t] = uniqueTexts.length;
      uniqueTexts.push(t);
    }
  });

  console.log("[Netflix-Dualsub] Total cues: " + texts.length + " | Unique: " + uniqueTexts.length);

  if (uniqueTexts.length === 0) return new Array(texts.length).fill("");

  // 一次送完（gpt-4o-mini 上限夠用）
  const translated = await callOpenAI(uniqueTexts);

  // 還原回原始順序
  return texts.map((t) => {
    if (!t) return "";
    const idx = uniqueMap[t];
    return translated[idx] || "";
  });
}

function callOpenAI(textArray) {
  return new Promise((resolve) => {
    const numbered = textArray.map((t, i) => `${i + 1}|${t}`).join("\n");

    const prompt = `Translate each subtitle line to ${CONFIG.targetLang}. Rules:
- Output ONLY the translation, one line per input, same numbering format "N|translation"
- Natural, colloquial subtitle style
- Keep proper nouns and names in English
- Total input: ${textArray.length} lines → output exactly ${textArray.length} lines

Input:
${numbered}`;

    $httpClient.post(
      {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + CONFIG.apiKey,
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 4096,
        }),
        timeout: 28,
      },
      (error, response, data) => {
        if (error || (response && response.status !== 200)) {
          console.log("[Netflix-Dualsub] OpenAI error: " + (error || (response && response.status)));
          resolve(new Array(textArray.length).fill(""));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices[0].message.content.trim();
          const resultMap = {};
          content.split("\n").forEach((line) => {
            const sep = line.indexOf("|");
            if (sep > 0) {
              const idx = parseInt(line.substring(0, sep), 10) - 1;
              const val = line.substring(sep + 1).trim();
              if (!isNaN(idx) && val) resultMap[idx] = val;
            }
          });
          const out = textArray.map((_, i) => resultMap[i] || "");
          console.log("[Netflix-Dualsub] Translated " + Object.keys(resultMap).length + "/" + textArray.length);
          resolve(out);
        } catch (e) {
          console.log("[Netflix-Dualsub] Parse error: " + e.message);
          resolve(new Array(textArray.length).fill(""));
        }
      }
    );
  });
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────

function readCache(key) {
  try {
    const raw = $persistentStore.read(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CONFIG.cacheExpireMs) {
      $persistentStore.write(null, key);
      return null;
    }
    return obj.data;
  } catch (e) {
    return null;
  }
}

function writeCache(key, data) {
  try {
    $persistentStore.write(JSON.stringify({ ts: Date.now(), data }), key);
  } catch (e) {
    console.log("[Netflix-Dualsub] Cache write error: " + e.message);
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function stripVTTTags(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function stripXMLTags(text) {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;/g, " ")
    .trim();
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 128); i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}
