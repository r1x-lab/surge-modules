/**
 * Netflix OpenAI Dualsub v2.1
 * Surge iOS Script (http-response)
 *
 * 核心策略（參考 Neurogram-R）：
 *   - 不重建 VTT，直接 regex 在原始 body 插入譯文
 *   - 去重翻譯，平行分組送 OpenAI
 *   - $persistentStore 快取（內容 hash）
 *
 * v2.1 變更：
 *   - 拆行合併改 while loop，正確處理 3+ 行字幕
 *   - 純 CC 標記（[MUSIC] / [APPLAUSE] 等）不送翻譯，直接保留原文
 *   - 去重 key normalize（trim + 壓縮空白），避免空白差異造成重複翻譯
 */

// ─── Config ───────────────────────────────────────────────────────────────────

function parseArguments() {
  const args = {};
  if (typeof $argument !== "undefined" && $argument) {
    $argument.split("&").forEach((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return;
      const k = decodeURIComponent(pair.substring(0, eqIdx).trim());
      let v = decodeURIComponent(pair.substring(eqIdx + 1).trim());
      v = v.replace(/^[\"']|[\"']$/g, "");
      if (k) args[k] = v;
    });
  }
  console.log("[Dualsub] Args: " + JSON.stringify(Object.keys(args)) + " | Key: " + (args["ApiKey"] || "").substring(0, 8));
  return args;
}

const _args = parseArguments();
const CONFIG = {
  apiKey:    _args["ApiKey"]    || $persistentStore.read("openai_api_key") || "",
  model:     _args["Model"]     || $persistentStore.read("openai_model")   || "gpt-4o-mini",
  position:  _args["Position"]  || $persistentStore.read("subtitle_position") || "original_top",
  targetLang:_args["Language"]  || $persistentStore.read("target_language")   || "繁體中文",
  cacheMs:   24 * 60 * 60 * 1000,
  chunkSize: 80,
  maxUnique: 400,
};

// 純 CC 標記 regex：整行只有 [xxx] 的，不含音符歌詞
const CC_ONLY_RE = /^\s*\[([^\]]+)\]\s*$/;

// ─── Entry ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (!CONFIG.apiKey) {
      console.log("[Dualsub] No API key, pass-through.");
      $done({});
      return;
    }

    let body = $response.body;
    if (!body || body.length === 0) { $done({}); return; }

    // Skip binary (video segments)
    const firstChar = body.charCodeAt(0);
    if (firstChar < 9) { $done({}); return; }

    const isVTT  = body.trimStart().startsWith("WEBVTT") ||
                   /^\d+\s*\r?\n\d{2}:\d{2}/.test(body.trimStart()) ||
                   /^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(body.trimStart());
    const isTTML = body.trimStart().startsWith("<?xml") || body.trimStart().startsWith("<tt");

    if (!isVTT && !isTTML) { $done({}); return; }

    // Cache by content hash
    const cacheKey = "nfsub2_" + simpleHash(body.substring(0, 512));
    const cached = readCache(cacheKey);
    if (cached) {
      console.log("[Dualsub] Cache hit.");
      $done({ body: cached });
      return;
    }

    let result;
    if (isVTT)  result = await processVTT(body);
    if (isTTML) result = await processTTML(body);

    if (result) {
      writeCache(cacheKey, result);
      $done({ body: result });
    } else {
      $done({});
    }
  } catch (e) {
    console.log("[Dualsub] Error: " + e.message);
    $done({});
  }
})();

// ─── VTT — regex insert (Neurogram style) ─────────────────────────────────────

async function processVTT(body) {
  body = body.replace(/\r/g, "");

  // 合併跨行字幕：用 while loop 直到沒有多行為止
  const multiLineRe = /(\d+:\d\d:\d\d[.,]\d{3} --> \d+:\d\d:\d\d[.,]\d[^\n]*\n[^\n]+)\n([^\n]+)/g;
  let prev;
  do {
    prev = body;
    body = body.replace(multiLineRe, "$1 $2");
  } while (body !== prev);

  // 抓所有 timeline（含字幕文字）
  const dialogueRe = /(\d+:\d\d:\d\d[.,]\d{3} --> \d+:\d\d:\d\d[.,]\d[^\n]*\n)([^\n]+)/g;
  const dialogues = [];
  let m;
  while ((m = dialogueRe.exec(body)) !== null) {
    dialogues.push({ timing: m[1], text: m[2], raw: stripVTTTags(m[2]) });
  }

  if (dialogues.length === 0) return null;
  console.log("[Dualsub] VTT dialogues: " + dialogues.length);

  // 去重翻譯（CC 標記直接給空字串，不送 OpenAI）
  const translations = await translateDedup(dialogues.map(d => d.raw));

  // 插入譯文（不重建，直接 replace）
  for (let i = 0; i < dialogues.length; i++) {
    const trans = translations[i];
    if (!trans) continue;
    const original = dialogues[i].timing + dialogues[i].text;
    let replacement;
    if (CONFIG.position === "translation_top") {
      replacement = dialogues[i].timing + trans + "\n" + dialogues[i].text;
    } else {
      replacement = original + "\n" + trans;
    }
    body = body.replace(original, replacement);
  }

  return body;
}

