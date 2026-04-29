# Anova
Tech Fusion 2.0 : 

# FocusCut 🎯

> Turn any YouTube video into a focused learning experience — built for minds that think differently.

---

## 1. Introduction

FocusCut is an AI-powered learning tool designed to help ADHD learners and anyone overwhelmed by long-form video content actually finish what they start. Unlike traditional video platforms that just play content, FocusCut restructures it into something your brain can absorb.

---

## 2. Problem Statement

**Theme:** Intelligent Systems for Real-World Decision Making

70% of ADHD learners abandon online courses. Long YouTube videos have no checkpoints, no structure, and no recovery path when focus breaks. Existing platforms do nothing to adapt content for learners who think differently.

---

## 3. Objectives

- Reduce the cognitive load of learning from long-form video
- Give ADHD learners a structured entry point into any video
- Introduce intelligent summarization into everyday learning workflows

---

## 4. Key Features

- **One-sentence summary** — the core idea of the video, instantly
- **Key bullet points** — 3 to 5 takeaways, short enough to scan
- **Interactive timeline** — click any moment, jump straight there
- **Flashcard deck** — 5 Q&A cards to test retention
- **Progress tracker** — visual completion bar for that all-important finish signal

---

## 5. Decision Logic

FocusCut scores content density across the transcript to decide what makes it into the summary. The priority formula:

```
Score = 0.6 × Concept Density + 0.3 × Repetition Weight + 0.1 × Speaker Emphasis
```

Higher score = more likely to appear in the summary. Concept density carries the most weight to ensure the learner always gets the substance, not the filler.

---

## 6. Tech Stack

- **Language:** Javascript, Nodegs, Express, Built-in Fetch() (backend), HTML, CSS, React18, ReactDOM (frontend).
- **External services:** groq API, OpenAI TTS API, Youtube oEmbed.
- **Data Processing:** AI summarization on extracted transcript data.
- **UI:** ADHD-friendly dashboard — dark mode, large text, minimal distractions.

---

## 7. Setup & Demo Instructions

1. Clone the repository: `git clone https://github.com/yashwanthmadivalara/ANOVA_FocusCut`
2. Run the app: `npm start`
3. Paste any YouTube URL, select your focus mode, and get your instant summary, timeline, and flashcards
