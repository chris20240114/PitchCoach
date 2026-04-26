const camera = document.querySelector("#camera");
const canvas = document.querySelector("#visionCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const retryBtn = document.querySelector("#retryBtn");
const timerEl = document.querySelector("#timer");
const cameraStatus = document.querySelector("#cameraStatus");
const speechStatus = document.querySelector("#speechStatus");
const signalStatus = document.querySelector("#signalStatus");
const transcriptEl = document.querySelector("#transcript");
const coachMessage = document.querySelector("#coachMessage");
const avatar = document.querySelector("#avatar");
const dashboard = document.querySelector("#dashboard");
const deliveryList = document.querySelector("#deliveryList");
const contentList = document.querySelector("#contentList");
const rewriteText = document.querySelector("#rewriteText");
const followupText = document.querySelector("#followupText");
const eyeSignal = document.querySelector("#eyeSignal");
const positionSignal = document.querySelector("#positionSignal");
const lightingSignal = document.querySelector("#lightingSignal");
const movementSignal = document.querySelector("#movementSignal");
const uploadFile = document.querySelector("#uploadFile");
const uploadStatus = document.querySelector("#uploadStatus");
const uploadTranscript = document.querySelector("#uploadTranscript");
const analyzeUploadBtn = document.querySelector("#analyzeUploadBtn");
const clearUploadBtn = document.querySelector("#clearUploadBtn");
const mediaPreview = document.querySelector("#mediaPreview");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  mode: "hackathon",
  stream: null,
  recognition: null,
  startedAt: 0,
  timerId: null,
  visionId: null,
  transcript: "",
  interim: "",
  samples: [],
  lastFrame: null,
  uploadUrl: "",
  uploadDuration: 60,
  uploadMedia: null,
};

const audienceCopy = {
  hackathon: {
    start: "Give me the first 60 seconds of your hackathon pitch. I am listening for the user problem, demo clarity, and what makes it matter.",
    followup: "What is the one moment in your demo that proves this is more than a concept?",
  },
  interview: {
    start: "Answer as if this were a technical interview. I will listen for tradeoffs, ownership, and clear examples.",
    followup: "What tradeoff did you make, and what would you change with another week?",
  },
  investor: {
    start: "Pitch this like an investor meeting. I will look for market pain, traction, differentiation, and a strong ask.",
    followup: "Who urgently needs this, and why will they choose you over the current workaround?",
  },
};

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.mode = button.dataset.mode;
    say(audienceCopy[state.mode].start, "listening");
  });
});

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
retryBtn.addEventListener("click", resetSession);
uploadFile.addEventListener("change", handleUploadFile);
uploadTranscript.addEventListener("input", syncUploadControls);
analyzeUploadBtn.addEventListener("click", analyzeUpload);
clearUploadBtn.addEventListener("click", clearUpload);

async function startSession() {
  resetDashboard();
  state.transcript = "";
  state.interim = "";
  state.samples = [];
  state.startedAt = Date.now();
  transcriptEl.textContent = "";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  retryBtn.disabled = true;

  await startCamera();
  startSpeech();
  startTimer();
  startVisionLoop();
  say(audienceCopy[state.mode].start, "nodding");
}

async function startCamera() {
  if (state.stream) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent = "Camera unsupported";
    addVisionSample({ lighting: 0, movement: 0, centered: 0, eye: 0 });
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    camera.srcObject = state.stream;
    cameraStatus.textContent = "Camera on";
  } catch (error) {
    cameraStatus.textContent = "Camera unavailable";
    addVisionSample({ lighting: 0, movement: 0, centered: 0, eye: 0 });
  }
}

function startSpeech() {
  if (!SpeechRecognition) {
    speechStatus.textContent = "Speech unsupported";
    transcriptEl.textContent = "Speech recognition is not available in this browser. You can still stop the session and use the sample analysis.";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onstart = () => {
    speechStatus.textContent = "Listening";
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const phrase = event.results[index][0].transcript;
      if (event.results[index].isFinal) {
        finalText += `${phrase} `;
      } else {
        interimText += phrase;
      }
    }

    if (finalText) state.transcript += finalText;
    state.interim = interimText;
    renderTranscript();
    maybeInterrupt();
  };

  recognition.onerror = () => {
    speechStatus.textContent = "Speech paused";
  };

  recognition.onend = () => {
    if (stopBtn.disabled === false) {
      try {
        recognition.start();
      } catch {
        speechStatus.textContent = "Speech paused";
      }
    }
  };

  state.recognition = recognition;
  recognition.start();
}

