const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/process", (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Provide a valid YouTube URL." });
  }

  const data = buildDemoData(url.trim());
  return res.json(data);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`FocusCut running on http://localhost:${port}`);
});

function buildDemoData(url) {
  const transcript = [
    "This video shows how to learn faster by breaking long content into small chunks.",
    "First, extract a transcript and highlight the ideas that matter most.",
    "Next, generate a timeline so learners can jump to topics without scrolling.",
    "Then create ADHD friendly bullets with strong verbs and short phrases.",
    "For dyslexia mode, simplify sentences and add more spacing for comfort.",
    "Finally, turn key points into flashcards that support active recall.",
    "All processing can run on device with Whisper or Vosk to protect privacy.",
    "No video data needs to leave the learner's computer during the demo."
  ].join(" ");

  const sentences = transcript
    .split(". ")
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => (sentence.endsWith(".") ? sentence : `${sentence}.`));

  const chunkSize = 2;
  const chunks = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize));
  }

  const timeline = chunks.map((chunk, index) => ({
    time: formatTime(index * 120),
    title: makeTitle(chunk[0]),
    summary: chunk.join(" ")
  }));

  const summaryBullets = sentences.slice(0, 3);
  const summaryParagraph = sentences.slice(0, 4).join(" ");

  const dyslexiaText = simplifySentences(sentences.slice(0, 4)).join("\n\n");

  const flashcards = sentences.slice(0, 5).map((sentence, index) => ({
    question: `Key idea ${index + 1}`,
    answer: sentence
  }));

  return {
    sourceUrl: url,
    title: "FocusCut demo output",
    stats: {
      transcriptLength: transcript.length,
      segments: timeline.length
    },
    summary: {
      bullets: summaryBullets,
      paragraph: summaryParagraph
    },
    adhd: {
      bullets: chunks.map((chunk) => chunk[0]),
      timeline
    },
    dyslexia: {
      text: dyslexiaText,
      tips: [
        "Short lines and large spacing",
        "Simple words and clear structure",
        "Audio support when available"
      ]
    },
    flashcards,
    notice: "Demo data only. Wire to Whisper or Vosk for full transcription."
  };
}

function simplifySentences(sentences) {
  return sentences.map((sentence) => {
    const words = sentence.replace(/\.$/, "").split(" ");
    return `${words.slice(0, 12).join(" ")}.`;
  });
}

function makeTitle(sentence) {
  const words = sentence.replace(/\.$/, "").split(" ");
  return words.slice(0, 5).join(" ");
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
