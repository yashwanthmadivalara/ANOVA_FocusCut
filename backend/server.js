const express = require("express");
const path = require("path");
const multer = require("multer");

const app = express();
let youtubeTranscriptModule;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const token = process.env.HF_TOKEN;
  const model = process.env.HF_ASR_MODEL || "openai/whisper-large-v3";

  if (!token) {
    return res.status(500).json({ error: "HF_TOKEN is not set on the server." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Upload an audio file." });
  }

  try {
    const result = await transcribeWithHuggingFace({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      token,
      model
    });
    return res.json(result);
  } catch (error) {
    return res.status(502).json({
      error: "Transcription failed.",
      details: describeError(error)
    });
  }
});

app.post("/api/process", async (req, res) => {
  const body = req.body || {};
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const transcriptInput = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const allowDemoFallback = body.allowDemoFallback !== false;

  if (!url && !transcriptInput) {
    return res.status(400).json({ error: "Provide a YouTube URL or a transcript." });
  }

  const chunkSize = clampNumber(body.chunkSize, 2, 1, 5);
  const maxFlashcards = clampNumber(body.maxFlashcards, 6, 3, 12);
  const warnings = [];
  let transcript = transcriptInput;
  let source = transcriptInput ? "provided" : "";
  let transcriptSegments = null;
  let transcriptSegmentsData = null;

  if (!transcript && url) {
    try {
      const fetched = await fetchTranscriptFromYoutube(url);
      transcript = fetched.transcript;
      transcriptSegmentsData = fetched.segments;
      transcriptSegments = fetched.segmentCount;
      source = "youtube";
    } catch (error) {
      if (!allowDemoFallback) {
        return res.status(422).json({
          error: "Unable to fetch a YouTube transcript.",
          details: describeError(error)
        });
      }

      warnings.push(`Transcript fetch failed, using demo text. ${describeError(error)}`);
      transcript = buildDemoTranscript();
      source = "demo-fallback";
    }
  }

  if (!transcript) {
    return res.status(400).json({ error: "Transcript is empty." });
  }

  const data = buildOutput({
    url,
    transcript,
    chunkSize,
    maxFlashcards,
    source,
    warnings,
    transcriptSegments,
    transcriptSegmentsData
  });

  return res.json(data);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`FocusCut running on http://localhost:${port}`);
});

function buildOutput({
  url,
  transcript,
  chunkSize,
  maxFlashcards,
  source,
  warnings,
  transcriptSegments,
  transcriptSegmentsData
}) {
  const normalizedTranscript = normalizeText(transcript);
  const sentences = splitSentences(normalizedTranscript);
  const chunks = chunkArray(sentences, chunkSize);

  const timeline = buildTimeline(chunks, { segments: transcriptSegmentsData, chunkSize });
  const summary = buildSummary(sentences);
  const adhd = buildADHD(chunks, { segments: transcriptSegmentsData, chunkSize });
  const dyslexia = buildDyslexia(sentences);
  const flashcards = buildFlashcards(sentences, maxFlashcards);

  return {
    sourceUrl: url || "Transcript provided",
    title: "FocusCut demo output",
    meta: {
      source,
      videoId: url ? extractVideoId(url) : null,
      transcriptSegments
    },
    stats: {
      transcriptLength: normalizedTranscript.length,
      sentenceCount: sentences.length,
      wordCount: countWords(normalizedTranscript),
      segments: timeline.length
    },
    summary,
    adhd,
    dyslexia,
    flashcards,
    notice:
      source === "youtube"
        ? "Transcript fetched from YouTube captions."
        : source === "provided"
          ? "Transcript provided. Processing ran locally in the demo backend."
          : "Demo transcript used. Swap in Whisper or Vosk for local transcription.",
    warnings: warnings || []
  };
}

function buildDemoTranscript() {
  return [
    "This video shows how to learn faster by breaking long content into small chunks.",
    "First, extract a transcript and highlight the ideas that matter most.",
    "Next, generate a timeline so learners can jump to topics without scrolling.",
    "Then create ADHD friendly bullets with strong verbs and short phrases.",
    "For dyslexia mode, simplify sentences and add more spacing for comfort.",
    "Finally, turn key points into flashcards that support active recall.",
    "All processing can run on device with Whisper or Vosk to protect privacy.",
    "No video data needs to leave the learner's computer during the demo."
  ].join(" ");
}