function startTimer() {
  state.timerId = window.setInterval(() => {
    const elapsed = getElapsedSeconds();
    timerEl.textContent = formatTime(elapsed);
    if (elapsed >= 60) stopSession();
  }, 250);
}

function startVisionLoop() {
  const loop = () => {
    if (!state.stream || camera.readyState < 2) {
      state.visionId = requestAnimationFrame(loop);
      return;
    }

    ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sample = analyzeFrame(frame);
    addVisionSample(sample);
    renderSignals(sample);
    state.visionId = requestAnimationFrame(loop);
  };

  loop();
}

function analyzeFrame(frame) {
  const data = frame.data;
  let total = 0;
  let left = 0;
  let right = 0;
  let top = 0;
  let centerMass = 0;
  let diff = 0;

  for (let i = 0; i < data.length; i += 16) {
    const pixel = i / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
    total += brightness;
    if (x < canvas.width / 2) left += brightness;
    else right += brightness;
    if (y < canvas.height / 2) top += brightness;
    if (x > canvas.width * 0.32 && x < canvas.width * 0.68 && y > canvas.height * 0.16 && y < canvas.height * 0.72) {
      centerMass += brightness;
    }
    if (state.lastFrame) diff += Math.abs(brightness - state.lastFrame[i]);
  }

  state.lastFrame = data.slice();
  const count = data.length / 16;
  const lighting = total / count;
  const balance = 1 - Math.min(Math.abs(left - right) / Math.max(left + right, 1), 1);
  const centered = Math.min(centerMass / Math.max(total * 0.34, 1), 1);
  const movement = state.lastFrame ? Math.min(diff / Math.max(count * 55, 1), 1) : 0;
  const eye = Math.max(0, Math.min((balance + centered + (top > total * 0.38 ? 0.25 : 0)) / 2.25, 1));

  return { lighting, movement, centered, eye };
}

function addVisionSample(sample) {
  state.samples.push({ ...sample, at: Date.now() });
  if (state.samples.length > 600) state.samples.shift();
}

function renderSignals(sample) {
  signalStatus.textContent = "Tracking";
  setMetric(eyeSignal, sample.eye > 0.72 ? "steady" : sample.eye > 0.48 ? "mixed" : "drifting", sample.eye);
  setMetric(positionSignal, sample.centered > 0.62 ? "centered" : sample.centered > 0.38 ? "okay" : "off center", sample.centered);
  setMetric(lightingSignal, sample.lighting > 84 ? "clear" : sample.lighting > 48 ? "dim" : "too dark", sample.lighting / 120);
  setMetric(movementSignal, sample.movement > 0.34 ? "active" : sample.movement > 0.1 ? "natural" : "still", sample.movement * 2);
}

function setMetric(element, text, score) {
  element.textContent = text;
  element.className = score > 0.66 ? "good" : score > 0.4 ? "warn" : "bad";
}

function stopSession() {
  const wasRunning = stopBtn.disabled === false;

  if (state.interim.trim()) {
    state.transcript = `${state.transcript} ${state.interim}`.trim();
    state.interim = "";
    renderTranscript();
  }

  stopBtn.disabled = true;
  startBtn.disabled = false;
  retryBtn.disabled = false;
  speechStatus.textContent = "Speech stopped";
  cameraStatus.textContent = state.stream ? "Camera ready" : "Camera off";

  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.stop();
  }

  window.clearInterval(state.timerId);
  cancelAnimationFrame(state.visionId);
  if (wasRunning) showFeedback();
}

function resetSession() {
  if (stopBtn.disabled === false) stopSession();
  state.transcript = "";
  state.interim = "";
  state.samples = [];
  state.lastFrame = null;
  transcriptEl.textContent = "Your pitch transcript will appear here as you speak.";
  timerEl.textContent = "00:00";
  speechStatus.textContent = "Speech idle";
  signalStatus.textContent = "Waiting";
  eyeSignal.textContent = "--";
  positionSignal.textContent = "--";
  lightingSignal.textContent = "--";
  movementSignal.textContent = "--";
  resetDashboard();
  say("Ready when you are. Start with the person who has the problem.", "listening");
}

function renderTranscript() {
  const text = `${state.transcript}${state.interim ? ` ${state.interim}` : ""}`.trim();
  transcriptEl.textContent = text || "Listening...";
}

