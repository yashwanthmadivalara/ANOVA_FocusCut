"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const he = require("he");

loadLocalEnv(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const TRANSCRIPT_CHAR_LIMIT = 16000;
const FETCH_TIMEOUT_MS = 12000;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "coral";
const TTS_CHAR_LIMIT = 4096;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    aiProvider: getConfiguredAiProvider(),
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    openaiTtsConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

app.post("/api/process", async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string" || url.length > 2048) {
    return res.status(400).json({ error: "Provide a valid YouTube URL." });
  }

  const trimmedUrl = url.trim();
  if (!isValidYouTubeUrl(trimmedUrl)) {
    return res.status(400).json({ error: "URL must be a public YouTube link." });
  }

  const videoId = extractVideoId(trimmedUrl);
  if (!videoId) {
    return res.status(400).json({ error: "Could not parse a YouTube video ID from that URL." });
  }

  try {
    const [meta, transcript] = await Promise.all([
      fetchVideoMeta(videoId),
      fetchTranscript(videoId)
    ]);

    let sourceItems = transcript;
    let sourceNotice = "Using YouTube captions as the learning source.";

    if (!sourceItems || sourceItems.length === 0) {
      sourceItems = await fetchDescriptionFallbackItems(videoId);
      sourceNotice =
        "Captions were unavailable, so FocusCut used the video description and visible chapter markers.";
    }

    if (!sourceItems || sourceItems.length === 0) {
      return res.status(422).json({
        error: "FocusCut could not extract enough learning material from this video."
      });
    }

    const learningKit = await buildLearningKit(sourceItems, meta);

    return res.json({
      sourceUrl: trimmedUrl,
      videoId,
      title: meta.title || "YouTube Video",
      author: meta.author || "",
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      transcriptLength: sourceItems.length,
      ...learningKit,
      notice: `${sourceNotice} ${learningKit.notice}`.trim()
    });
  } catch (error) {
    console.error("Process error:", error);

    return res.status(500).json({
      error: error.message || "Something went wrong while processing this video."
    });
  }
});

