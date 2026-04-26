const camera = document.querySelector("#camera");
const canvas = document.querySelector("#visionCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const trackingOverlay = document.querySelector("#trackingOverlay");
const overlayCtx = trackingOverlay.getContext("2d");
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
const eyeFeedback = document.querySelector("#eyeFeedback");
const positionSignal = document.querySelector("#positionSignal");
const lightingSignal = document.querySelector("#lightingSignal");
const movementSignal = document.querySelector("#movementSignal");
const volumeSignal = document.querySelector("#volumeSignal");
const energySignal = document.querySelector("#energySignal");
const pitchSignal = document.querySelector("#pitchSignal");
const pauseSignal = document.querySelector("#pauseSignal");
const audioFeedback = document.querySelector("#audioFeedback");
const coachSignal = document.querySelector("#coachSignal");
const presentationType = document.querySelector("#presentationType");
const audienceType = document.querySelector("#audienceType");
const coachingIntensity = document.querySelector("#coachingIntensity");
const uploadFile = document.querySelector("#uploadFile");
const uploadStatus = document.querySelector("#uploadStatus");
const uploadTranscript = document.querySelector("#uploadTranscript");
const analyzeUploadBtn = document.querySelector("#analyzeUploadBtn");
const clearUploadBtn = document.querySelector("#clearUploadBtn");
const mediaPreview = document.querySelector("#mediaPreview");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MEDIAPIPE_VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MEDIAPIPE_MODEL_ASSET = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const state = {
  context: {
    presentationType: "pitch",
    audienceType: "general",
    coachingIntensity: "balanced",
  },
  stream: null,
  recognition: null,
  listeningPausedForCoach: false,
  faceLandmarker: null,
  faceLandmarkerReady: false,
  faceLandmarkerError: "",
  faceLandmarkerPromise: null,
  faceDetector: null,
  startedAt: 0,
  timerId: null,
  visionId: null,
  audioId: null,
  transcript: "",
  interim: "",
  samples: [],
  audioSamples: [],
  transcriptEvents: [],
  liveEvents: [],
  interruption: {
    lastAtSeconds: -999,
    offTrackHits: 0,
    technicalHits: 0,
    lastReason: "",
  },
  lastFrame: null,
  lastGazeBias: 0,
  lastEyeMid: null,
  lastFaceCenter: null,
  eyeAlertUntil: 0,
  eyeRecentLevel: 0,
  audioContext: null,
  audioAnalyser: null,
  audioSource: null,
  audioData: null,
  lastSpeechAt: 0,
  lastSilentAt: 0,
  pauseMoments: [],
  recentPauseMs: 0,
  recentPitch: 0,
  recentPitchDelta: 0,
  speechActive: false,
  uploadUrl: "",
  uploadDuration: 60,
  uploadMedia: null,
};

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
retryBtn.addEventListener("click", resetSession);
presentationType.addEventListener("change", updateContext);
audienceType.addEventListener("change", updateContext);
coachingIntensity.addEventListener("change", updateContext);
uploadFile.addEventListener("change", handleUploadFile);
uploadTranscript.addEventListener("input", syncUploadControls);
analyzeUploadBtn.addEventListener("click", analyzeUpload);
clearUploadBtn.addEventListener("click", clearUpload);

async function startSession() {
  resetDashboard();
  updateContext();
  state.transcript = "";
  state.interim = "";
  state.samples = [];
  state.audioSamples = [];
  state.transcriptEvents = [];
  state.liveEvents = [];
  resetInterruptionState();
  resetAudioTrackingState();
  state.startedAt = Date.now();
  transcriptEl.textContent = "";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  retryBtn.disabled = true;

  await startCamera();
  initFaceLandmarker();
  startSpeech();
  startTimer();
  startVisionLoop();
  showCoachText(buildStartMessage(), "nodding");
}

function updateContext() {
  state.context = {
    presentationType: presentationType.value,
    audienceType: audienceType.value,
    coachingIntensity: coachingIntensity.value,
  };
}

function buildStartMessage() {
  const presentation = presentationType.options[presentationType.selectedIndex].text.toLowerCase();
  const audience = audienceType.options[audienceType.selectedIndex].text.toLowerCase();
  return `Start your ${presentation}. I will listen as a ${audience} and track delivery, content, pacing, and camera presence.`;
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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    camera.srcObject = state.stream;
    cameraStatus.textContent = "Camera on";
    startAudioAnalysis();
  } catch (error) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      camera.srcObject = state.stream;
      cameraStatus.textContent = "Camera on";
      audioFeedback.textContent = "Microphone unavailable";
    } catch {
      cameraStatus.textContent = "Camera unavailable";
      addVisionSample({ lighting: 0, movement: 0, centered: 0, eye: 0 });
    }
  }
}