function maybeInterrupt() {
  const elapsed = getElapsedSeconds();
  const text = `${state.transcript} ${state.interim}`.toLowerCase();
  const technicalOpen = /\b(api|model|infrastructure|stack|database|framework|algorithm|multimodal)\b/.test(text);
  const humanWords = /\b(student|founder|user|customer|teacher|developer|patient|team|people)\b/.test(text);

  if (elapsed > 10 && elapsed < 28 && technicalOpen && !humanWords && !coachMessage.dataset.interrupted) {
    coachMessage.dataset.interrupted = "true";
    say("Pause. I am hearing the build, but not the person. Who struggles with this, and why now?", "confused");
  }
}

async function showFeedback(source = {}) {
  const elapsed = Math.max(source.durationSeconds || getElapsedSeconds(), 1);
  const transcript = source.transcript || `${state.transcript} ${state.interim}`.trim() || samplePitch();
  const words = transcript.match(/\b[\w'-]+\b/g) || [];
  const fillers = countFillers(transcript);
  const wpm = Math.round((words.length / elapsed) * 60);
  const visual = source.visual || summarizeVision();
  const scores = scoreContent(transcript);
  const fallback = buildLocalFeedback({ fillers, scores, transcript, visual, wpm });
  const feedback = await requestCoachFeedback({
    audience: state.mode,
    transcript,
    durationSeconds: elapsed,
    delivery: {
      wordsPerMinute: wpm,
      fillerWords: fillers.total,
    },
    visual,
  }, fallback);

  renderList(deliveryList, feedback.delivery);
  renderList(contentList, feedback.content);
  rewriteText.textContent = feedback.suggestedRewrite;
  followupText.textContent = feedback.followupQuestion;
  dashboard.classList.remove("hidden");
  say(feedback.coachResponse, feedback.coachResponse.startsWith("Pause") ? "confused" : "speaking");
}

async function requestCoachFeedback(payload, fallback) {
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`Feedback API returned ${response.status}`);
    return normalizeFeedback(await response.json(), fallback);
  } catch {
    return fallback;
  }
}

function buildLocalFeedback({ fillers, scores, transcript, visual, wpm }) {
  return {
    coachResponse: buildSpokenFeedback(wpm, fillers.total, scores, visual),
    delivery: [
      { label: "Speaking pace", value: paceLabel(wpm), score: paceScore(wpm) },
      { label: "Eye contact", value: visual.eye, score: visual.eyeScore },
      { label: "Filler words", value: `${fillers.total}`, score: fillers.total <= 4 ? 0.9 : fillers.total <= 9 ? 0.55 : 0.25 },
      { label: "Pauses", value: wpm > 165 ? "too few" : "workable", score: wpm > 165 ? 0.35 : 0.75 },
      { label: "Energy", value: visual.movement, score: visual.movementScore },
    ],
    content: [
      { label: "Clear problem", value: `${scores.problem}/10`, score: scores.problem / 10 },
      { label: "Specific user", value: `${scores.user}/10`, score: scores.user / 10 },
      { label: "Demo clarity", value: `${scores.demo}/10`, score: scores.demo / 10 },
      { label: "Impact", value: `${scores.impact}/10`, score: scores.impact / 10 },
      { label: "Call to action", value: scores.cta > 5 ? `${scores.cta}/10` : "missing", score: scores.cta / 10 },
    ],
    suggestedRewrite: buildRewrite(transcript, scores),
    followupQuestion: audienceCopy[state.mode].followup,
  };
}

function normalizeFeedback(feedback, fallback) {
  return {
    coachResponse: feedback.coachResponse || fallback.coachResponse,
    delivery: normalizeRows(feedback.delivery, fallback.delivery),
    content: normalizeRows(feedback.content, fallback.content),
    suggestedRewrite: feedback.suggestedRewrite || fallback.suggestedRewrite,
    followupQuestion: feedback.followupQuestion || fallback.followupQuestion,
  };
}

function normalizeRows(rows, fallbackRows) {
  if (!Array.isArray(rows) || rows.length === 0) return fallbackRows;

  return rows.map((row, index) => {
    if (Array.isArray(row)) {
      return { label: row[0], value: row[1], score: row[2] ?? fallbackRows[index]?.score ?? 0.5 };
    }

    return {
      label: row.label || fallbackRows[index]?.label || "Metric",
      value: row.value || fallbackRows[index]?.value || "--",
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : fallbackRows[index]?.score ?? 0.5,
    };
  });
}

