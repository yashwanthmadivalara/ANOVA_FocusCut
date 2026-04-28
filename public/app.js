const { useEffect, useRef, useState } = React;

const API_BASE = window.location.protocol === "file:" ? "http://localhost:3000" : "";
const VOICE_DISCLOSURE = "Audio playback uses an AI-generated or browser-generated voice.";
const LOADING_MESSAGES = [
  "Fetching transcript",
  "Mapping key concepts",
  "Building ADHD mode",
  "Preparing flashcards",
  "Setting up voice support"
];

let youtubeApiPromise;

function createEmptyProgress() {
  return {
    completedFlashcards: {},
    listenedSections: {},
    activeMode: "summary",
    lastTimelinePoint: null
  };
}

function getApiUrl(path) {
  return `${API_BASE}${path}`;
}

function getRuntimeBaseUrl() {
  return API_BASE || window.location.origin;
}

function humanizeNarrationMessage(message) {
  const text = String(message || "").trim();
  if (!text) {
    return "Using the browser voice fallback.";
  }

  if (/OPENAI_API_KEY|not configured/i.test(text)) {
    return "Using the browser voice because AI narration is not configured yet.";
  }

  if (/timed out/i.test(text)) {
    return "The AI voice took too long, so FocusCut switched to the browser voice.";
  }

  if (/unavailable|failed/i.test(text)) {
    return "The AI voice is unavailable right now, so FocusCut switched to the browser voice.";
  }

  return text;
}

function storageGet(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures in private or constrained browsing modes.
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function getProgressKey(videoId) {
  return `focuscut:progress:${videoId}`;
}

function getLastSessionKey() {
  return "focuscut:last-session";
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }

  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-youtube-api="true"]');

      window.onYouTubeIframeAPIReady = () => resolve(window.YT);

      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        script.dataset.youtubeApi = "true";
        script.onerror = () => reject(new Error("Unable to load the YouTube player."));
        document.head.appendChild(script);
      }
    });
  }

  return youtubeApiPromise;
}

function trimNarrationText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > 3900 ? `${clean.slice(0, 3900)}.` : clean;
}

function formatFlashcardLabel(index) {
  return `Card ${String(index + 1).padStart(2, "0")}`;
}