function initFaceLandmarker() {
  if (state.faceLandmarker || state.faceLandmarkerPromise) return state.faceLandmarkerPromise;

  state.faceLandmarkerPromise = (async () => {
    try {
      const visionModule = await import(`${MEDIAPIPE_VISION_BUNDLE}/vision_bundle.mjs`);
      const { FilesetResolver, FaceLandmarker } = visionModule;
      const vision = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_VISION_BUNDLE}/wasm`);
      state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE_MODEL_ASSET },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
      state.faceLandmarkerReady = true;
      state.faceLandmarkerError = "";
    } catch (error) {
      state.faceLandmarkerReady = false;
      state.faceLandmarkerError = String(error?.message || error || "MediaPipe unavailable");
    } finally {
      state.faceLandmarkerPromise = null;
    }
  })();

  return state.faceLandmarkerPromise;
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
    if (finalText) {
      state.transcriptEvents.push({
        atSeconds: getElapsedSeconds(),
        text: finalText.trim(),
        type: "final",
      });
    }
    state.interim = interimText;
    renderTranscript();
    maybeInterrupt();
  };

  recognition.onerror = () => {
    speechStatus.textContent = "Speech paused";
  };

  recognition.onend = () => {
    if (stopBtn.disabled === false && !state.listeningPausedForCoach) {
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

function startAudioAnalysis() {
  if (!state.stream?.getAudioTracks().length) {
    audioFeedback.textContent = "Microphone stream unavailable";
    return;
  }
  if (state.audioAnalyser) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    audioFeedback.textContent = "Audio analysis unsupported";
    return;
  }

  try {
    state.audioContext = new AudioContextClass();
    state.audioSource = state.audioContext.createMediaStreamSource(state.stream);
    state.audioAnalyser = state.audioContext.createAnalyser();
    state.audioAnalyser.fftSize = 2048;
    state.audioAnalyser.smoothingTimeConstant = 0.72;
    state.audioData = new Float32Array(state.audioAnalyser.fftSize);
    state.audioSource.connect(state.audioAnalyser);
    state.lastSilentAt = performance.now();
    startAudioLoop();
  } catch {
    audioFeedback.textContent = "Microphone analysis unavailable";
  }
}

function startAudioLoop() {
  const loop = () => {
    if (!state.audioAnalyser || !state.audioData) return;
    state.audioAnalyser.getFloatTimeDomainData(state.audioData);
    const sample = analyzeAudioFrame(state.audioData, state.audioContext?.sampleRate || 48000);
    addAudioSample(sample);
    renderAudioSignals(sample);
    state.audioId = requestAnimationFrame(loop);
  };

  loop();
}

function startVisionLoop() {
  const loop = async () => {
    if (!state.stream || camera.readyState < 2) {
      state.visionId = requestAnimationFrame(loop);
      return;
    }

    ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sample = await analyzeFrame(frame);
    addVisionSample(sample);
    renderSignals(sample);
    state.visionId = requestAnimationFrame(loop);
  };

  loop();
}

async function analyzeFrame(frame) {
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
  const horizontalBias = (right - left) / Math.max(left + right, 1);
  const drift = Math.min(Math.abs(horizontalBias) * 1.3 + (1 - centered) * 0.9, 1);
  const focusX = canvas.width * (0.5 + horizontalBias * 0.18);
  const focusY = canvas.height * (0.46 - Math.min(Math.max((top / Math.max(total, 1)) - 0.5, -0.12), 0.12));
  const boxWidth = canvas.width * (0.2 + centered * 0.22);
  const boxHeight = boxWidth * 1.18;
  const heuristic = {
    lighting,
    movement,
    centered,
    eye,
    drift,
    focusX,
    focusY,
    boxWidth,
    boxHeight,
    horizontalBias,
    faceDetected: false,
    faceDetectorActive: false,
    trackingMode: "heuristic",
  };
  const detected = await detectFaceSample();
  return detected ? { ...heuristic, ...detected } : heuristic;
}

function addVisionSample(sample) {
  const now = Date.now();
  Object.assign(sample, computeRecentEyeActivity(sample, now));
  state.samples.push({ ...sample, at: now, atSeconds: getElapsedSeconds() });
  if (state.samples.length > 600) state.samples.shift();
}

function analyzeAudioFrame(buffer, sampleRate) {
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  const db = 20 * Math.log10(Math.max(rms, 0.00001));
  const voiced = rms > 0.018;
  const pitchHz = voiced ? detectPitch(buffer, sampleRate) : 0;
  const now = performance.now();

  if (voiced) {
    if (!state.speechActive && state.lastSilentAt) {
      const pauseMs = now - state.lastSilentAt;
      if (pauseMs > 220) {
        state.pauseMoments.push(pauseMs);
        if (state.pauseMoments.length > 18) state.pauseMoments.shift();
        state.recentPauseMs = pauseMs;
      }
    }
    state.lastSpeechAt = now;
  } else if (state.speechActive) {
    state.lastSilentAt = now;
  }

  state.speechActive = voiced;
  const pitchDelta = pitchHz && state.recentPitch ? Math.abs(pitchHz - state.recentPitch) : 0;
  if (pitchHz) {
    state.recentPitch = pitchHz;
    state.recentPitchDelta = pitchDelta;
  }

  return { rms, db, peak, voiced, pitchHz, pitchDelta, pauseMs: state.recentPauseMs, atSeconds: getElapsedSeconds() };
}

function addAudioSample(sample) {
  state.audioSamples.push({ ...sample, at: Date.now() });
  if (state.audioSamples.length > 600) state.audioSamples.shift();
}

function renderSignals(sample) {
  signalStatus.textContent = sample.faceDetectorActive && !sample.faceDetected
    ? "Searching face"
    : sample.trackingMode === "mediapipe"
      ? "Tracking face mesh"
      : "Tracking";
  setMetric(eyeSignal, eyeMovementLabel(sample), eyeMovementScore(sample));
  eyeFeedback.textContent = eyeMovementFeedback(sample);
  setMetric(positionSignal, facePositionLabel(sample), sample.faceDetectorActive && !sample.faceDetected ? 0.2 : sample.centered);
  setMetric(lightingSignal, sample.lighting > 84 ? "clear" : sample.lighting > 48 ? "dim" : "too dark", sample.lighting / 120);
  setMetric(movementSignal, headMovementLabel(sample), headMovementScore(sample));
  renderTrackingOverlay(sample);
}

function renderAudioSignals(sample) {
  setMetric(volumeSignal, volumeLabel(sample.db), volumeScore(sample.db));
  setMetric(energySignal, energyLabel(sample), energyScore(sample));
  setMetric(pitchSignal, pitchLabel(sample), pitchScore(sample));
  setMetric(pauseSignal, pauseLabel(sample), pauseScore(sample));
  audioFeedback.textContent = audioFeedbackText(sample);
}

function setMetric(element, text, score) {
  element.textContent = text;
  element.className = score > 0.66 ? "good" : score > 0.4 ? "warn" : "bad";
}

function stopSession() {
  const wasRunning = stopBtn.disabled === false;
  state.listeningPausedForCoach = false;

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
  cancelAnimationFrame(state.audioId);
  if (wasRunning) showFeedback();
}

function resetSession() {
  if (stopBtn.disabled === false) stopSession();
  state.transcript = "";
  state.interim = "";
  state.listeningPausedForCoach = false;
  state.samples = [];
  state.audioSamples = [];
  state.lastFrame = null;
  state.lastGazeBias = 0;
  state.lastEyeMid = null;
  state.lastFaceCenter = null;
  state.eyeAlertUntil = 0;
  state.eyeRecentLevel = 0;
  resetAudioTrackingState();
  transcriptEl.textContent = "Your pitch transcript will appear here as you speak.";
  timerEl.textContent = "00:00";
  speechStatus.textContent = "Speech idle";
  signalStatus.textContent = "Waiting";
  eyeSignal.textContent = "--";
  eyeFeedback.textContent = "Waiting for camera";
  positionSignal.textContent = "--";
  lightingSignal.textContent = "--";
  movementSignal.textContent = "--";
  volumeSignal.textContent = "--";
  energySignal.textContent = "--";
  pitchSignal.textContent = "--";
  pauseSignal.textContent = "--";
  audioFeedback.textContent = "Waiting for microphone";
  coachSignal.textContent = "waiting";
  coachSignal.className = "";
  clearTrackingOverlay();
  resetDashboard();
  say("Ready when you are. Start with the person who has the problem.", "listening");
}

function resetAudioTrackingState() {
  state.lastSpeechAt = 0;
  state.lastSilentAt = 0;
  state.pauseMoments = [];
  state.recentPauseMs = 0;
  state.recentPitch = 0;
  state.recentPitchDelta = 0;
  state.speechActive = false;
}

function renderTranscript() {
  const text = `${state.transcript}${state.interim ? ` ${state.interim}` : ""}`.trim();
  transcriptEl.textContent = text || "Listening...";
}

function maybeInterrupt() {
  if (state.context.coachingIntensity === "quiet") return;

  const elapsed = getElapsedSeconds();
  const text = `${state.transcript} ${state.interim}`.toLowerCase();
  const wordCount = (text.match(/\b[\w'-]+\b/g) || []).length;
  const thresholds = getInterruptionThresholds();

  if (elapsed < thresholds.minSeconds || wordCount < thresholds.minWords) return;
  if (elapsed - state.interruption.lastAtSeconds < thresholds.cooldownSeconds) return;

  const technicalOpen = /\b(api|model|infrastructure|stack|database|framework|algorithm|multimodal)\b/.test(text);
  const humanWords = /\b(student|founder|user|customer|teacher|developer|patient|team|people)\b/.test(text);
  const offTrack = detectOffTrack(text);

  if (offTrack) {
    setMetric(coachSignal, "possible tangent", 0.35);
    state.interruption.offTrackHits = offTrack.reason === state.interruption.lastReason ? state.interruption.offTrackHits + 1 : 1;
    state.interruption.technicalHits = 0;
    state.interruption.lastReason = offTrack.reason;

    if (state.interruption.offTrackHits >= thresholds.requiredHits) {
      const message = buildOffTrackInterruption(offTrack);
      recordInterruption(elapsed, "off-track-interruption", offTrack.reason, message);
      interruptWithCoachSpeech(message);
    }
    return;
  }

  if (technicalOpen && !humanWords) {
    setMetric(coachSignal, "too technical", 0.45);
    state.interruption.technicalHits += 1;
    state.interruption.offTrackHits = 0;
    state.interruption.lastReason = "too-technical";

    if (state.interruption.technicalHits >= thresholds.requiredHits) {
      const message = "Pause. I am hearing the build, but not the person. Who struggles with this, and why now?";
      recordInterruption(elapsed, "technical-interruption", "too-technical", message);
      interruptWithCoachSpeech(message);
    }
    return;
  }

  decayInterruptionEvidence();
  setMetric(coachSignal, "on track", 0.8);
}

function getInterruptionThresholds() {
  if (state.context.coachingIntensity === "interrupt") {
    return { minSeconds: 10, minWords: 22, requiredHits: 2, cooldownSeconds: 22 };
  }

  return { minSeconds: 16, minWords: 32, requiredHits: 2, cooldownSeconds: 30 };
}

function recordInterruption(elapsed, type, reason, message) {
  state.interruption.lastAtSeconds = elapsed;
  state.interruption.offTrackHits = 0;
  state.interruption.technicalHits = 0;
  state.interruption.lastReason = "";
  state.liveEvents.push({ atSeconds: elapsed, type, reason, message });
}

function decayInterruptionEvidence() {
  state.interruption.offTrackHits = Math.max(0, state.interruption.offTrackHits - 1);
  state.interruption.technicalHits = Math.max(0, state.interruption.technicalHits - 1);
  if (!state.interruption.offTrackHits && !state.interruption.technicalHits) {
    state.interruption.lastReason = "";
  }
}

function resetInterruptionState() {
  state.interruption = {
    lastAtSeconds: -999,
    offTrackHits: 0,
    technicalHits: 0,
    lastReason: "",
  };
}

function detectOffTrack(text) {
  const hasPresentationFrame = /\b(presenting|presentation|pitch|project|topic|today|talking about|speaking about)\b/.test(text);
  const politicalDetour = /\b(donald trump|joe biden|republican|democrat|maga|election|politics|president)\b/.test(text);
  const celebrityDetour = /\b(taylor swift|kanye|celebrity|movie star|famous actor)\b/.test(text);
  const personalDetour = /\b(i love|i hate|my favorite|randomly|anyway)\b/.test(text);
  const presentationKeywords = expectedTopicKeywords(state.context.presentationType);
  const topicMatches = presentationKeywords.filter((keyword) => text.includes(keyword)).length;
  const enoughWords = (text.match(/\b[\w'-]+\b/g) || []).length > 12;

  if (hasPresentationFrame && politicalDetour) {
    return { reason: "political-detour", severity: "high" };
  }

  if (hasPresentationFrame && (celebrityDetour || personalDetour) && enoughWords && topicMatches < 2) {
    return { reason: "personal-detour", severity: "medium" };
  }

  return null;
}

function buildOffTrackInterruption(offTrack) {
  if (offTrack.reason === "political-detour") {
    return "Pause. That sounds off track for this presentation. Bring it back to your project, the audience problem, and the point you want them to remember.";
  }

  return "Pause. I am losing the thread. Connect this back to your main point, or cut it and return to the audience problem.";
}

function expectedTopicKeywords(type) {
  const shared = ["problem", "audience", "point", "example", "impact", "because", "solution"];
  const byType = {
    pitch: ["project", "product", "user", "customer", "demo", "market", "need"],
    "class-presentation": ["topic", "definition", "concept", "evidence", "argument", "lesson"],
    "interview-answer": ["experience", "example", "tradeoff", "team", "result", "learned"],
    "sales-demo": ["customer", "pain", "workflow", "demo", "value", "next step"],
    "team-update": ["status", "progress", "risk", "blocker", "next", "timeline"],
    teaching: ["concept", "definition", "example", "students", "learn", "remember"],
    speech: ["story", "message", "audience", "moment", "thanks", "remember"],
    custom: [],
  };

  return [...shared, ...(byType[type] || [])];
}

async function showFeedback(source = {}) {
  const elapsed = Math.max(source.durationSeconds || getElapsedSeconds(), 1);
  const transcript = source.transcript || `${state.transcript} ${state.interim}`.trim() || samplePitch();
  const words = transcript.match(/\b[\w'-]+\b/g) || [];
  const fillers = countFillers(transcript);
  const wpm = Math.round((words.length / elapsed) * 60);
  const visual = source.visual || summarizeVision();
  const audio = source.audio || summarizeAudio();
  const scores = scoreContent(transcript);
  const fallback = buildLocalFeedback({ audio, fillers, scores, transcript, visual, wpm });
  const feedback = await requestCoachFeedback({
    context: state.context,
    transcript,
    durationSeconds: elapsed,
    delivery: {
      wordsPerMinute: wpm,
      fillerWords: fillers.total,
    },
    visual,
    audio,
    timeline: buildSessionTimeline(transcript, elapsed, fillers, wpm, visual, audio),
  }, fallback);

  renderList(deliveryList, feedback.delivery);
  renderList(contentList, feedback.content);
  rewriteText.textContent = feedback.suggestedRewrite;
  followupText.textContent = feedback.followupQuestion;
  dashboard.classList.remove("hidden");
  say(feedback.coachResponse, feedback.avatarState);
}

function buildSessionTimeline(transcript, durationSeconds, fillers, wpm, visual, audio) {
  return {
    durationSeconds,
    transcriptEvents: state.transcriptEvents.slice(-30),
    liveCoachEvents: state.liveEvents.slice(-10),
    visualSamples: summarizeVisualTimeline(),
    audioSamples: summarizeAudioTimeline(),
    audioSummary: {
      wordsPerMinute: wpm,
      fillerWords: fillers.total,
      fillerTerms: fillers.matches.slice(0, 20),
      estimatedWords: (transcript.match(/\b[\w'-]+\b/g) || []).length,
      ...audio,
    },
    visualSummary: visual,
  };
}

function summarizeVisualTimeline() {
  const bucketSize = 5;
  const buckets = new Map();

  state.samples.forEach((sample) => {
    const bucket = Math.floor((sample.atSeconds || 0) / bucketSize) * bucketSize;
    const current = buckets.get(bucket) || { count: 0, eye: 0, drift: 0, centered: 0, lighting: 0, movement: 0 };
    current.count += 1;
    current.eye += sample.eye;
    current.drift += sample.drift || 0;
    current.centered += sample.centered;
    current.lighting += sample.lighting;
    current.movement += sample.movement;
    buckets.set(bucket, current);
  });

  return [...buckets.entries()].slice(-18).map(([startSecond, bucket]) => ({
    startSecond,
    endSecond: startSecond + bucketSize,
    eyeScore: roundMetric(bucket.eye / bucket.count),
    eyeDrift: roundMetric((bucket.drift || 0) / bucket.count),
    centeredScore: roundMetric(bucket.centered / bucket.count),
    lighting: Math.round(bucket.lighting / bucket.count),
    movementScore: roundMetric(bucket.movement / bucket.count),
  }));
}

function summarizeAudioTimeline() {
  const bucketSize = 5;
  const buckets = new Map();

  state.audioSamples.forEach((sample) => {
    const bucket = Math.floor((sample.atSeconds || 0) / bucketSize) * bucketSize;
    const current = buckets.get(bucket) || { count: 0, db: 0, peak: 0, voiced: 0, pitchDelta: 0 };
    current.count += 1;
    current.db += sample.db;
    current.peak += sample.peak;
    current.voiced += sample.voiced ? 1 : 0;
    current.pitchDelta += sample.pitchDelta || 0;
    buckets.set(bucket, current);
  });

  return [...buckets.entries()].slice(-18).map(([startSecond, bucket]) => ({
    startSecond,
    endSecond: startSecond + bucketSize,
    averageDb: Math.round(bucket.db / bucket.count),
    energyScore: roundMetric(Math.min((bucket.peak / bucket.count) * 4, 1)),
    voicedRatio: roundMetric(bucket.voiced / bucket.count),
    pitchDelta: Math.round(bucket.pitchDelta / bucket.count),
  }));
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

function buildLocalFeedback({ audio, fillers, scores, transcript, visual, wpm }) {
  return {
    coachResponse: buildSpokenFeedback(wpm, fillers.total, scores, visual, audio),
    avatarState: scores.problem < 6 || scores.user < 6 ? "confused" : "speaking",
    delivery: [
      { label: "Speaking pace", value: paceLabel(wpm), score: paceScore(wpm) },
      { label: "Eye contact", value: visual.eye, score: visual.eyeScore },
      { label: "Volume", value: audio.volume, score: audio.volumeScore },
      { label: "Pause rhythm", value: audio.pause, score: audio.pauseScore },
      { label: "Filler words", value: `${fillers.total}`, score: fillers.total <= 4 ? 0.9 : fillers.total <= 9 ? 0.55 : 0.25 },
    ],
    content: [
      { label: "Clear problem", value: `${scores.problem}/10`, score: scores.problem / 10 },
      { label: "Specific user", value: `${scores.user}/10`, score: scores.user / 10 },
      { label: "Demo clarity", value: `${scores.demo}/10`, score: scores.demo / 10 },
      { label: "Impact", value: `${scores.impact}/10`, score: scores.impact / 10 },
      { label: "Call to action", value: scores.cta > 5 ? `${scores.cta}/10` : "missing", score: scores.cta / 10 },
    ],
    suggestedRewrite: buildRewrite(transcript, scores),
    followupQuestion: followupForContext(state.context),
  };
}

function normalizeFeedback(feedback, fallback) {
  return {
    coachResponse: feedback.coachResponse || fallback.coachResponse,
    avatarState: ["listening", "nodding", "confused", "speaking"].includes(feedback.avatarState) ? feedback.avatarState : fallback.avatarState,
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

async function analyzeUpload() {
  const transcript = uploadTranscript.value.trim();

  if (!transcript) {
    say("I need a transcript for content feedback. Paste the words from the pitch, then analyze again.", "confused");
    uploadTranscript.focus();
    return;
  }

  state.transcript = transcript;
  state.interim = "";
  state.transcriptEvents = [{ atSeconds: 0, text: transcript, type: "upload" }];
  state.liveEvents = [];
  resetInterruptionState();
  transcriptEl.textContent = transcript;
  speechStatus.textContent = "Upload analyzed";

  const visual = await summarizeUploadVisual();
  showFeedback({
    transcript,
    durationSeconds: state.uploadDuration || estimateDurationFromTranscript(transcript),
    visual,
  });
}

async function summarizeUploadVisual() {
  const media = state.uploadMedia;
  if (!media || media.tagName !== "VIDEO" || media.readyState < 2) {
    return { eye: "not measured", eyeScore: 0.45, movement: "not measured", movementScore: 0.45 };
  }

  try {
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    const sample = await analyzeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
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
  const drift = average("drift");
  const movement = average("movement");

  return {
    eye: drift < 0.22 ? "steady lock" : drift < 0.45 ? "small scans" : "noticeable drift",
    eyeScore: Math.max(0, Math.min(1 - drift * 0.85, 1)),
    movement: movement > 0.3 ? "expressive" : movement > 0.12 ? "natural" : "flat ending",
    movementScore: Math.min(movement * 2.4, 1),
  };
}

function summarizeAudio() {
  if (!state.audioSamples.length) {
    return {
      volume: "not measured",
      volumeScore: 0.4,
      energy: "not measured",
      energyScore: 0.4,
      pitch: "not measured",
      pitchScore: 0.4,
      pause: "not measured",
      pauseScore: 0.4,
    };
  }

  const average = (key, filter = () => true) => {
    const relevant = state.audioSamples.filter(filter);
    if (!relevant.length) return 0;
    return relevant.reduce((sum, item) => sum + (item[key] || 0), 0) / relevant.length;
  };
  const avgDb = average("db");
  const avgPeak = average("peak");
  const avgPitchDelta = average("pitchDelta", (item) => item.pitchHz > 0);
  const avgPause = state.pauseMoments.length
    ? state.pauseMoments.reduce((sum, item) => sum + item, 0) / state.pauseMoments.length
    : 0;

  return {
    volume: volumeLabel(avgDb),
    volumeScore: volumeScore(avgDb),
    energy: avgPeak > 0.16 ? "animated" : avgPeak > 0.09 ? "steady" : "flat",
    energyScore: avgPeak > 0.16 ? 0.88 : avgPeak > 0.09 ? 0.62 : 0.34,
    pitch: avgPitchDelta > 28 ? "varied" : avgPitchDelta > 12 ? "moderate" : "monotone",
    pitchScore: avgPitchDelta > 28 ? 0.86 : avgPitchDelta > 12 ? 0.6 : 0.32,
    pause: avgPause > 1100 ? "long gaps" : avgPause > 420 ? "healthy pauses" : "few pauses",
    pauseScore: avgPause > 1100 ? 0.34 : avgPause > 420 ? 0.84 : 0.46,
  };
}

function followupForContext(context) {
  if (context.presentationType === "interview-answer") return "What tradeoff did you make, and what would you change with another week?";
  if (context.audienceType === "investor") return "Who urgently needs this, and why will they choose you over the current workaround?";
  if (context.presentationType === "teaching") return "What concept should your audience remember five minutes after you finish?";
  if (context.presentationType === "sales-demo") return "What customer pain does the demo prove you can solve today?";
  return "What is the one sentence you want this audience to remember?";
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

function buildSpokenFeedback(wpm, fillers, scores, visual, audio = {}) {
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
  if (audio.volumeScore < 0.4) {
    return "The structure is clear, but your volume is low. Push a little more air through your strongest sentence.";
  }
  if (audio.pitchScore < 0.4) {
    return "The message is clear, but the delivery sounds narrow. Add more rise and fall to highlight the important idea.";
  }
  return "Much better. The structure is clear. Now add one concrete proof point so a judge remembers why this matters.";
}

function countFillers(transcript) {
  const matches = transcript.toLowerCase().match(/\b(um|uh|like|basically|actually|literally|kind of|sort of|you know)\b/g) || [];
  return { total: matches.length, matches };
}

function eyeMovementLabel(sample) {
  if (sample.faceDetectorActive && !sample.faceDetected) return "searching";
  if (sample.isBlinking) return "blink";
  const level = effectiveEyeLevel(sample);
  if (level < 0.09 && (sample.eyeMotion ?? 0) < 0.06 && !sample.recentAlert) return "locked";
  if (level < 0.22) return "tracking";
  return "drifting";
}

function eyeMovementFeedback(sample) {
  if (sample.faceDetectorActive && !sample.faceDetected) {
    return "No face lock right now. Move back into frame so the tracker stops grabbing the background.";
  }
  if (sample.isBlinking) {
    return "Blink detected. This is ignored so normal blinking does not count as drifting.";
  }
  if (sample.recentAlert) {
    return sample.recentDirection > 0
      ? "A moment ago your eye line drifted to camera right. Re-lock on the lens."
      : "A moment ago your eye line drifted to camera left. Re-lock on the lens.";
  }
  if (sample.trackingMode === "mediapipe") {
    if (effectiveEyeLevel(sample) < 0.09 && (sample.eyeMotion ?? 0) < 0.06) return "Face mesh lock is steady. Your eye line is staying close to the lens.";
    if ((sample.eyeMotion ?? 0) > 0.14) return "Face mesh sees active eye movement while your face stays mostly locked.";
    if (effectiveEyeLevel(sample) < 0.22) return sample.horizontalBias > 0
      ? "Face mesh sees a small drift to camera right, then a return."
      : "Face mesh sees a small drift to camera left, then a return.";
    return sample.horizontalBias > 0
      ? "Face mesh is locked, but your eye line is pulling to camera right."
      : "Face mesh is locked, but your eye line is pulling to camera left.";
  }
  if (sample.trackingMode === "face") {
    if (sample.drift < 0.18) return "Face lock is steady. This tracks head and eye-region drift, not exact pupil gaze.";
    if (sample.drift < 0.38) return sample.horizontalBias > 0
      ? "Face lock is live. You are leaning a bit to camera right, then coming back."
      : "Face lock is live. You are leaning a bit to camera left, then coming back.";
    return sample.horizontalBias > 0
      ? "Face lock is still on you, but your head and eye line are drifting to camera right."
      : "Face lock is still on you, but your head and eye line are drifting to camera left.";
  }
  if (sample.drift < 0.22) return "Tracking box is holding steady. Your eyes are staying near the lens.";
  if (sample.drift < 0.45) return sample.horizontalBias > 0
    ? "Small scan to camera right. Settle back on the lens after each thought."
    : "Small scan to camera left. Settle back on the lens after each thought.";
  return sample.horizontalBias > 0
    ? "Noticeable drift to camera right. Re-center before your next key point."
    : "Noticeable drift to camera left. Re-center before your next key point.";
}

function renderTrackingOverlay(sample) {
  if (!overlayCtx) return;

  overlayCtx.clearRect(0, 0, trackingOverlay.width, trackingOverlay.height);
  if (sample.faceDetectorActive && !sample.faceDetected) {
    overlayCtx.strokeStyle = "#94a3b8";
    overlayCtx.lineWidth = 1.2;
    overlayCtx.setLineDash([6, 6]);
    overlayCtx.strokeRect(trackingOverlay.width * 0.3, trackingOverlay.height * 0.16, trackingOverlay.width * 0.4, trackingOverlay.height * 0.56);
    overlayCtx.setLineDash([]);
    overlayCtx.fillStyle = "#e2e8f0";
    overlayCtx.font = "700 11px Inter, sans-serif";
    overlayCtx.fillText("SEARCHING FOR FACE", trackingOverlay.width * 0.3, trackingOverlay.height * 0.14);
    return;
  }

  const score = Math.max(0, Math.min(1 - effectiveEyeLevel(sample), 1));
  const stroke = score > 0.7 ? "#22c55e" : score > 0.45 ? "#f59e0b" : "#ef4444";
  const x = Math.max(12, Math.min(sample.focusX - sample.boxWidth / 2, trackingOverlay.width - sample.boxWidth - 12));
  const y = Math.max(12, Math.min(sample.focusY - sample.boxHeight / 2, trackingOverlay.height - sample.boxHeight - 12));

  overlayCtx.lineWidth = 1.4;
  overlayCtx.strokeStyle = stroke;
  overlayCtx.fillStyle = `${stroke}22`;
  overlayCtx.fillRect(x, y, sample.boxWidth, sample.boxHeight);
  overlayCtx.strokeRect(x, y, sample.boxWidth, sample.boxHeight);

  overlayCtx.beginPath();
  overlayCtx.strokeStyle = stroke;
  overlayCtx.moveTo(sample.focusX - 16, sample.focusY);
  overlayCtx.lineTo(sample.focusX + 16, sample.focusY);
  overlayCtx.moveTo(sample.focusX, sample.focusY - 10);
  overlayCtx.lineTo(sample.focusX, sample.focusY + 10);
  overlayCtx.stroke();

  overlayCtx.fillStyle = stroke;
  overlayCtx.font = "700 11px Inter, sans-serif";
  overlayCtx.fillText(`EYE ${eyeMovementLabel(sample).toUpperCase()}`, x, Math.max(14, y - 6));
}

function clearTrackingOverlay() {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, trackingOverlay.width, trackingOverlay.height);
}

function computeRecentEyeActivity(sample, now) {
  if (sample.isBlinking) {
    return {
      recentAlert: now < state.eyeAlertUntil,
      recentLevel: Math.max(0, state.eyeRecentLevel * 0.9),
      recentDirection: 0,
    };
  }

  const recentSamples = state.samples.filter((item) => now - item.at <= 1100);
  const avg = (key) => recentSamples.reduce((sum, item) => sum + (item[key] ?? 0), 0) / Math.max(recentSamples.length, 1);
  const max = (key) => recentSamples.reduce((value, item) => Math.max(value, item[key] ?? 0), 0);
  const avgDrift = avg("drift");
  const avgMotion = avg("eyeMotion");
  const maxDrift = max("drift");
  const maxMotion = max("eyeMotion");
  const bursts = recentSamples.filter((item) => (item.eyeMotion ?? 0) > 0.1 || (item.drift ?? 0) > 0.18).length;
  const recentDirection = recentSamples.reduce((sum, item) => sum + (item.horizontalBias ?? 0), 0);
  const recentLevel = Math.min(Math.max(avgDrift * 0.26 + avgMotion * 1.02 + maxDrift * 0.12 + maxMotion * 0.48, 0), 1);

  if (bursts >= 2 || maxMotion > 0.14 || maxDrift > 0.22) {
    state.eyeAlertUntil = now + 1100;
    state.eyeRecentLevel = Math.max(state.eyeRecentLevel, recentLevel, maxMotion, maxDrift * 0.8);
  } else if (now > state.eyeAlertUntil) {
    state.eyeRecentLevel = recentLevel * 0.4;
  } else {
    state.eyeRecentLevel = Math.max(state.eyeRecentLevel * 0.86, recentLevel);
  }

  return { recentAlert: now < state.eyeAlertUntil, recentLevel: Math.max(recentLevel, state.eyeRecentLevel), recentDirection };
}

function effectiveEyeLevel(sample) {
  if (sample.isBlinking) return 0;
  return Math.max(sample.drift ?? 0, sample.recentLevel ?? 0, (sample.eyeMotion ?? 0) * 0.85);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function detectFaceSample() {
  const mediaPipeSample = detectMediaPipeSample();
  if (mediaPipeSample) return mediaPipeSample;

  const detector = getFaceDetector();
  if (!detector) return null;

  try {
    const faces = await detector.detect(canvas);
    if (!faces.length) return { faceDetected: false, faceDetectorActive: true, trackingMode: "face" };

    const face = faces.reduce((largest, current) => {
      const currentArea = current.boundingBox.width * current.boundingBox.height;
      const largestArea = largest.boundingBox.width * largest.boundingBox.height;
      return currentArea > largestArea ? current : largest;
    });
    const box = face.boundingBox;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const landmarks = Object.fromEntries((face.landmarks || []).map((point) => [point.type, point.locations?.[0] || point]));
    const leftEye = landmarks.leftEye;
    const rightEye = landmarks.rightEye;
    const eyeMidX = leftEye && rightEye ? (leftEye.x + rightEye.x) / 2 : centerX;
    const eyeMidY = leftEye && rightEye ? (leftEye.y + rightEye.y) / 2 : centerY - box.height * 0.14;
    const horizontalBias = (eyeMidX - canvas.width / 2) / Math.max(canvas.width / 2, 1);
    const verticalBias = (eyeMidY - canvas.height * 0.42) / Math.max(canvas.height * 0.42, 1);
    const centered = Math.max(0, 1 - (Math.abs(centerX - canvas.width / 2) / (canvas.width / 2)) * 0.85 - (Math.abs(centerY - canvas.height / 2) / (canvas.height / 2)) * 0.5);
    const drift = Math.min(Math.abs(horizontalBias) * 1.1 + Math.abs(verticalBias) * 0.35 + (1 - centered) * 0.25, 1);
    return {
      faceDetected: true,
      faceDetectorActive: true,
      trackingMode: "face",
      centered,
      eye: Math.max(0, Math.min(1 - drift * 0.7, 1)),
      drift,
      focusX: eyeMidX,
      focusY: eyeMidY,
      boxWidth: Math.max(box.width, canvas.width * 0.18),
      boxHeight: Math.max(box.height, canvas.height * 0.28),
      horizontalBias,
    };
  } catch {
    return null;
  }
}

function sampleFromLandmarks(landmarks) {
  const bounds = landmarks.reduce((box, landmark) => ({
    minX: Math.min(box.minX, landmark.x),
    minY: Math.min(box.minY, landmark.y),
    maxX: Math.max(box.maxX, landmark.x),
    maxY: Math.max(box.maxY, landmark.y),
  }), { minX: 1, minY: 1, maxX: 0, maxY: 0 });
  const boxWidth = (bounds.maxX - bounds.minX) * canvas.width;
  const boxHeight = (bounds.maxY - bounds.minY) * canvas.height;
  const centerX = ((bounds.minX + bounds.maxX) / 2) * canvas.width;
  const centerY = ((bounds.minY + bounds.maxY) / 2) * canvas.height;
  const eyeMid = averagePoints(landmarks, [33, 133, 362, 263]);
  const leftIris = averagePoints(landmarks, [468, 469, 470, 471, 472]);
  const rightIris = averagePoints(landmarks, [473, 474, 475, 476, 477]);
  const leftBlinkRatio = eyeOpenRatio(landmarks[159], landmarks[145], landmarks[33], landmarks[133]);
  const rightBlinkRatio = eyeOpenRatio(landmarks[386], landmarks[374], landmarks[362], landmarks[263]);
  const blinkRatio = (leftBlinkRatio + rightBlinkRatio) / 2;
  const isBlinking = blinkRatio < 0.16;
  const leftEyeRatio = eyeRatio(landmarks[33], landmarks[133], leftIris);
  const rightEyeRatio = eyeRatio(landmarks[362], landmarks[263], rightIris);
  const gazeBias = clamp((leftEyeRatio + rightEyeRatio) / 2, -1, 1);
  const faceCenter = { x: centerX / canvas.width, y: centerY / canvas.height };
  const headShift = state.lastFaceCenter ? Math.hypot(faceCenter.x - state.lastFaceCenter.x, faceCenter.y - state.lastFaceCenter.y) : 0;
  const gazeShift = isBlinking ? 0 : Math.abs(gazeBias - state.lastGazeBias);
  const eyeMotion = clamp(gazeShift * 5.8, 0, 1);
  const centered = Math.max(0, 1 - (Math.abs(centerX - canvas.width / 2) / (canvas.width / 2)) * 0.85 - (Math.abs(centerY - canvas.height / 2) / (canvas.height / 2)) * 0.5);
  const drift = Math.min(isBlinking ? 0 : Math.abs(gazeBias) * 0.48 + eyeMotion * 0.68, 1);

  if (!isBlinking) {
    state.lastGazeBias = gazeBias;
    state.lastEyeMid = { x: eyeMid.x, y: eyeMid.y };
  }
  state.lastFaceCenter = faceCenter;

  return {
    faceDetected: true,
    faceDetectorActive: true,
    trackingMode: "mediapipe",
    centered,
    eye: Math.max(0, Math.min(1 - drift * 0.75, 1)),
    drift,
    focusX: eyeMid.x * canvas.width,
    focusY: eyeMid.y * canvas.height,
    boxWidth: Math.max(boxWidth, canvas.width * 0.24),
    boxHeight: Math.max(boxHeight, canvas.height * 0.34),
    horizontalBias: gazeBias,
    gazeBias,
    eyeMotion,
    blinkRatio,
    isBlinking,
    headShift,
  };
}

function averagePoints(landmarks, indexes) {
  const points = indexes.map((index) => landmarks[index]).filter(Boolean);
  if (!points.length) return { x: 0.5, y: 0.45 };
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function eyeRatio(start, end, iris) {
  if (!start || !end || !iris) return 0;
  const span = end.x - start.x;
  if (!Number.isFinite(span) || Math.abs(span) < 0.0001) return 0;
  return clamp(((iris.x - start.x) / span - 0.5) * 2, -1, 1);
}

function eyeOpenRatio(upper, lower, outer, inner) {
  if (!upper || !lower || !outer || !inner) return 0.3;
  const width = Math.hypot(inner.x - outer.x, inner.y - outer.y);
  if (!Number.isFinite(width) || width < 0.0001) return 0.3;
  const height = Math.hypot(lower.x - upper.x, lower.y - upper.y);
  return height / width;
}

function detectMediaPipeSample() {
  if (!state.faceLandmarker) return null;

  try {
    const result = state.faceLandmarker.detectForVideo(camera, performance.now());
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks?.length) return { faceDetected: false, faceDetectorActive: true, trackingMode: "mediapipe" };
    return sampleFromLandmarks(landmarks);
  } catch (error) {
    state.faceLandmarker = null;
    state.faceLandmarkerReady = false;
    state.faceLandmarkerError = String(error?.message || error || "MediaPipe detect failed");
    return null;
  }
}

function getFaceDetector() {
  if (!("FaceDetector" in window)) return null;
  if (!state.faceDetector) state.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
  return state.faceDetector;
}

function eyeMovementScore(sample) {
  if (sample.faceDetectorActive && !sample.faceDetected) return 0.2;
  return 1 - effectiveEyeLevel(sample);
}

function headMovementLabel(sample) {
  const level = headMovementScore(sample);
  if (sample.faceDetectorActive && !sample.faceDetected) return "searching";
  if (level > 0.42) return "head shifting";
  if (level > 0.18) return "slight move";
  return "steady";
}

function headMovementScore(sample) {
  if (sample.faceDetectorActive && !sample.faceDetected) return 0.2;
  if (sample.trackingMode === "mediapipe") return clamp((sample.headShift ?? 0) * 18 + (1 - (sample.centered ?? 1)) * 0.45, 0, 1);
  return Math.max(0, Math.min(sample.movement * 2, 1));
}

function volumeLabel(db) {
  if (db > -18) return "strong";
  if (db > -26) return "clear";
  if (db > -34) return "soft";
  return "too quiet";
}

function volumeScore(db) {
  if (db > -18) return 0.9;
  if (db > -26) return 0.72;
  if (db > -34) return 0.48;
  return 0.24;
}

function energyLabel(sample) {
  if (!sample.voiced) return "waiting";
  if (sample.peak > 0.2) return "animated";
  if (sample.peak > 0.1) return "steady";
  return "flat";
}

function energyScore(sample) {
  if (!sample.voiced) return 0.4;
  if (sample.peak > 0.2) return 0.9;
  if (sample.peak > 0.1) return 0.66;
  return 0.34;
}

function pitchLabel(sample) {
  if (!sample.pitchHz) return "listening";
  if (sample.pitchDelta > 28) return "varied";
  if (sample.pitchDelta > 12) return "moderate";
  return "narrow";
}

function pitchScore(sample) {
  if (!sample.pitchHz) return 0.4;
  if (sample.pitchDelta > 28) return 0.88;
  if (sample.pitchDelta > 12) return 0.62;
  return 0.32;
}

function pauseLabel(sample) {
  if (sample.voiced) {
    if (sample.pauseMs > 1100) return "long gap";
    if (sample.pauseMs > 420) return "spaced";
    return "tight";
  }
  const silenceFor = state.lastSpeechAt ? performance.now() - state.lastSpeechAt : 0;
  if (silenceFor > 1100) return "holding";
  if (silenceFor > 420) return "pause";
  return "brief";
}

function pauseScore(sample) {
  if (sample.pauseMs > 1100) return 0.3;
  if (sample.pauseMs > 420) return 0.84;
  if (sample.voiced) return 0.46;
  return 0.58;
}

function audioFeedbackText(sample) {
  if (!sample.voiced) {
    const silenceFor = state.lastSpeechAt ? performance.now() - state.lastSpeechAt : 0;
    if (silenceFor > 1100) return "Long pause detected. This can work before a key point, but too many will break momentum.";
    if (silenceFor > 420) return "Healthy pause. Let the next line land cleanly.";
    return "Mic is live. Start speaking to analyze pace, volume, pitch range, and pauses.";
  }
  if (sample.db < -34) return "Volume is low right now. Push a little more air through the next sentence.";
  if (sample.pitchDelta < 10) return "Pitch range is narrow. Add more rise and fall so the idea sounds alive.";
  if (sample.peak > 0.22) return "Vocal energy is strong. Keep that lift on your important phrases.";
  return "Audio analysis is active: volume, energy, pitch range, and pauses are being measured live.";
}

function detectPitch(buffer, sampleRate) {
  let bestOffset = -1;
  let bestCorrelation = 0;
  const minSamples = Math.floor(sampleRate / 300);
  const maxSamples = Math.floor(sampleRate / 85);
  for (let offset = minSamples; offset <= maxSamples; offset += 1) {
    let correlation = 0;
    for (let index = 0; index < buffer.length - offset; index += 1) {
      correlation += buffer[index] * buffer[index + offset];
    }
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }
  if (bestOffset === -1 || bestCorrelation < 6) return 0;
  return sampleRate / bestOffset;
}

function facePositionLabel(sample) {
  if (sample.faceDetectorActive && !sample.faceDetected) return "searching";
  if (sample.centered > 0.72) return "centered";
  if (sample.centered > 0.48) return "slightly off";
  return "off center";
}

function renderList(target, rows) {
  target.innerHTML = "";
  rows.forEach(({ label, value, score }) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${label}</span><strong class="${score > 0.66 ? "good" : score > 0.4 ? "warn" : "bad"}">${value}</strong>`;
    target.appendChild(item);
  });
}