function handleUploadFile() {
  const file = uploadFile.files?.[0];
  clearUploadPreview();
  resetDashboard();

  if (!file) {
    syncUploadControls();
    return;
  }

  uploadStatus.textContent = file.name;
  clearUploadBtn.disabled = false;

  if (isTextFile(file)) {
    const reader = new FileReader();
    reader.onload = () => {
      uploadTranscript.value = cleanTranscriptFile(String(reader.result || ""));
      transcriptEl.textContent = uploadTranscript.value || "Transcript loaded.";
      speechStatus.textContent = "Upload transcript";
      state.uploadDuration = estimateDurationFromTranscript(uploadTranscript.value);
      syncUploadControls();
      say("Transcript loaded. I can analyze this like a practice round.", "listening");
    };
    reader.readAsText(file);
    return;
  }

  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    state.uploadUrl = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    media.controls = true;
    media.src = state.uploadUrl;
    mediaPreview.appendChild(media);
    mediaPreview.classList.remove("hidden");
    state.uploadMedia = media;
    media.addEventListener("loadedmetadata", () => {
      state.uploadDuration = Number.isFinite(media.duration) ? Math.max(Math.round(media.duration), 1) : 60;
      syncUploadControls();
    });
    speechStatus.textContent = "Upload media";
    syncUploadControls();
    say("Media loaded. Add the transcript, then I will give feedback on the pitch.", "listening");
  }
}

function analyzeUpload() {
  const transcript = uploadTranscript.value.trim();

  if (!transcript) {
    say("I need a transcript for content feedback. Paste the words from the pitch, then analyze again.", "confused");
    uploadTranscript.focus();
    return;
  }

  state.transcript = transcript;
  state.interim = "";
  transcriptEl.textContent = transcript;
  speechStatus.textContent = "Upload analyzed";

  const visual = summarizeUploadVisual();
  showFeedback({
    transcript,
    durationSeconds: state.uploadDuration || estimateDurationFromTranscript(transcript),
    visual,
  });
}

function summarizeUploadVisual() {
  const media = state.uploadMedia;
  if (!media || media.tagName !== "VIDEO" || media.readyState < 2) {
    return { eye: "not measured", eyeScore: 0.45, movement: "not measured", movementScore: 0.45 };
  }

  try {
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    const sample = analyzeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
    return {
      eye: sample.eye > 0.7 ? "consistent" : sample.eye > 0.48 ? "inconsistent" : "drifting down or away",
      eyeScore: sample.eye,
      movement: "single-frame sample",
      movementScore: Math.max(sample.movement, 0.45),
    };
  } catch {
    return { eye: "not measured", eyeScore: 0.45, movement: "not measured", movementScore: 0.45 };
  }
}

function clearUpload() {
  uploadFile.value = "";
  uploadTranscript.value = "";
  uploadStatus.textContent = "No file";
  state.uploadDuration = 60;
  clearUploadPreview();
  syncUploadControls();
}

function clearUploadPreview() {
  if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
  state.uploadUrl = "";
  state.uploadMedia = null;
  mediaPreview.innerHTML = "";
  mediaPreview.classList.add("hidden");
}

function syncUploadControls() {
  const hasFile = Boolean(uploadFile.files?.[0]);
  const hasTranscript = Boolean(uploadTranscript.value.trim());
  analyzeUploadBtn.disabled = !hasFile && !hasTranscript;
  clearUploadBtn.disabled = !hasFile && !hasTranscript;
}

function isTextFile(file) {
  return file.type.startsWith("text/") || /\.(txt|md|vtt|srt)$/i.test(file.name);
}