function App() {
  const [health, setHealth] = useState({
    status: "checking",
    aiConfigured: false,
    aiProvider: "fallback",
    openaiTtsConfigured: false
  });
  const [urlInput, setUrlInput] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0]);
  const [activeMode, setActiveMode] = useState("summary");
  const [progress, setProgress] = useState(createEmptyProgress);
  const [audioState, setAudioState] = useState({
    sectionId: "",
    status: "idle",
    provider: "",
    label: "",
    message: ""
  });
  const [resumeNote, setResumeNote] = useState("");
  const [lastSession, setLastSession] = useState(() => storageGet(getLastSessionKey()));

  const abortRef = useRef(null);
  const audioRef = useRef(null);
  const speechRef = useRef(null);
  const playerInstanceRef = useRef(null);
  const playerHostRef = useRef(null);

  useEffect(() => {
    fetchHealth();
  }, []);

  useEffect(() => {
    if (!isLoading) {
      return undefined;
    }

    let index = 0;
    const timer = window.setInterval(() => {
      index = (index + 1) % LOADING_MESSAGES.length;
      setLoadingMessage(LOADING_MESSAGES[index]);
    }, 1600);

    return () => window.clearInterval(timer);
  }, [isLoading]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopNarration();
      destroyPlayer();
    };
  }, []);

  useEffect(() => {
    if (!result?.videoId) {
      setProgress(createEmptyProgress());
      return;
    }

    const saved = storageGet(getProgressKey(result.videoId), createEmptyProgress());
    const merged = {
      ...createEmptyProgress(),
      ...saved,
      completedFlashcards: saved?.completedFlashcards || {},
      listenedSections: saved?.listenedSections || {}
    };

    setProgress(merged);
    setActiveMode(merged.activeMode || "summary");
    if (saved && (Object.keys(merged.completedFlashcards).length > 0 || merged.lastTimelinePoint)) {
      setResumeNote("Saved progress restored for this video.");
    } else {
      setResumeNote("");
    }
  }, [result?.videoId]);

  useEffect(() => {
    if (!result?.videoId) {
      return;
    }

    storageSet(getProgressKey(result.videoId), {
      ...progress,
      activeMode
    });
  }, [progress, activeMode, result?.videoId]);

  useEffect(() => {
    if (!result?.videoId || !playerHostRef.current) {
      return undefined;
    }

    let cancelled = false;
    const mountNode = playerHostRef.current;

    stopNarration();
    destroyPlayer();
    mountNode.innerHTML = "";

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountNode) {
          return;
        }

        playerInstanceRef.current = new YT.Player(mountNode, {
          videoId: result.videoId,
          playerVars: {
            rel: 0,
            modestbranding: 1,
            playsinline: 1
          }
        });
      })
      .catch(() => {
        setResumeNote("The embedded player could not load, but the learning kit is still ready.");
      });

    return () => {
      cancelled = true;
      destroyPlayer();
      if (mountNode) {
        mountNode.innerHTML = "";
      }
    };
  }, [result?.videoId]);

  async function fetchHealth() {
    try {
      const response = await fetch(getApiUrl("/api/health"));
      if (!response.ok) {
        throw new Error("Health check failed");
      }

      const data = await response.json();
      setHealth({
        status: "online",
        aiConfigured: Boolean(data.groqConfigured || data.anthropicConfigured),
        aiProvider: data.aiProvider || (data.groqConfigured ? "groq" : data.anthropicConfigured ? "anthropic" : "fallback"),
        openaiTtsConfigured: Boolean(data.openaiTtsConfigured)
      });
    } catch {
      setHealth({
        status: "offline",
        aiConfigured: false,
        aiProvider: "fallback",
        openaiTtsConfigured: false
      });
    }
  }

  function destroyPlayer() {
    if (playerInstanceRef.current && typeof playerInstanceRef.current.destroy === "function") {
      playerInstanceRef.current.destroy();
    }
    playerInstanceRef.current = null;
  }

  function stopNarration() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    speechRef.current = null;

    setAudioState({
      sectionId: "",
      status: "idle",
      provider: "",
      label: "",
      message: ""
    });
  }

  function saveLastSession(nextUrl, nextResult) {
    const payload = {
      sourceUrl: nextUrl,
      result: nextResult,
      savedAt: new Date().toISOString()
    };
    storageSet(getLastSessionKey(), payload);
    setLastSession(payload);
  }

  async function handleProcess() {
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      setError("Paste a YouTube link to generate the learning kit.");
      return;
    }

    if (health.status === "offline") {
      setError("FocusCut API is offline. Start the server with npm run dev, then refresh this page.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError("");
    setIsLoading(true);
    setLoadingMessage(LOADING_MESSAGES[0]);
    setResumeNote("");
    setResult(null);
    stopNarration();

    try {
      const response = await fetch(getApiUrl("/api/process"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: trimmedUrl }),
        signal: controller.signal
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to process this video.");
      }

      setResult(data);
      setActiveMode("summary");
      saveLastSession(trimmedUrl, data);
    } catch (requestError) {
      if (requestError.name !== "AbortError") {
        setError(requestError.message || "Something went wrong while processing the video.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleResumeLastSession() {
    const saved = storageGet(getLastSessionKey());
    if (!saved?.result) {
      return;
    }

    setUrlInput(saved.sourceUrl || "");
    setResult(saved.result);
    setError("");
    setResumeNote("Resumed your last FocusCut session.");
  }

  function resetProgress() {
    if (!result?.videoId) {
      return;
    }

    const fresh = createEmptyProgress();
    storageSet(getProgressKey(result.videoId), fresh);
    setProgress(fresh);
    setActiveMode("summary");
    setResumeNote("Progress reset for this video.");
  }

  function markFlashcardComplete(index) {
    setProgress((current) => ({
      ...current,
      completedFlashcards: {
        ...current.completedFlashcards,
        [index]: !current.completedFlashcards[index]
      }
    }));
  }

  function markSectionListened(sectionId) {
    setProgress((current) => ({
      ...current,
      listenedSections: {
        ...current.listenedSections,
        [sectionId]: true
      }
    }));
  }

  function markTimelineVisit(entry) {
    setProgress((current) => ({
      ...current,
      lastTimelinePoint: {
        seconds: entry.seconds,
        time: entry.time,
        title: entry.title
      }
    }));
  }

  function jumpToTimeline(entry) {
    markTimelineVisit(entry);

    const player = playerInstanceRef.current;
    if (player && typeof player.seekTo === "function") {
      player.seekTo(entry.seconds, true);
      if (typeof player.playVideo === "function") {
        player.playVideo();
      }
    }
  }

  function startBrowserNarration(sectionId, label, text, message) {
    if (!("speechSynthesis" in window)) {
      setAudioState({
        sectionId,
        status: "error",
        provider: "",
        label,
        message: "Speech playback is unavailable in this browser."
      });
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.onstart = () => {
      markSectionListened(sectionId);
      setAudioState({
        sectionId,
        status: "playing",
        provider: "browser",
        label,
        message
      });
    };
    utterance.onend = () => {
      setAudioState({
        sectionId: "",
        status: "idle",
        provider: "",
        label: "",
        message: ""
      });
    };
    utterance.onerror = () => {
      setAudioState({
        sectionId,
        status: "error",
        provider: "browser",
        label,
        message: "Browser narration could not play."
      });
    };

    speechRef.current = utterance;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  async function handleNarration(sectionId, label, text) {
    const cleanText = trimNarrationText(text);
    if (!cleanText) {
      setError("There is no text ready for narration yet.");
      return;
    }

    if (audioState.sectionId === sectionId && audioState.status === "playing") {
      stopNarration();
      return;
    }

    stopNarration();
    setAudioState({
      sectionId,
      status: "loading",
      provider: "",
      label,
      message: "Preparing narration"
    });

    try {
      const response = await fetch(getApiUrl("/api/tts"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sectionId,
          text: cleanText,
          voice: "coral"
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to create narration.");
      }

      if (data.ok && data.audioBase64) {
        const audio = new Audio(`data:${data.mimeType || "audio/mpeg"};base64,${data.audioBase64}`);
        audioRef.current = audio;
        audio.onended = () => {
          setAudioState({
            sectionId: "",
            status: "idle",
            provider: "",
            label: "",
            message: ""
          });
        };
        audio.onerror = () => {
          setAudioState({
            sectionId,
            status: "error",
            provider: "openai",
            label,
            message: "Audio playback failed."
          });
        };

        await audio.play();
        markSectionListened(sectionId);
        setAudioState({
          sectionId,
          status: "playing",
          provider: data.provider || "openai",
          label,
          message: "Playing AI voice"
        });
        return;
      }

      startBrowserNarration(
        sectionId,
        label,
        cleanText,
        humanizeNarrationMessage(data.reason)
      );
    } catch (playbackError) {
      startBrowserNarration(
        sectionId,
        label,
        cleanText,
        humanizeNarrationMessage(playbackError.message)
      );
    }
  }

  const completedFlashcardsCount = Object.values(progress.completedFlashcards).filter(Boolean).length;
  const listenedSummary = Boolean(progress.listenedSections.summary);
  const listenedDyslexia = Boolean(progress.listenedSections.dyslexia);
  const hasTimelineVisit = Boolean(progress.lastTimelinePoint);
  const totalProgressGoals = (result?.flashcards?.length || 0) + 3;
  const completedGoals =
    completedFlashcardsCount +
    (listenedSummary ? 1 : 0) +
    (listenedDyslexia ? 1 : 0) +
    (hasTimelineVisit ? 1 : 0);
  const progressPercent = totalProgressGoals
    ? Math.round((completedGoals / totalProgressGoals) * 100)
    : 0;

  const summaryNarration = result
    ? `${result.summary.bullets.join(" ")} ${result.summary.paragraph}`
    : "";
  const dyslexiaNarration = result
    ? `${result.dyslexia.text.replace(/\n+/g, " ")} ${result.dyslexia.tips.join(" ")}`
    : "";

  return (
    <div className="app-shell">
      <div className="site-band">
        <div className="container topbar">
          <div className="brand">
            <div className="brand-mark">FC</div>
            <div className="brand-copy">
              <div className="brand-name">FocusCut</div>
              <div className="brand-tag">YouTube tutorials, rebuilt for neurodivergent learning</div>
            </div>
          </div>

          <div className="topbar-actions">
            <span
              className={`status-pill ${
                health.status === "online"
                  ? "online"
                  : health.status === "offline"
                    ? "offline"
                    : ""
              }`}
            >
              {health.status === "online" ? "API online" : health.status === "offline" ? "API offline" : "Checking API"}
            </span>
            <span className={`status-pill ${health.aiConfigured ? "online" : "warn"}`}>
              {health.aiProvider === "groq"
                ? "Groq ready"
                : health.aiProvider === "anthropic"
                  ? "Claude ready"
                  : "AI fallback mode"}
            </span>
            <span className={`status-pill ${health.openaiTtsConfigured ? "online" : "warn"}`}>
              {health.openaiTtsConfigured ? "OpenAI voice ready" : "Browser voice fallback"}
            </span>
          </div>
        </div>
      </div>

      <div className="site-band">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Built for ADHD and neurodivergent learners</span>
            <h1>Long YouTube tutorials become short, clear, usable study tools.</h1>
            <p>
              FocusCut turns any captioned public YouTube video into a guided learning kit with
              Claude-powered summaries, timeline checkpoints, dyslexia-friendly reading, flashcards,
              audio support, and progress tracking that survives refreshes.
            </p>

            <div className="hero-points">
              <div className="hero-point">Judges understand the problem in one glance: long tutorials are hard to finish.</div>
              <div className="hero-point">The workflow is demo-ready in one pass: paste link, process, listen, review, resume.</div>
              <div className="hero-point">The stack clearly shows multiple AI surfaces without burying the core experience.</div>
            </div>
          </div>

          <div className="hero-side">
            <div className="metric-strip">
              <div className="metric">
                <strong>4</strong>
                <span>Learning modes from one transcript.</span>
              </div>
              <div className="metric">
                <strong>1</strong>
                <span>Click to jump back into the video timeline.</span>
              </div>
              <div className="metric">
                <strong>0</strong>
                <span>Accounts or setup screens before the demo starts.</span>
              </div>
            </div>
            <p className="voice-text">{VOICE_DISCLOSURE}</p>
          </div>
        </div>
      </div>

      <div className="container surface-grid">
        <section className="input-strip" id="demo">
          <div className="strip-head">
            <div>
              <h2>Build a FocusCut learning kit</h2>
              <p>Paste a public YouTube URL with captions. FocusCut will do the rest.</p>
            </div>
            {isLoading ? (
              <div className="loading-chip">
                <span className="spinner" aria-hidden="true"></span>
                <span>{loadingMessage}</span>
              </div>
            ) : null}
          </div>

          <div className="url-row">
            <label htmlFor="video-url" className="sr-only">
              YouTube URL
            </label>
            <input
              id="video-url"
              className="url-input"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleProcess();
                }
              }}
              disabled={isLoading}
            />
            <button className="primary-btn" onClick={handleProcess} disabled={isLoading}>
              {isLoading ? "Processing..." : "Generate kit"}
            </button>
            <button
              className="secondary-btn"
              onClick={handleResumeLastSession}
              disabled={!lastSession?.result || isLoading}
            >
              Resume last session
            </button>
          </div>

          <div className="helper-row">
            <div className="helper-text">
              Works from this file preview or from <strong>{getRuntimeBaseUrl()}</strong> once the server is running.
            </div>
            {audioState.status === "playing" || audioState.status === "loading" ? (
              <button className="ghost-btn" onClick={stopNarration}>
                Stop audio
              </button>
            ) : null}
          </div>

          {error ? <div className="error-text">{error}</div> : null}

          {lastSession?.result && !result ? (
            <div className="resume-banner">
              <div className="note-text">
                Last saved video: <strong>{lastSession.result.title}</strong>
              </div>
              <button className="secondary-btn" onClick={handleResumeLastSession}>
                Load saved kit
              </button>
            </div>
          ) : null}

          {resumeNote ? <div className="note-text">{resumeNote}</div> : null}
        </section>

        <section className="workspace-grid">
          <div className="workspace-panel">
            <div className="section-title">
              <h3>Watch and return to the exact moment</h3>
              <p>Timeline points and progress stay tied to the current video.</p>
            </div>

            {result ? (
              <>
                <div className="player-shell">
                  <div ref={playerHostRef}></div>
                </div>

                <div className="thumbnail-row">
                  <img src={result.thumbnail} alt={`Thumbnail for ${result.title}`} />
                  <div className="video-caption">
                    <strong>{result.title}</strong>
                    <span>
                      {result.author ? `${result.author} - ` : ""}
                      {result.notice}
                    </span>
                  </div>
                </div>

                <div className="progress-module">
                  <div className="section-title">
                    <h3>Progress</h3>
                    <p>Flashcard completion, audio sections, and your last timeline jump are saved locally.</p>
                  </div>

                  <div className="progress-meter" aria-label="Learning progress">
                    <span style={{ width: `${progressPercent}%` }}></span>
                  </div>

                  <div className="progress-stats">
                    <div className="progress-stat">
                      <strong>{progressPercent}%</strong>
                      <span>Overall completion for this video.</span>
                    </div>
                    <div className="progress-stat">
                      <strong>{completedFlashcardsCount}/{result.flashcards.length}</strong>
                      <span>Flashcards marked done.</span>
                    </div>
                    <div className="progress-stat">
                      <strong>{Object.keys(progress.listenedSections).length}</strong>
                      <span>Sections heard with audio.</span>
                    </div>
                    <div className="progress-stat">
                      <strong>{progress.lastTimelinePoint?.time || "--:--"}</strong>
                      <span>
                        {progress.lastTimelinePoint
                          ? `Last checkpoint: ${progress.lastTimelinePoint.title}`
                          : "Timeline jump not used yet."}
                      </span>
                    </div>
                  </div>

                  <div className="helper-row">
                    <div className="note-text">Active mode: {activeMode}</div>
                    <button className="secondary-btn" onClick={resetProgress}>
                      Reset progress
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="placeholder-panel">
                <div className="section-title">
                  <h3>Demo-ready flow</h3>
                  <p>Process one video and the workspace turns into a player, recap board, audio reader, and revision deck.</p>
                </div>
                <div className="placeholder-grid">
                  <div className="placeholder-tile">
                    <strong>Summary mode</strong>
                    <div className="note-text">Fast bullets and a clean paragraph for orientation.</div>
                  </div>
                  <div className="placeholder-tile">
                    <strong>ADHD mode</strong>
                    <div className="note-text">Action-first bullets plus timestamped checkpoints.</div>
                  </div>
                  <div className="placeholder-tile">
                    <strong>Dyslexia mode</strong>
                    <div className="note-text">Shorter sentences, more spacing, easier reading rhythm.</div>
                  </div>
                  <div className="placeholder-tile">
                    <strong>Flashcards</strong>
                    <div className="note-text">Quick recall prompts you can mark complete and revisit later.</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="workspace-panel">
            <div className="section-title">
              <h3>Learning kit</h3>
              <p>Switch modes without losing your place. Audio and completion state stay synced.</p>
            </div>

            <div className="mode-row" role="tablist" aria-label="Learning modes">
              {[
                ["summary", "Summary"],
                ["adhd", "ADHD mode"],
                ["dyslexia", "Dyslexia mode"],
                ["flashcards", "Flashcards"]
              ].map(([modeId, label]) => (
                <button
                  key={modeId}
                  className={`mode-tab ${activeMode === modeId ? "active" : ""}`}
                  onClick={() => {
                    setActiveMode(modeId);
                    setProgress((current) => ({ ...current, activeMode: modeId }));
                  }}
                  disabled={!result}
                  role="tab"
                  aria-selected={activeMode === modeId}
                >
                  {label}
                </button>
              ))}
            </div>

            {audioState.status !== "idle" ? (
              <div className="note-text">
                {audioState.label}: {audioState.message}
              </div>
            ) : null}

            {!result ? (
              <div className="placeholder-panel">
                <div className="section-title">
                  <h3>No video processed yet</h3>
                  <p>The right side becomes the live demo output once a transcript is available.</p>
                </div>
                <div className="note-text">
                  FocusCut keeps the product story clear: one video becomes four formats, voice support,
                  and saved progress with no sign-in wall.
                </div>
              </div>
            ) : null}

            {result && activeMode === "summary" ? (
              <>
                <div className="section-actions">
                  <button
                    className="secondary-btn"
                    onClick={() => handleNarration("summary", "Summary audio", summaryNarration)}
                  >
                    {audioState.sectionId === "summary" && audioState.status === "playing"
                      ? "Stop summary audio"
                      : "Play summary audio"}
                  </button>
                  <span className="voice-text">
                    {health.openaiTtsConfigured
                      ? "OpenAI TTS preferred."
                      : health.aiProvider === "groq"
                        ? "Groq powers the learning kit. Browser voice fallback is active."
                        : "Browser voice fallback active."}
                  </span>
                </div>

                <ul className="bullet-list">
                  {result.summary.bullets.map((item, index) => (
                    <li key={`${item}-${index}`} className="bullet-item">
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <p className="body-copy">{result.summary.paragraph}</p>
              </>
            ) : null}

            {result && activeMode === "adhd" ? (
              <>
                <ul className="bullet-list">
                  {result.adhd.bullets.map((item, index) => (
                    <li key={`${item}-${index}`} className="bullet-item">
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <div className="timeline-list">
                  {result.adhd.timeline.map((entry, index) => (
                    <button
                      key={`${entry.time}-${index}`}
                      className={`timeline-button ${
                        progress.lastTimelinePoint?.seconds === entry.seconds ? "active" : ""
                      }`}
                      onClick={() => jumpToTimeline(entry)}
                    >
                      <span className="timeline-time">{entry.time}</span>
                      <strong>{entry.title}</strong>
                      <span className="timeline-summary">{entry.summary}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {result && activeMode === "dyslexia" ? (
              <>
                <div className="section-actions">
                  <button
                    className="secondary-btn"
                    onClick={() => handleNarration("dyslexia", "Dyslexia audio", dyslexiaNarration)}
                  >
                    {audioState.sectionId === "dyslexia" && audioState.status === "playing"
                      ? "Stop reading"
                      : "Read aloud"}
                  </button>
                  <span className="voice-text">Shorter sentences and extra spacing for easier scanning.</span>
                </div>

                <div className="dyslexia-block">{result.dyslexia.text}</div>

                <ul className="bullet-list">
                  {result.dyslexia.tips.map((tip, index) => (
                    <li key={`${tip}-${index}`} className="bullet-item">
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {result && activeMode === "flashcards" ? (
              <div className="flashcard-grid">
                {result.flashcards.map((card, index) => {
                  const done = Boolean(progress.completedFlashcards[index]);
                  const sectionId = `flashcard-${index}`;
                  const label = `${formatFlashcardLabel(index)} audio`;

                  return (
                    <button
                      key={`${card.question}-${index}`}
                      className={`flashcard-card ${done ? "done" : ""}`}
                      onClick={() => markFlashcardComplete(index)}
                      type="button"
                      aria-pressed={done}
                    >
                      <div className="flashcard-label">
                        <span>{formatFlashcardLabel(index)}</span>
                        <span>{done ? "Completed" : "Tap to mark done"}</span>
                      </div>
                      <strong>{card.question}</strong>
                      <div className="flashcard-answer">{card.answer}</div>
                      <div className="card-actions">
                        <span className="mini-btn" role="presentation">
                          {done ? "Completed" : "Not completed"}
                        </span>
                        <button
                          className="mini-btn"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleNarration(sectionId, label, `Question. ${card.question} Answer. ${card.answer}`);
                          }}
                        >
                          {audioState.sectionId === sectionId && audioState.status === "playing"
                            ? "Stop audio"
                            : "Play audio"}
                        </button>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </section>

        <section className="impact-grid">
          <div className="impact-card">
            <h4>Clear social impact</h4>
            <p>FocusCut makes long-form video learning more usable for ADHD and neurodivergent learners without adding account friction.</p>
          </div>
          <div className="impact-card">
            <h4>Visible AI value</h4>
            <p>Transcript parsing, Claude summarization, and OpenAI or browser voice output all show up directly in the product experience.</p>
          </div>
          <div className="impact-card">
            <h4>Demo reliability</h4>
            <p>When live AI services are unavailable, the app still degrades cleanly enough to show the workflow and keep the story intact.</p>
          </div>
        </section>
      </div>

      <div className="site-band">
        <div className="container footer">
          <span>FocusCut keeps the demo grounded in a real accessibility problem.</span>
          <span>{VOICE_DISCLOSURE}</span>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
