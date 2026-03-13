/**
 * Netflix OpenAI Dualsub v2.8
 * Surge iOS Script (http-response)
 *
 * v2.8 變更：
 *   - callOpenAI 失敗或長度不符時，遞迴拆半重試（最小 1 條）
 *   - 完全消除「一段有翻譯一段沒字幕」問題
 *   - 修正 translateWithRetry 無限遞迴 bug（1-text chunk 失敗時會死循環）
 *   - 遞迴重試時正確縮小 chunk size（原本固定用 40，改為傳入 half）
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
  chunkSize: 40,
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

// ─── VTT — position-based insert ──────────────────────────────────────────────

async function processVTT(body) {
  body = body.replace(/\r/g, "");

  // 合併跨行字幕：用 while loop 直到沒有多行為止
  const multiLineRe = /(\d+:\d\d:\d\d[.,]\d{3} --> \d+:\d\d:\d\d[.,]\d[^\n]*\n[^\n]+)\n([^\n]+)/g;
  let prev;
  do {
    prev = body;
    body = body.replace(multiLineRe, "$1 $2");
  } while (body !== prev);

  // 抓所有 cue，記錄在 body 中的實際位置
  const dialogueRe = /(\d+:\d\d:\d\d[.,]\d{3} --> \d+:\d\d:\d\d[.,]\d[^\n]*\n)([^\n]+)/g;
  const dialogues = [];
  let m;
  while ((m = dialogueRe.exec(body)) !== null) {
    dialogues.push({
      timing:     m[1],
      text:       m[2],
      raw:        stripVTTTags(m[2]),
      matchStart: m.index,
      matchEnd:   m.index + m[0].length,
    });
  }

  if (dialogues.length === 0) return null;
  console.log("[Dualsub] VTT dialogues: " + dialogues.length);

  const translations = await translateDedup(dialogues.map(d => d.raw));

  // 建立插入點列表
  const inserts = [];
  for (let i = 0; i < dialogues.length; i++) {
    const trans = translations[i];
    if (!trans) continue;
    if (CONFIG.position === "translation_top") {
      inserts.push({ pos: dialogues[i].matchStart + dialogues[i].timing.length, text: trans + "\n" });
    } else {
      inserts.push({ pos: dialogues[i].matchEnd, text: "\n" + trans });
    }
  }

  // 從後往前插入，確保位置不偏移
  inserts.sort((a, b) => b.pos - a.pos);
  for (const ins of inserts) {
    body = body.substring(0, ins.pos) + ins.text + body.substring(ins.pos);
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
  function normalizeKey(t) {
    return t.trim().replace(/\s+/g, " ");
  }
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

  // 分 chunk 翻譯，失敗時拆半重試
  const translatedUnique = await translateWithRetry(uniqueTexts, CONFIG.chunkSize);

  // 還原順序；CC 標記直接回傳空字串
  return texts.map(t => {
    const key = normalizeKey(t);
    if (!key) return "";
    if (isCCOnly(key)) return "";
    const idx = uniqueMap[key];
    return idx !== undefined ? (translatedUnique[idx] || "") : "";
  });
}

// 遞迴拆半重試：chunk 長度不符時，分兩半分別重試，直到 chunkSize=1
async function translateWithRetry(texts, chunkSize) {
  const result = new Array(texts.length).fill("");

  async function processRange(arr, offset, size) {
    if (arr.length === 0) return;
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push({ texts: arr.slice(i, i + size), offset: offset + i });
    }
    await Promise.all(chunks.map(async c => {
      const translated = await callOpenAISingle(c.texts);
      if (translated !== null) {
        // 成功：填入結果
        for (let j = 0; j < translated.length; j++) {
          result[c.offset + j] = translated[j];
        }
      } else if (c.texts.length > 1) {
        // 失敗：拆半重試，用更小的 chunk size
        const half = Math.ceil(c.texts.length / 2);
        console.log("[Dualsub] Retry " + c.texts.length + " → " + half);
        await processRange(c.texts.slice(0, half), c.offset, half);
        await processRange(c.texts.slice(half), c.offset + half, half);
      }
      // c.texts.length === 1 還失敗就放空（罕見）
    }));
  }

  await processRange(texts, 0, chunkSize);
  return result;
}

// 回傳 string[] 或 null（長度不符/錯誤時）
function callOpenAISingle(textArray) {
  return new Promise(resolve => {
    const lines = textArray.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = `You are a subtitle translator. Each numbered line is a timed subtitle cue.\n\nReturn ONLY a JSON object: {"t": ["trans1", "trans2", ...]} with EXACTLY ${textArray.length} elements.\nArray index 0 = line 1. Never merge lines. Translate fragments as-is.\nTarget language: ${CONFIG.targetLang}\n\n${lines}`;

    $httpClient.post({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CONFIG.apiKey },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
      timeout: 28,
    }, (error, response, data) => {
      if (error || !response || response.status !== 200) {
        console.log("[Dualsub] OpenAI err: " + (error || (response && response.status)));
        resolve(null);
        return;
      }
      try {
        const content = JSON.parse(data).choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        const arr = parsed.t || parsed.translations || [];
        console.log("[Dualsub] Translated " + arr.length + "/" + textArray.length);

        if (!Array.isArray(arr) || arr.length !== textArray.length) {
          console.log("[Dualsub] Length mismatch (" + arr.length + " vs " + textArray.length + "), will retry smaller.");
          resolve(null);
          return;
        }

        resolve(arr.map(v => (typeof v === "string" ? v.trim() : "")));
      } catch (e) {
        console.log("[Dualsub] Parse err: " + e.message);
        resolve(null);
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