// ─── TTML ─────────────────────────────────────────────────────────────────────

async function processTTML(body) {
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  const matches = [];
  let m;
  while ((m = pRegex.exec(body)) !== null) {
    matches.push({ full: m[0], attrs: m[1], inner: m[2], raw: stripXMLTags(m[2]).trim() });
  }
  if (matches.length === 0) return null;

  const translations = await translateDedup(matches.map(p => p.raw));

  let result = body;
  for (let i = 0; i < matches.length; i++) {
    const trans = translations[i];
    if (!trans) continue;
    const newInner = CONFIG.position === "translation_top"
      ? trans + "<br />" + matches[i].inner
      : matches[i].inner + "<br />" + trans;
    result = result.replace(matches[i].full, `<p${matches[i].attrs}>${newInner}</p>`);
  }
  return result;
}

// ─── Translation ──────────────────────────────────────────────────────────────

async function translateDedup(texts) {
  // normalize key：trim + 壓縮連續空白，避免空白差異造成重複翻譯
  function normalizeKey(t) {
    return t.trim().replace(/\s+/g, " ");
  }

  // CC 標記判斷：整行只有 [xxx]，直接跳過翻譯
  function isCCOnly(t) {
    return CC_ONLY_RE.test(t);
  }

  const uniqueMap = {};
  const uniqueTexts = [];
  texts.forEach(t => {
    const key = normalizeKey(t);
    if (key && !isCCOnly(key) && !uniqueMap.hasOwnProperty(key)) {
      uniqueMap[key] = uniqueTexts.length;
      uniqueTexts.push(key);
    }
  });

  console.log("[Dualsub] Total: " + texts.length + " | Unique (non-CC): " + uniqueTexts.length);

  if (uniqueTexts.length === 0) return new Array(texts.length).fill("");
  if (uniqueTexts.length > CONFIG.maxUnique) {
    console.log("[Dualsub] Too many cues, pass-through.");
    return new Array(texts.length).fill("");
  }

  // 分 chunk 平行翻譯
  const chunks = [];
  for (let i = 0; i < uniqueTexts.length; i += CONFIG.chunkSize) {
    chunks.push(uniqueTexts.slice(i, i + CONFIG.chunkSize));
  }
  console.log("[Dualsub] " + chunks.length + " chunks x ~" + CONFIG.chunkSize);

  const chunkResults = await Promise.all(chunks.map(c => callOpenAI(c)));
  const translatedUnique = [].concat(...chunkResults);

  // 還原順序；CC 標記直接回傳空字串（不顯示）
  return texts.map(t => {
    const key = normalizeKey(t);
    if (!key) return "";
    if (isCCOnly(key)) return "";  // 純 CC 標記不顯示翻譯
    const idx = uniqueMap[key];
    return idx !== undefined ? (translatedUnique[idx] || "") : "";
  });
}

function callOpenAI(textArray) {
  return new Promise(resolve => {
    const numbered = textArray.map((t, i) => `${i + 1}|${t}`).join("\n");
    const prompt = `Translate each subtitle line to ${CONFIG.targetLang}. Output ONLY "N|translation" format, same count as input (${textArray.length} lines). Natural subtitle style, keep proper nouns in English.\n\n${numbered}`;

    $httpClient.post({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CONFIG.apiKey },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      timeout: 28,
    }, (error, response, data) => {
      if (error || !response || response.status !== 200) {
        console.log("[Dualsub] OpenAI err: " + (error || (response && response.status)));
        resolve(new Array(textArray.length).fill(""));
        return;
      }
      try {
        const content = JSON.parse(data).choices[0].message.content.trim();
        const map = {};
        content.split("\n").forEach(line => {
          const sep = line.indexOf("|");
          if (sep > 0) {
            const idx = parseInt(line.substring(0, sep), 10) - 1;
            const val = line.substring(sep + 1).trim();
            if (!isNaN(idx) && val) map[idx] = val;
          }
        });
        const out = textArray.map((_, i) => map[i] || "");
        console.log("[Dualsub] Translated " + Object.keys(map).length + "/" + textArray.length);
        resolve(out);
      } catch (e) {
        console.log("[Dualsub] Parse err: " + e.message);
        resolve(new Array(textArray.length).fill(""));
      }
    });
  });
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readCache(key) {
  try {
    const raw = $persistentStore.read(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CONFIG.cacheMs) { $persistentStore.write(null, key); return null; }
    return obj.data;
  } catch (e) { return null; }
}

function writeCache(key, data) {
  try { $persistentStore.write(JSON.stringify({ ts: Date.now(), data }), key); }
  catch (e) { console.log("[Dualsub] Cache err: " + e.message); }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function stripVTTTags(text) {
  return text.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}
function stripXMLTags(text) {
  return text.replace(/<br\s*\/?>/gi," ").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#160;/g," ").trim();
}
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 128); i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}