app.post("/api/tts", async (req, res) => {
  const { text, voice } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Provide text for narration." });
  }

  const cleanText = text.trim();
  if (!cleanText) {
    return res.status(400).json({ error: "Narration text cannot be empty." });
  }
  if (cleanText.length > TTS_CHAR_LIMIT) {
    return res.status(400).json({
      error: `Narration text must be ${TTS_CHAR_LIMIT} characters or fewer.`
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.json({
      ok: false,
      fallback: "browser",
      reason: "Using the browser voice because AI narration is not configured yet."
    });
  }

  try {
    const response = await fetchWithTimeout(
      OPENAI_TTS_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_TTS_MODEL,
          voice: sanitizeVoice(voice),
          input: cleanText,
          instructions:
            "Speak clearly, warmly, and at a measured pace for neurodivergent learners.",
          response_format: "mp3"
        })
      },
      30000
    );

    if (!response.ok) {
      const problem = await safeJson(response);
      console.error("OpenAI TTS error:", problem);
      return res.json({
        ok: false,
        fallback: "browser",
        reason: problem?.error?.message || "The AI voice service is unavailable right now."
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return res.json({
      ok: true,
      provider: "openai",
      mimeType: response.headers.get("content-type") || "audio/mpeg",
      audioBase64: audioBuffer.toString("base64")
    });
  } catch (error) {
    console.error("TTS error:", error);
    return res.json({
      ok: false,
      fallback: "browser",
      reason: "The AI voice service timed out. Using the browser voice fallback."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`FocusCut running on http://localhost:${PORT}`);
});

function isValidYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const allowed = ["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"];
    return allowed.includes(parsed.hostname);
  } catch {
    return /^[a-zA-Z0-9_-]{11}$/.test(url);
  }
}

function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

async function fetchVideoMeta(videoId) {
  try {
    const oembedUrl =
      "https://www.youtube.com/oembed?url=" +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`) +
      "&format=json";

    const response = await fetchWithTimeout(oembedUrl, {}, 8000);
    if (response.ok) {
      const data = await response.json();
      return {
        title: data.title || "",
        author: data.author_name || ""
      };
    }
  } catch {
    // Non-fatal, the UI can still render with basic defaults.
  }

  return { title: "", author: "" };
}

async function fetchTranscript(videoId) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetchWithTimeout(
      watchUrl,
      {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/s);
    if (!captionMatch) {
      return null;
    }

    let tracks;
    try {
      tracks = JSON.parse(captionMatch[1].replace(/\\u0026/g, "&"));
    } catch {
      return null;
    }

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return null;
    }

    const preferredTrack =
      tracks.find((track) => track.languageCode === "en" && !track.kind) ||
      tracks.find((track) => track.languageCode === "en") ||
      tracks[0];

    if (!preferredTrack || !preferredTrack.baseUrl) {
      return null;
    }

    const transcriptResponse = await fetchWithTimeout(preferredTrack.baseUrl, {}, 10000);
    if (!transcriptResponse.ok) {
      return null;
    }

    const xml = await transcriptResponse.text();
    const transcriptItems = [];
    const textPattern = /<text[^>]+start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let match;

    while ((match = textPattern.exec(xml)) !== null) {
      const start = Number.parseFloat(match[1]);
      const duration = Number.parseFloat(match[2]);
      const text = he.decode(match[3].replace(/<[^>]+>/g, " ").trim());

      if (!Number.isFinite(start) || !text) {
        continue;
      }

      transcriptItems.push({
        start,
        end: start + (Number.isFinite(duration) ? duration : 0),
        text: normalizeWhitespace(text)
      });
    }

    return transcriptItems.length > 0 ? transcriptItems : null;
  } catch (error) {
    console.error("Transcript fetch error:", error.message);
    return null;
  }
}

async function fetchDescriptionFallbackItems(videoId) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetchWithTimeout(
      watchUrl,
      {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const description = extractVideoDescription(html);
    if (!description) {
      return null;
    }

    const chapterItems = buildChapterItems(description);
    if (chapterItems.length >= 3) {
      return chapterItems;
    }

    return buildDescriptionItems(description);
  } catch (error) {
    console.error("Description fallback error:", error.message);
    return null;
  }
}

async function buildLearningKit(transcriptItems, meta) {
  const fallbackResult = buildFallbackLearningKit(transcriptItems, meta);

  if (process.env.GROQ_API_KEY) {
    try {
      const aiResult = await runGroqAnalysis(transcriptItems, meta);
      const normalized = normalizeAiResult(aiResult, fallbackResult);
      return {
        ...normalized,
        provider: "groq",
        notice: "Groq analysis is active for this learning kit."
      };
    } catch (error) {
      console.error("Groq analysis error:", error.message);
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const aiResult = await runAnthropicAnalysis(transcriptItems, meta);
      const normalized = normalizeAiResult(aiResult, fallbackResult);
      return {
        ...normalized,
        provider: "anthropic",
        notice: "Claude analysis is active for this learning kit."
      };
    } catch (error) {
      console.error("Anthropic analysis error:", error.message);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY) {
    return {
      ...fallbackResult,
      provider: "fallback",
      notice: "Showing transcript-powered demo content because no AI API key is configured."
    };
  }

  return {
    ...fallbackResult,
    provider: "fallback",
    notice: "The live AI provider was unavailable, so FocusCut switched to transcript-powered demo content."
  };
}

async function runAnthropicAnalysis(transcriptItems, meta) {
  const response = await fetchWithTimeout(
    ANTHROPIC_API_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2200,
        system: getAiSystemPrompt(),
        messages: [{ role: "user", content: buildAiUserPrompt(transcriptItems, meta) }]
      })
    },
    45000
  );

  const payload = await safeJson(response);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || `Anthropic request failed with status ${response.status}.`
    );
    error.status = response.status;
    throw error;
  }

  const rawText = Array.isArray(payload?.content)
    ? payload.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("")
    : "";

  return parseModelJson(rawText);
}

async function runGroqAnalysis(transcriptItems, meta) {
  const response = await fetchWithTimeout(
    GROQ_API_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 2200,
        response_format: {
          type: "json_object"
        },
        messages: [
          {
            role: "system",
            content: getAiSystemPrompt()
          },
          {
            role: "user",
            content: buildAiUserPrompt(transcriptItems, meta)
          }
        ]
      })
    },
    45000
  );

  const payload = await safeJson(response);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || `Groq request failed with status ${response.status}.`
    );
    error.status = response.status;
    throw error;
  }

  const rawText = payload?.choices?.[0]?.message?.content || "";
  return parseModelJson(rawText);
}

function buildTranscriptText(transcriptItems) {
  let lastLabel = -30;
  const lines = transcriptItems.map((item) => {
    let prefix = "";
    if (item.start - lastLabel >= 30) {
      prefix = `[${formatTime(item.start)}] `;
      lastLabel = item.start;
    }
    return `${prefix}${item.text}`;
  });

  const joined = lines.join(" ");
  if (joined.length <= TRANSCRIPT_CHAR_LIMIT) {
    return joined;
  }

  return `${joined.slice(0, TRANSCRIPT_CHAR_LIMIT)}\n[transcript truncated for length]`;
}

function getAiSystemPrompt() {
  return (
    "You are FocusCut, an AI tutor for neurodivergent learners. " +
    "Return only valid JSON with the requested structure."
  );
}

function buildAiUserPrompt(transcriptItems, meta) {
  const transcriptText = buildTranscriptText(transcriptItems);

  return `Video title: "${meta.title}"
Author: "${meta.author}"

TRANSCRIPT:
${transcriptText}

Return a JSON object with this exact shape:
{
  "summary": {
    "bullets": ["string"],
    "paragraph": "string"
  },
  "adhd": {
    "bullets": ["string"],
    "timeline": [
      { "time": "MM:SS", "title": "short title", "summary": "one sentence" }
    ]
  },
  "dyslexia": {
    "text": "string",
    "tips": ["string", "string", "string"]
  },
  "flashcards": [
    { "question": "string", "answer": "string" }
  ]
}

Rules:
- summary.bullets: 4 to 6 bullets, max 20 words each
- summary.paragraph: 2 or 3 short sentences
- adhd.bullets: 6 to 8 bullets, each starts with a verb
- adhd.timeline: at least 4 entries using actual transcript timestamps
- dyslexia.text: short plain sentences, separated by blank lines
- dyslexia.tips: exactly 3 helpful reading tips
- flashcards: 6 to 8 cards with concise answers
- Be accurate to the transcript and avoid inventing facts`;
}

function buildFallbackLearningKit(transcriptItems, meta) {
  const keyMoments = pickEvenlySpacedItems(transcriptItems, 5);
  const fallbackTimeline = keyMoments.map((item, index) => ({
    time: formatTime(item.start),
    seconds: Math.max(0, Math.floor(item.start)),
    title: buildTimelineTitle(item.text, index),
    summary: clipSentence(item.text, 18)
  }));

  const summaryBullets = keyMoments
    .slice(0, 5)
    .map((item) => clipWords(item.text, 18))
    .filter(Boolean);

  while (summaryBullets.length < 4) {
    summaryBullets.push(`Review ${meta.title || "the main lesson"} one section at a time.`);
  }

  const adhdBullets = fallbackTimeline
    .map((entry, index) => buildVerbBullet(entry.title, index))
    .slice(0, 6);

  while (adhdBullets.length < 6) {
    adhdBullets.push(buildVerbBullet(meta.title || "this topic", adhdBullets.length));
  }

  const dyslexiaLines = keyMoments
    .slice(0, 5)
    .map((item) => clipSentence(item.text, 12))
    .join("\n\n");

  const flashcards = fallbackTimeline
    .map((entry) => ({
      question: `What is covered around ${entry.time}?`,
      answer: entry.summary
    }))
    .slice(0, 6);

  while (flashcards.length < 6) {
    flashcards.push({
      question: `What is one key idea in ${meta.title || "this video"}?`,
      answer: summaryBullets[flashcards.length % summaryBullets.length]
    });
  }

  return {
    summary: {
      bullets: summaryBullets.slice(0, 6),
      paragraph: buildFallbackParagraph(meta, fallbackTimeline)
    },
    adhd: {
      bullets: adhdBullets,
      timeline: fallbackTimeline
    },
    dyslexia: {
      text:
        dyslexiaLines ||
        "Watch one short section at a time.\n\nPause after each idea.\n\nSay the main point out loud.",
      tips: buildFallbackTips(fallbackTimeline)
    },
    flashcards
  };
}

function normalizeAiResult(aiResult, fallbackResult) {
  return {
    summary: {
      bullets: normalizeList(aiResult?.summary?.bullets, fallbackResult.summary.bullets, {
        min: 4,
        max: 6,
        formatter: (item) => clipWords(item, 20)
      }),
      paragraph: clipParagraph(
        cleanString(aiResult?.summary?.paragraph) || fallbackResult.summary.paragraph,
        60
      )
    },
    adhd: {
      bullets: normalizeList(aiResult?.adhd?.bullets, fallbackResult.adhd.bullets, {
        min: 6,
        max: 8,
        formatter: (item, index) => enforceVerbBullet(item, index)
      }),
      timeline: normalizeTimeline(aiResult?.adhd?.timeline, fallbackResult.adhd.timeline)
    },
    dyslexia: {
      text: normalizeDyslexiaText(aiResult?.dyslexia?.text, fallbackResult.dyslexia.text),
      tips: normalizeList(aiResult?.dyslexia?.tips, fallbackResult.dyslexia.tips, {
        min: 3,
        max: 3,
        formatter: (item) => clipSentence(item, 14)
      })
    },
    flashcards: normalizeFlashcards(aiResult?.flashcards, fallbackResult.flashcards)
  };
}

function normalizeTimeline(aiTimeline, fallbackTimeline) {
  const source = Array.isArray(aiTimeline) && aiTimeline.length > 0 ? aiTimeline : fallbackTimeline;
  const normalized = source
    .map((entry, index) => {
      const fallbackEntry = fallbackTimeline[index % fallbackTimeline.length];
      const parsedSeconds = parseTimestamp(entry?.time);
      const seconds =
        Number.isFinite(parsedSeconds) && parsedSeconds >= 0
          ? parsedSeconds
          : fallbackEntry.seconds;

      return {
        time: formatTime(seconds),
        seconds,
        title: clipWords(cleanString(entry?.title) || fallbackEntry.title, 6),
        summary: clipSentence(cleanString(entry?.summary) || fallbackEntry.summary, 18)
      };
    })
    .filter((entry) => entry.title && entry.summary)
    .slice(0, 6);

  return normalized.length >= 4 ? normalized : fallbackTimeline;
}

function normalizeFlashcards(aiFlashcards, fallbackFlashcards) {
  const source =
    Array.isArray(aiFlashcards) && aiFlashcards.length > 0 ? aiFlashcards : fallbackFlashcards;

  const normalized = source
    .map((card, index) => ({
      question: clipSentence(cleanString(card?.question) || fallbackFlashcards[index % fallbackFlashcards.length].question, 18),
      answer: clipSentence(cleanString(card?.answer) || fallbackFlashcards[index % fallbackFlashcards.length].answer, 22)
    }))
    .filter((card) => card.question && card.answer)
    .slice(0, 8);

  return normalized.length >= 6 ? normalized : fallbackFlashcards;
}

function normalizeDyslexiaText(value, fallbackText) {
  const text = cleanString(value);
  if (!text) {
    return fallbackText;
  }

  const paragraphs = text
    .split(/\n+/)
    .map((line) => clipSentence(line, 12))
    .filter(Boolean);

  return paragraphs.length > 0 ? paragraphs.join("\n\n") : fallbackText;
}

function normalizeList(value, fallbackList, options) {
  const source = Array.isArray(value) ? value : [];
  const formatted = source
    .map((item, index) => options.formatter(cleanString(item), index))
    .filter(Boolean)
    .slice(0, options.max);

  if (formatted.length >= options.min) {
    return formatted;
  }

  return fallbackList.slice(0, options.max);
}

function pickEvenlySpacedItems(items, count) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  if (items.length <= count) {
    return items;
  }

  const picks = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const itemIndex = Math.min(items.length - 1, Math.round(ratio * (items.length - 1)));
    picks.push(items[itemIndex]);
  }

  return picks;
}

function extractVideoDescription(html) {
  const match = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (!match) {
    return "";
  }

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return "";
  }
}

function buildChapterItems(description) {
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/https?:\/\/\S+/g, "")))
    .filter(Boolean);

  const chapters = lines
    .map((line) => {
      const match =
        line.match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(.+)/) ||
        line.match(/^(\d{1,2}):(\d{2})\s+(.+)/);

      if (!match) {
        return null;
      }

      if (match.length === 5) {
        return {
          seconds:
            Number.parseInt(match[1], 10) * 3600 +
            Number.parseInt(match[2], 10) * 60 +
            Number.parseInt(match[3], 10),
          text: match[4]
        };
      }

      return {
        seconds: Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10),
        text: match[3]
      };
    })
    .filter(Boolean);

  return chapters.map((chapter, index) => ({
    start: chapter.seconds,
    end: chapters[index + 1] ? chapters[index + 1].seconds : chapter.seconds + 75,
    text: normalizeSourceText(chapter.text)
  }));
}

function buildDescriptionItems(description) {
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/https?:\/\/\S+/g, "")))
    .filter((line) => line && !/^(subscribe|follow|listen|watch more)/i.test(line))
    .slice(0, 8);

  if (lines.length === 0) {
    return null;
  }

  return lines.map((line, index) => ({
    start: index * 75,
    end: (index + 1) * 75,
    text: normalizeSourceText(line)
  }));
}

function buildTimelineTitle(text, index) {
  const fallbackTitles = ["Open the topic", "Clarify the setup", "Explain the process", "Work the example", "Wrap the lesson"];
  const words = cleanString(text)
    .split(" ")
    .filter(Boolean)
    .slice(0, 5);

  return words.length > 0 ? toTitleCase(words.join(" ")) : fallbackTitles[index % fallbackTitles.length];
}

function buildFallbackParagraph(meta, timeline) {
  const title = meta.title || "this tutorial";
  const segments = timeline
    .slice(0, 3)
    .map((entry) => `${entry.time} focuses on ${entry.title.toLowerCase()}.`)
    .join(" ");

  return `FocusCut broke ${title} into shorter learning beats. ${segments}`.trim();
}

function buildFallbackTips(timeline) {
  const first = timeline[0] ? timeline[0].time : "00:00";
  const second = timeline[1] ? timeline[1].time : first;

  return [
    `Pause after ${first} and repeat the idea in your own words.`,
    `Read one timeline block at a time before jumping ahead.`,
    `Replay ${second} if a new term feels dense or unfamiliar.`
  ];
}

function buildVerbBullet(title, index) {
  const verbs = ["Learn", "Notice", "Apply", "Track", "Review", "Connect", "Practice", "Explain"];
  const cleanTitle = cleanString(title).toLowerCase();
  return `${verbs[index % verbs.length]} ${cleanTitle || "the next idea"}.`;
}

function enforceVerbBullet(text, index) {
  const clean = clipWords(text, 12);
  if (!clean) {
    return buildVerbBullet("the main idea", index);
  }

  const firstWord = clean.split(" ")[0].toLowerCase();
  const commonVerbs = ["learn", "notice", "apply", "track", "review", "connect", "practice", "explain", "remember", "spot"];
  if (commonVerbs.includes(firstWord)) {
    return clean;
  }

  return buildVerbBullet(clean, index);
}

function parseTimestamp(value) {
  if (typeof value !== "string") {
    return Number.NaN;
  }

  const parts = value
    .trim()
    .split(":")
    .map((part) => Number.parseInt(part, 10));

  if (parts.some((part) => Number.isNaN(part))) {
    return Number.NaN;
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return Number.NaN;
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function cleanString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeWhitespace(value.replace(/\s+/g, " ")).trim();
}

function normalizeSourceText(value) {
  return cleanString(value).replace(/^[-*:\s]+/, "");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipWords(text, maxWords) {
  const words = cleanString(text).split(" ").filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const clipped = words.slice(0, maxWords).join(" ");
  return ensureSentence(clipped);
}

function clipSentence(text, maxWords) {
  return clipWords(text, maxWords);
}

function clipParagraph(text, maxWords) {
  const words = cleanString(text).split(" ").filter(Boolean);
  if (words.length <= maxWords) {
    return ensureSentence(words.join(" "));
  }
  return ensureSentence(words.slice(0, maxWords).join(" "));
}

function ensureSentence(text) {
  const clean = cleanString(text);
  if (!clean) {
    return "";
  }

  if (/[.!?]$/.test(clean)) {
    return clean;
  }

  return `${clean}.`;
}

function toTitleCase(text) {
  return cleanString(text)
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function sanitizeVoice(value) {
  const allowed = new Set([
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar"
  ]);

  return allowed.has(value) ? value : DEFAULT_TTS_VOICE;
}

function parseModelJson(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("The AI provider returned invalid JSON.");
  }
}

function getConfiguredAiProvider() {
  if (process.env.GROQ_API_KEY) {
    return "groq";
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  return "fallback";
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...options, signal });
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