function cleanTranscriptFile(value) {
  return value
    .replace(/WEBVTT/gi, "")
    .replace(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g, "")
    .replace(/^\d+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function estimateDurationFromTranscript(transcript) {
  const words = transcript.match(/\b[\w'-]+\b/g) || [];
  return Math.max(Math.round((words.length / 145) * 60), 20);
}

function summarizeVision() {
  if (!state.samples.length) {
    return { eye: "not measured", eyeScore: 0.4, movement: "not measured", movementScore: 0.4 };
  }

  const average = (key) => state.samples.reduce((sum, item) => sum + item[key], 0) / state.samples.length;
  const eye = average("eye");
  const movement = average("movement");

  return {
    eye: eye > 0.7 ? "consistent" : eye > 0.48 ? "inconsistent" : "drifting down or away",
    eyeScore: eye,
    movement: movement > 0.3 ? "expressive" : movement > 0.12 ? "natural" : "flat ending",
    movementScore: Math.min(movement * 2.4, 1),
  };
}

function scoreContent(transcript) {
  const text = transcript.toLowerCase();
  const has = (terms) => terms.some((term) => text.includes(term));
  const problem = 3 + (has(["problem", "struggle", "pain", "hard", "waste", "miss", "too late"]) ? 4 : 0) + (has(["because", "so that", "which means"]) ? 2 : 0);
  const user = 3 + (has(["student", "founder", "judge", "teacher", "developer", "team", "customer", "user"]) ? 4 : 0) + (has(["for ", "when they", "who "]) ? 1 : 0);
  const demo = 3 + (has(["demo", "shows", "watch", "listen", "real time", "feedback", "dashboard"]) ? 4 : 0) + (has(["example", "for instance"]) ? 1 : 0);
  const impact = 2 + (has(["before", "improve", "save", "confidence", "better", "faster", "practice"]) ? 4 : 0) + (has(["high-stakes", "interview", "presentation", "pitch"]) ? 2 : 0);
  const cta = 2 + (has(["try", "use", "join", "next", "ask", "looking for", "we need"]) ? 5 : 0);

  return {
    problem: clampScore(problem),
    user: clampScore(user),
    demo: clampScore(demo),
    impact: clampScore(impact),
    cta: clampScore(cta),
  };
}

function buildRewrite(transcript, scores) {
  if (scores.problem < 6 || scores.user < 6) {
    return "Instead of starting with the technology, start with the person: 'Students practicing important presentations usually get feedback too late. PitchMirror watches and listens in real time, then tells them what the audience actually heard and saw.'";
  }

  if (scores.cta < 6) {
    return "Keep your current opening, then end with a clear ask: 'Today we want judges to test a 60-second pitch and tell us whether the feedback feels like a real coach.'";
  }

  return "Tighten the strongest version into one sentence: 'PitchMirror is a live AI audience member that helps students and founders fix delivery and content before the real room is watching.'";
}

function buildSpokenFeedback(wpm, fillers, scores, visual) {
  if (scores.problem < 6) {
    return "Pause. Your pitch needs a clearer pain point. Start with who is struggling, then explain what changes when your product works.";
  }
  if (wpm > 170) {
    return `You are speaking clearly, but the pace is fast at about ${wpm} words per minute. Add a pause after your main problem sentence.`;
  }
  if (fillers > 8) {
    return `You used ${fillers} filler words. Replace them with short pauses, especially before the demo explanation.`;
  }
  if (visual.eyeScore < 0.5) {
    return "The content is landing, but your camera presence is inconsistent. Look into the camera during your strongest sentence.";
  }
  return "Much better. The structure is clear. Now add one concrete proof point so a judge remembers why this matters.";
}

function countFillers(transcript) {
  const matches = transcript.toLowerCase().match(/\b(um|uh|like|basically|actually|literally|kind of|sort of|you know)\b/g) || [];
  return { total: matches.length, matches };
}

function renderList(target, rows) {
  target.innerHTML = "";
  rows.forEach(({ label, value, score }) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${label}</span><strong class="${score > 0.66 ? "good" : score > 0.4 ? "warn" : "bad"}">${value}</strong>`;
    target.appendChild(item);
  });
}

function say(message, expression) {
  coachMessage.textContent = message;
  avatar.className = `avatar ${expression}`;

  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 0.98;
  utterance.pitch = 0.95;
  utterance.onend = () => {
    if (avatar.classList.contains("speaking")) avatar.className = "avatar listening";
  };
  window.speechSynthesis.speak(utterance);
}

function resetDashboard() {
  dashboard.classList.add("hidden");
  deliveryList.innerHTML = "";
  contentList.innerHTML = "";
  rewriteText.textContent = "";
  followupText.textContent = "";
  coachMessage.dataset.interrupted = "";
}

function getElapsedSeconds() {
  return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
}

function formatTime(seconds) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function paceLabel(wpm) {
  if (wpm > 180) return `${wpm} wpm, too fast`;
  if (wpm > 155) return `${wpm} wpm, slightly fast`;
  if (wpm < 95) return `${wpm} wpm, slow`;
  return `${wpm} wpm, clear`;
}

function paceScore(wpm) {
  if (wpm >= 110 && wpm <= 155) return 0.9;
  if (wpm >= 95 && wpm <= 180) return 0.58;
  return 0.28;
}

function clampScore(value) {
  return Math.max(1, Math.min(10, value));
}

function samplePitch() {
  return "So basically we made an AI thing that uses vision and audio and it is kind of like a coach. It watches and listens in real time and gives feedback for presentations.";
}
