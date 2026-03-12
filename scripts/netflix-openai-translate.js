/**
 * Netflix OpenAI Dualsub v2.3
 * Surge iOS Script (http-response)
 *
 * 功能：
 *   - 攔截 Netflix VTT/TTML 字幕
 *   - 用 OpenAI / Grok 翻譯成繁體中文（或指定語言）
 *   - 原文在上、譯文在下（或反過來，可設定）
 *   - $persistentStore 快取 24 小時，避免重複計費
 *
 * Module Arguments（sgmodule 設定）：
 *   ApiKey    — API Key（OpenAI: sk-... / Grok: xai-...）
 *   Provider  — openai（預設）| grok
 *   Model     — 翻譯模型，預設依 Provider 自動選
 *   Position  — original_top（原文在上）| translation_top（譯文在上）
 *   Language  — 目標語言，預設 繁體中文
 */

const PROVIDER_ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  grok:   "https://api.x.ai/v1/chat/completions",
};

// 優先從 Module Arguments ($argument) 讀取，fallback 到 $persistentStore（BoxJs）
function parseArguments() {
  const args = {};
  if (typeof $argument !== "undefined" && $argument) {
    $argument.split("&").forEach((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return;
      const k = decodeURIComponent(pair.substring(0, eqIdx).trim());
      let v = decodeURIComponent(pair.substring(eqIdx + 1).trim());
      // Strip surrounding quotes that Surge sometimes adds
      v = v.replace(/^["']|["']$/g, "");
      if (k) args[k] = v;
    });
  }
  return args;
}

const _args = parseArguments();

const _provider = (_args["Provider"] || $persistentStore.read("subtitle_provider") || "openai").toLowerCase();

const CONFIG = {
  apiKey:
    _args["ApiKey"] ||
    _args["openai_api_key"] ||
    $persistentStore.read("openai_api_key") ||
    "",
  provider: _provider,
  apiUrl: PROVIDER_ENDPOINTS[_provider] || PROVIDER_ENDPOINTS["openai"],
  model:
    _args["Model"] ||
    _args["openai_model"] ||
    $persistentStore.read("openai_model") ||
    (_provider === "grok" ? "grok-3-mini-fast" : "gpt-4o-mini"),
  position:
    _args["Position"] ||
    _args["subtitle_position"] ||
    $persistentStore.read("subtitle_position") ||
    "original_top",
  targetLang:
    _args["Language"] ||
    _args["target_language"] ||
    $persistentStore.read("target_language") ||
    "繁體中文",
  cacheExpireMs: 24 * 60 * 60 * 1000, // 24 hours
  batchSize: 15, // lines per API call — smaller = better alignment from AI
};

// ─── Entry Point ──────────────────────────────────────────────────────────────

(async () => {
  try {
    if (!CONFIG.apiKey) {
      console.log("[Netflix-Dualsub] No API key set (Provider: " + CONFIG.provider + "). Pass-through.");
      $done({});
      return;
    }

    const body = $response.body;
    const url = $request.url;

    if (!body || body.length === 0) {
      $done({});
      return;
    }

    // Cache check
    const cacheKey = "nf_sub_" + simpleHash(url);
    const cached = readCache(cacheKey);
    if (cached) {
      console.log("[Netflix-Dualsub] Cache hit.");
      $done({ body: cached });
      return;
    }

    let result;
    const contentType = ($response.headers["Content-Type"] || "").toLowerCase();

    if (body.trimStart().startsWith("WEBVTT") || url.includes(".vtt")) {
      result = await processVTT(body);
    } else if (
      body.trimStart().startsWith("<?xml") ||
      url.includes(".ttml") ||
      url.includes(".xml") ||
      url.includes(".dfxp")
    ) {
      result = await processTTML(body);
    } else {
      // Unknown format — pass through
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

function vttTimeToMs(t) {
  // "HH:MM:SS.mmm" or "MM:SS.mmm"
  const parts = t.trim().split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0]); m = parseInt(parts[1]); s = parseFloat(parts[2]);
  } else {
    m = parseInt(parts[0]); s = parseFloat(parts[1]);
  }
  return ((h * 3600 + m * 60 + s) * 1000) | 0;
}

function msToVttTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(mm).padStart(3,"0")}`;
}

// Parse timing line, preserving any trailing cue settings (align, position, etc.)
function parseTiming(timingLine) {
  // e.g. "00:00:01.000 --> 00:00:03.000 align:left"
  const match = timingLine.match(/^([\d:\.]+)\s+-->\s+([\d:\.]+)(.*)/);
  if (!match) return null;
  return {
    startMs: vttTimeToMs(match[1]),
    endMs: vttTimeToMs(match[2]),
    settings: match[3] || "",
  };
}

function buildTiming(startMs, endMs, settings) {
  return `${msToVttTime(startMs)} --> ${msToVttTime(endMs)}${settings}`;
}

// Detect Netflix paint-on: next cue is a progressive extension of this one.
// Checks BOTH timing proximity (<= 500ms gap) AND text prefix relationship.
function isPaintOnContinuation(cueA, cueB) {
  // Same start time = definitely paint-on (common Netflix pattern)
  if (cueB.parsed.startMs === cueA.parsed.startMs) return true;

  // Paint-on cues are always adjacent in time (tiny gap or overlap)
  const gap = cueB.parsed.startMs - cueA.parsed.endMs;
  if (gap > 500) return false;

  // Normalize: strip punctuation, Unicode quotes, spaces for comparison
  const norm = t => t
    .replace(/[\u2018\u2019\u201c\u201d\u2026\u2014\u2013]/g, "") // smart quotes/ellipsis/dash
    .replace(/[,\.!?\-\s'"]/g, "")
    .toLowerCase();
  const textA = norm(cueA.rawText);
  const textB = norm(cueB.rawText);
  if (!textA || !textB || textA === textB) return false;

  // textB must start with textA and be longer (more complete sentence)
  return textB.startsWith(textA) && textB.length > textA.length;
}

async function processVTT(body) {
  const lines = body.split("\n");
  const rawCues = [];
  let i = 0;

  // Parse all cues
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const parsed = parseTiming(line);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }
      if (textLines.length > 0 && parsed) {
        rawCues.push({
          parsed,
          text: textLines,
          rawText: stripVTTTags(textLines.join("\n")),
        });
      }
    } else {
      i++;
    }
  }

  if (rawCues.length === 0) return null;

  // Merge paint-on groups into single cues.
  // Each group spans from the first to the last cue, using the last cue's text
  // (most complete). This eliminates "intermediate cue with English only" entirely.
  const mergedCues = [];
  let gi = 0;
  while (gi < rawCues.length) {
    let end = gi;
    while (end + 1 < rawCues.length && isPaintOnContinuation(rawCues[end], rawCues[end + 1])) {
      end++;
    }
    mergedCues.push({
      parsed: {
        startMs: rawCues[gi].parsed.startMs,
        endMs: rawCues[end].parsed.endMs,
        settings: rawCues[end].parsed.settings,
      },
      text: rawCues[end].text,       // use the most complete (final) cue text
      rawText: rawCues[end].rawText,
    });
    gi = end + 1;
  }

  // Sort by startMs (safety: VTT should be ordered but just in case)
  mergedCues.sort((a, b) => a.parsed.startMs - b.parsed.startMs);

  // Fix overlapping end times between all consecutive cues
  for (let j = 0; j < mergedCues.length - 1; j++) {
    const nextStart = mergedCues[j + 1].parsed.startMs;
    if (mergedCues[j].parsed.endMs > nextStart) {
      mergedCues[j].parsed.endMs = Math.max(mergedCues[j].parsed.startMs + 1, nextStart);
    }
  }

  // Translate all merged cues
  const texts = mergedCues.map(c => c.rawText);
  const translations = await translateBatch(texts);

  // Rebuild VTT
  let out = "WEBVTT\n\n";
  for (let j = 0; j < mergedCues.length; j++) {
    const cue = mergedCues[j];
    const trans = translations[j] || "";
    const timing = buildTiming(cue.parsed.startMs, cue.parsed.endMs, cue.parsed.settings);
    out += timing + "\n";
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

async function translateBatch(texts) {
  const results = new Array(texts.length).fill("");
  const batches = [];

  for (let i = 0; i < texts.length; i += CONFIG.batchSize) {
    batches.push(texts.slice(i, i + CONFIG.batchSize));
  }

  let offset = 0;
  for (const batch of batches) {
    const translated = await callOpenAI(batch);
    for (let j = 0; j < translated.length; j++) {
      results[offset + j] = translated[j];
    }
    offset += batch.length;
  }

  return results;
}

function callOpenAI(textArray) {
  return new Promise((resolve) => {
    const numbered = textArray
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");

    const prompt = `你是專業字幕翻譯，將以下每行字幕翻譯成${CONFIG.targetLang}。

嚴格規則（違反將導致字幕錯位）：
- 輸出必須恰好 ${textArray.length} 行，一行不多一行不少
- 保持編號格式：1. 2. 3. ...
- 每行只輸出譯文，不加原文、不加解釋
- 如果某行是空的或無意義，就輸出原文或保留空行，但不能跳過
- 口語化、自然，符合影視字幕風格
- 專有名詞、人名保留英文
- 每行盡量簡短，不要換行

輸入共 ${textArray.length} 行 → 輸出必須也是 ${textArray.length} 行：
${numbered}`;

    $httpClient.post(
      {
        url: CONFIG.apiUrl,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + CONFIG.apiKey,
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 2048,
        }),
        timeout: 25,
      },
      (error, response, data) => {
        if (error || response.status !== 200) {
          console.log("[Netflix-Dualsub] OpenAI error: " + (error || response.status));
          resolve(new Array(textArray.length).fill(""));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices[0].message.content.trim();
          const lines = content.split("\n").map((l) =>
            l.replace(/^\d+\.\s*/, "").trim()
          );
          // Pad or trim to match input count
          while (lines.length < textArray.length) lines.push("");
          resolve(lines.slice(0, textArray.length));
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