function buildSummary(sentences) {
  if (!sentences.length) {
    return { bullets: [], paragraph: "" };
  }

  const cleaned = sentences.map(cleanSentence).filter(isSummaryCandidate);
  const fallback = sentences.map(cleanSentence).filter(Boolean);
  const pool = cleaned.length ? cleaned : fallback;
  const unique = uniqueSentences(pool);

  const scored = unique
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreSentence(sentence)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = scored.length
    ? scored.slice(0, 3).sort((a, b) => a.index - b.index)
    : unique.slice(0, 3).map((sentence, index) => ({ sentence, index }));

  const bullets = selected.map((item) => toSummaryBullet(item.sentence)).filter(Boolean);
  const paragraph = trimToWordLimit(selected.map((item) => item.sentence).join(" "), 45);
  return { bullets, paragraph };
}

function buildADHD(chunks, options = {}) {
  const bullets = chunks.map((chunk) => toBullet(chunk[0]));
  const timeline = buildTimeline(chunks, options);
  return { bullets, timeline };
}

function buildDyslexia(sentences) {
  const cleaned = sentences.map(cleanSentence).filter(isDyslexiaCandidate);
  const fallback = sentences.map(cleanSentence).filter(Boolean);
  const pool = cleaned.length ? cleaned : fallback;
  const simplified = pool
    .slice(0, 6)
    .map((sentence) => simplifySentence(sentence, 12))
    .filter((sentence) => countWords(sentence) >= 4);
  return {
    text: simplified.join("\n\n"),
    tips: [
      "Short lines and large spacing",
      "Simple words and clear structure",
      "Audio support when available"
    ]
  };
}

function buildFlashcards(sentences, maxFlashcards) {
  const cleaned = sentences.filter(isUsefulSentence);
  const pool = cleaned.length ? cleaned : sentences;
  const keywordScores = buildKeywordScores(pool);

  return pool.slice(0, maxFlashcards).map((sentence, index) => {
    const keyword = pickKeyword(sentence, keywordScores);
    if (!keyword) {
      return {
        question: `What is the key idea?`,
        answer: toBullet(sentence)
      };
    }

    const { cloze, answer } = buildCloze(sentence, keyword);
    const shortCloze = shortenCloze(cloze, 16);
    return {
      question: `Fill in the blank: ${shortCloze}`,
      answer: answer || keyword
    };
  });
}

function buildTimeline(chunks, options = {}) {
  const segments = options.segments;
  const chunkSize = options.chunkSize;
  if (Array.isArray(segments) && segments.length) {
    return buildTimelineFromSegments(segments, chunkSize);
  }

  let currentSeconds = 0;
  return chunks.map((chunk) => {
    const summary = chunk.join(" ");
    const title = makeTitle(chunk[0]);
    const estimatedSeconds = estimateDuration(summary);
    const time = formatTime(currentSeconds);
    currentSeconds += estimatedSeconds;
    return {
      time,
      title,
      summary
    };
  });
}

function splitSentences(text) {
  if (!text) return [];
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return matches.map((sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed) return "";
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }).filter(Boolean);
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchTranscriptFromYoutube(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error("Could not parse a video ID from the URL.");
  }

  const module = await getYoutubeTranscript();
  const YoutubeTranscript = module.YoutubeTranscript || module.default || module;

  if (!YoutubeTranscript || !YoutubeTranscript.fetchTranscript) {
    throw new Error("youtube-transcript is not available.");
  }

  let segments;
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
  } catch (error) {
    segments = await YoutubeTranscript.fetchTranscript(url, { lang: "en" });
  }

  if (!segments || !segments.length) {
    throw new Error("No transcript available for this video.");
  }

  const transcript = segments.map((segment) => segment.text).join(" ");
  return { transcript, segments, segmentCount: segments.length };
}

async function getYoutubeTranscript() {
  if (youtubeTranscriptModule) return youtubeTranscriptModule;

  try {
    youtubeTranscriptModule = require("youtube-transcript");
  } catch (error) {
    const imported = await import("youtube-transcript");
    youtubeTranscriptModule = imported;
  }

  return youtubeTranscriptModule;
}