function showCoachText(message, expression) {
  coachMessage.textContent = message;
  avatar.className = `avatar ${expression}`;
}

function interruptWithCoachSpeech(message) {
  pauseRecognitionForCoach();
  say(message, "confused", { resumeRecognition: true });
}

function pauseRecognitionForCoach() {
  if (!state.recognition || stopBtn.disabled) return;

  state.listeningPausedForCoach = true;
  speechStatus.textContent = "Coach speaking";

  try {
    state.recognition.stop();
  } catch {
    state.listeningPausedForCoach = false;
  }
}

function resumeRecognitionAfterCoach() {
  if (!state.recognition || stopBtn.disabled) {
    state.listeningPausedForCoach = false;
    return;
  }

  state.listeningPausedForCoach = false;
  speechStatus.textContent = "Listening";

  try {
    state.recognition.start();
  } catch {
    speechStatus.textContent = "Speech paused";
  }
}

function say(message, expression, options = {}) {
  coachMessage.textContent = message;
  avatar.className = `avatar ${expression}`;

  if (!("speechSynthesis" in window)) {
    if (options.resumeRecognition) resumeRecognitionAfterCoach();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 0.98;
  utterance.pitch = 0.95;
  utterance.onend = () => {
    if (avatar.classList.contains("speaking")) avatar.className = "avatar listening";
    if (options.resumeRecognition) resumeRecognitionAfterCoach();
  };
  utterance.onerror = () => {
    if (options.resumeRecognition) resumeRecognitionAfterCoach();
  };
  window.speechSynthesis.speak(utterance);
}

function resetDashboard() {
  dashboard.classList.add("hidden");
  deliveryList.innerHTML = "";
  contentList.innerHTML = "";
  rewriteText.textContent = "";
  followupText.textContent = "";
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

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function clampScore(value) {
  return Math.max(1, Math.min(10, value));
}

function samplePitch() {
  return "So basically we made an AI thing that uses vision and audio and it is kind of like a coach. It watches and listens in real time and gives feedback for presentations.";
}