async function transcribeWithHuggingFace({ buffer, contentType, token, model }) {
  const response = await fetch(
    `https://api-inference.huggingface.co/models/${model}?wait_for_model=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType || "audio/wav"
      },
      body: buffer
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  if (!payload.text) {
    throw new Error("No transcription text returned.");
  }

  return {
    text: payload.text,
    model
  };
}

function simplifySentence(sentence, maxWords = 12) {
  const replacements = {
    demonstrates: "shows",
    utilize: "use",
    approximately: "about",
    individuals: "people",
    neurodivergent: "neurodiverse",
    comprehension: "understanding",
    generates: "creates",
    extracts: "pulls",
    highlights: "shows"
  };

  const cleaned = cleanSentence(sentence).replace(/[.!?]$/, "");
  const words = cleaned.split(" ").filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (replacements[lower]) {
      return matchCase(word, replacements[lower]);
    }
    return word;
  });

  if (!words.length) return "";
  return `${words.slice(0, maxWords).join(" ")}.`;
}

function extractKeyword(sentence) {
  const stopwords = new Set([
    "this", "that", "with", "from", "into", "your", "about", "their", "they",
    "them", "then", "when", "what", "where", "which", "while", "will", "would",
    "could", "should", "have", "has", "make", "makes", "made", "more", "most",
    "some", "first", "next", "finally", "video", "learn", "learning", "focus"
  ]);

  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !stopwords.has(word));

  if (!tokens.length) return null;
  return tokens[0];
}

function isUsefulSentence(sentence) {
  if (!sentence) return false;
  const wordCount = countWords(sentence);
  if (wordCount < 6) return false;
  const alphaChars = sentence.replace(/[^a-z]/gi, "");
  return alphaChars.length >= 20;
}

function buildKeywordScores(sentences) {
  const scores = new Map();
  sentences.forEach((sentence) => {
    tokenizeForKeywords(sentence).forEach((token) => {
      scores.set(token, (scores.get(token) || 0) + 1);
    });
  });
  return scores;
}

function pickKeyword(sentence, scores) {
  const tokens = tokenizeForKeywords(sentence);
  if (!tokens.length) return null;

  let bestToken = null;
  let bestScore = -Infinity;
  tokens.forEach((token) => {
    const frequency = scores.get(token) || 1;
    const score = token.length / frequency;
    if (score > bestScore) {
      bestScore = score;
      bestToken = token;
    }
  });
  return bestToken;
}

function tokenizeForKeywords(sentence) {
  const stopwords = new Set([
    "this", "that", "with", "from", "into", "your", "about", "their", "they",
    "them", "then", "when", "what", "where", "which", "while", "will", "would",
    "could", "should", "have", "has", "make", "makes", "made", "more", "most",
    "some", "first", "next", "finally", "video", "videos", "learn", "learning",
    "focus", "called", "going", "using", "used", "use", "get", "gets", "got",
    "say", "says", "said", "like", "just", "really", "there", "here", "also",
    "want", "need", "much", "many", "thing", "things"
  ]);

  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !stopwords.has(word));
}

function buildCloze(sentence, keyword) {
  const escaped = escapeRegExp(keyword);
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  const match = sentence.match(regex);
  const cloze = sentence.replace(regex, "____");
  return { cloze, answer: match ? match[0] : keyword };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanSentence(sentence) {
  return sentence
    .replace(/\[[^\]]*]|\([^)]*\)/g, "")
    .replace(/\b(um+|uh+|you know|kind of|sort of)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSummaryCandidate(sentence) {
  if (!sentence || isNoiseSentence(sentence)) return false;
  const words = countWords(sentence);
  return words >= 6 && words <= 32;
}

function isDyslexiaCandidate(sentence) {
  if (!sentence || isNoiseSentence(sentence)) return false;
  if (containsGreeting(sentence)) return false;
  const words = countWords(sentence);
  return words >= 6 && words <= 20;
}

function uniqueSentences(sentences) {
  const seen = new Set();
  const result = [];

  sentences.forEach((sentence) => {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(sentence);
  });

  return result;
}

function toSummaryBullet(sentence) {
  const cleaned = sentence.replace(/[.!?]$/, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const limit = Math.min(words.length, 11);
  return `${capitalize(words.slice(0, limit).join(" "))}.`;
}

function trimToWordLimit(text, limit) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return text;
  return `${words.slice(0, limit).join(" ")}...`;
}

function scoreSentence(sentence) {
  const words = countWords(sentence);
  const tokens = tokenizeForKeywords(sentence);
  let score = tokens.length;

  if (words >= 8 && words <= 22) {
    score += 1.5;
  } else if (words > 26) {
    score -= 1;
  }

  if (containsGreeting(sentence)) {
    score -= 2;
  }

  return score;
}

function containsGreeting(sentence) {
  return /\b(hey|welcome|subscribe|channel|thanks for watching)\b/i.test(sentence);
}

function isNoiseSentence(sentence) {
  const trimmed = sentence.trim();
  if (!trimmed) return true;
  if (/^([a-z]\.?[\s]*)+$/i.test(trimmed)) return true;
  const words = countWords(trimmed);
  if (words < 4) return true;
  const alphaChars = trimmed.replace(/[^a-z]/gi, "");
  if (alphaChars.length < 10) return true;
  return false;
}

function shortenCloze(cloze, maxWords) {
  const words = cloze.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return cloze;

  const blankIndex = words.findIndex((word) => word.includes("____"));
  if (blankIndex === -1) {
    return `${words.slice(0, maxWords).join(" ")}...`;
  }

  const beforeCount = Math.floor((maxWords - 1) / 2);
  const start = Math.max(0, blankIndex - beforeCount);
  const end = Math.min(words.length, start + maxWords);
  const snippet = words.slice(start, end).join(" ");

  const prefix = start > 0 ? "... " : "";
  const suffix = end < words.length ? " ..." : "";
  return `${prefix}${snippet}${suffix}`.trim();
}

function toBullet(sentence) {
  const cleaned = sentence.replace(/[.!?]$/, "");
  const words = cleaned.split(" ");
  if (words.length <= 10) {
    return `${capitalize(cleaned)}.`;
  }
  return `${capitalize(words.slice(0, 12).join(" "))}.`;
}

function makeTitle(sentence) {
  const words = sentence.replace(/[.!?]$/, "").split(" ");
  return words.slice(0, 5).join(" ");
}

function estimateDuration(sentence) {
  const words = countWords(sentence);
  const minutes = words / 170;
  const seconds = Math.round(minutes * 60);
  return Math.max(20, seconds);
}

function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildTimelineFromSegments(segments, chunkSize) {
  const groupSize = Math.max(2, Number.isFinite(chunkSize) ? chunkSize * 2 : 4);
  const timeline = [];
  let fallbackSeconds = 0;

  for (let i = 0; i < segments.length; i += groupSize) {
    const group = segments.slice(i, i + groupSize);
    if (!group.length) break;

    const first = group[0];
    const offsetSeconds = normalizeOffsetSeconds(first && first.offset);
    const timeSeconds = Number.isFinite(offsetSeconds) ? offsetSeconds : fallbackSeconds;
    const groupText = group.map((segment) => segment.text).join(" ");

    timeline.push({
      time: formatTime(timeSeconds),
      title: makeTitle(groupText),
      summary: toBullet(groupText)
    });

    const groupDuration = group.reduce((sum, segment) => {
      const durationSeconds = normalizeDurationSeconds(segment && segment.duration);
      return sum + durationSeconds;
    }, 0);

    fallbackSeconds = timeSeconds + (groupDuration || estimateDuration(groupText));
  }

  return timeline;
}

function normalizeOffsetSeconds(value) {
  if (!Number.isFinite(value)) return null;
  if (value > 10000) return Math.round(value / 1000);
  return Math.round(value);
}

function normalizeDurationSeconds(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > 10000) return Math.round(value / 1000);
  return Math.round(value);
}

function extractVideoId(url) {
  const match = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?]+)/);
  return match ? match[1] : null;
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error.";
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function matchCase(original, replacement) {
  if (original[0] === original[0].toUpperCase()) {
    return capitalize(replacement);
  }
  return replacement;
}
