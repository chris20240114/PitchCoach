import {
  analysisDetail,
  analysisPanel,
  analysisStatus,
  analyzeUploadBtn,
  audioFeedback,
  audienceType,
  avatar,
  camera,
  cameraStatus,
  canvas,
  chatForm,
  chatInput,
  chatMessages,
  chatPanel,
  chatSendBtn,
  chatStatus,
  clearUploadBtn,
  coachMessage,
  coachSignal,
  coachingIntensity,
  contentList,
  ctx,
  dashboard,
  deliveryList,
  energySignal,
  eyeFeedback,
  eyeSignal,
  followupText,
  lightingSignal,
  movementSignal,
  overlayCtx,
  pauseSignal,
  pitchSignal,
  positionSignal,
  presentationType,
  recordingPlayback,
  recordingStatus,
  retryBtn,
  rewriteText,
  reviewPanel,
  signalStatus,
  speechStatus,
  startBtn,
  stopBtn,
  timerEl,
  trackingOverlay,
  trackingToggle,
  transcriptEl,
  volumeSignal,
} from "./dom.js";
import {
  LIVE_SAMPLE_MAX,
  LIVE_SESSION_LIMIT_SECONDS,
  MEDIAPIPE_MODEL_ASSET,
  MEDIAPIPE_VISION_BUNDLE,
  SpeechRecognition,
} from "./config.js";
import { state } from "./state.js";
import {
  buildRewrite,
  buildSpokenFeedback,
  countFillers,
  followupForContext,
  scoreContent,
} from "./coaching.js";
import {
  clamp,
  formatTime,
  paceLabel,
  paceScore,
  roundMetric,
  samplePitch,
} from "./utils.js";
import {
  clearRecordingReview,
  mergeTimelineNotes,
  normalizePerformanceNotes,
  renderTimeline,
} from "./review.js";
import {
  analyzeAudioFrame,
  audioFeedbackText,
  energyLabel,
  energyScore,
  pauseLabel,
  pauseScore,
  pitchLabel,
  pitchScore,
  volumeLabel,
  volumeScore,
} from "./audioMetrics.js";
import {
  setInferredUploadTranscript,
  setupUploadHandlers,
  syncUploadControls,
} from "./uploads.js";

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
retryBtn.addEventListener("click", resetSession);
presentationType.addEventListener("change", updateContext);
audienceType.addEventListener("change", updateContext);
coachingIntensity.addEventListener("change", updateContext);
trackingToggle.addEventListener("click", toggleTrackingOverlay);
chatForm.addEventListener("submit", handleChatSubmit);
setupUploadHandlers({
  analyzeFrame,
  resetDashboard,
  resetFeedbackChat,
  resetInterruptionState,
  say,
  setAnalyzing,
  showFeedback,
});

async function startSession() {
  resetDashboard();
  updateContext();
  state.transcript = "";
  state.interim = "";
  state.samples = [];
  state.audioSamples = [];
  state.transcriptEvents = [];
  state.liveEvents = [];
  state.timelineEvents = [];
  state.transcriptSegments = [];
  state.eventCooldowns = {};
  state.recordingChunks = [];
  clearRecordingReview();
  resetFeedbackChat();
  resetInterruptionState();
  resetAudioTrackingState();
  state.startedAt = Date.now();
  transcriptEl.textContent = "";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  retryBtn.disabled = true;

  await startCamera();
  initFaceLandmarker();
  startRecording();
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

function startRecording() {
  if (!state.stream || !window.MediaRecorder) {
    recordingStatus.textContent = "Recording unavailable";
    addTimelineEvent("recording", 0, "Recording unavailable", "This browser could not start a local recording.");
    return;
  }

  try {
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";
    state.recordingChunks = [];
    state.recorder = new MediaRecorder(state.stream, {
      mimeType,
      videoBitsPerSecond: 700000,
      audioBitsPerSecond: 48000,
    });
    state.recorder.ondataavailable = (event) => {
      if (event.data?.size) state.recordingChunks.push(event.data);
    };
    state.recorder.onstart = () => {
      recordingStatus.textContent = "Recording";
    };
    state.recorder.onstop = finalizeRecording;
    state.recorder.start(1000);
  } catch {
    state.recorder = null;
    recordingStatus.textContent = "Recording unavailable";
  }
}

function stopRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
  } else {
    finalizeRecording();
  }
}

function finalizeRecording() {
  if (!state.recordingChunks.length) return;
  if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
  state.recordingBlob = new Blob(state.recordingChunks, { type: state.recordingChunks[0]?.type || "video/webm" });
  state.recordingUrl = URL.createObjectURL(state.recordingBlob);
  recordingPlayback.src = state.recordingUrl;
  recordingStatus.textContent = "Ready";
  reviewPanel.classList.remove("hidden");
  if (state.lastFeedbackContext) {
    requestVideoPerformanceNotes({
      transcript: state.lastFeedbackContext.transcript,
      timeline: state.lastFeedbackContext.timeline,
      feedback: state.lastFeedbackContext.feedback,
      videoBlob: state.recordingBlob,
    }).then((videoNotes) => {
      if (!videoNotes.length) return;
      const merged = mergeTimelineNotes(state.lastFeedbackContext.timeline, videoNotes);
      state.lastFeedbackContext.timeline = merged;
      renderTimeline(merged);
    });
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
      recordTranscriptSegment(finalText);
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
    if (elapsed >= LIVE_SESSION_LIMIT_SECONDS) stopSession();
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
  recordVisionEvent(sample);
  if (state.samples.length > LIVE_SAMPLE_MAX) state.samples.shift();
}

function addAudioSample(sample) {
  state.audioSamples.push({ ...sample, at: Date.now() });
  recordAudioEvent(sample);
  if (state.audioSamples.length > LIVE_SAMPLE_MAX) state.audioSamples.shift();
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
  stopRecording();
  if (wasRunning) showFeedback();
}

function resetSession() {
  if (stopBtn.disabled === false) stopSession();
  state.transcript = "";
  state.interim = "";
  state.listeningPausedForCoach = false;
  state.samples = [];
  state.audioSamples = [];
  state.timelineEvents = [];
  state.transcriptSegments = [];
  state.eventCooldowns = {};
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
  clearRecordingReview();
  resetFeedbackChat();
  resetDashboard();
  setAnalyzing(false);
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
  setAnalyzing(true, source.preferVideoFeedback ? "Analyzing uploaded video" : "Analyzing practice", source.preferVideoFeedback
    ? "Sampling frames, reading audio, and asking Gemini for coaching feedback."
    : "Scoring transcript, delivery signals, and coaching moments.");
  startBtn.disabled = true;
  retryBtn.disabled = true;
  analyzeUploadBtn.disabled = true;
  clearUploadBtn.disabled = true;

  const elapsed = Math.max(source.durationSeconds || getElapsedSeconds(), 1);
  const rawTranscript = source.transcript ?? `${state.transcript} ${state.interim}`.trim();
  const transcript = rawTranscript.trim() || (source.videoBlob ? "No transcript provided; review visual and audio delivery only." : samplePitch());
  const words = transcript.match(/\b[\w'-]+\b/g) || [];
  const fillers = countFillers(transcript);
  const wpm = Math.round((words.length / elapsed) * 60);
  const visual = source.visual || summarizeVision();
  const audio = source.audio || summarizeAudio();
  const scores = scoreContent(transcript);
  const fallback = buildLocalFeedback({ audio, fillers, scores, transcript, visual, wpm });
  const timeline = buildTimelineEvents();
  const textFeedbackPayload = {
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
    performanceNotes: timeline,
  };
  const feedback = source.preferVideoFeedback
    ? fallback
    : await requestCoachFeedback(textFeedbackPayload, fallback);
  const videoFeedback = source.preferVideoFeedback && source.videoBlob
    ? await requestVideoFeedback({
      transcript: rawTranscript.trim(),
      durationSeconds: elapsed,
      timeline,
      feedback,
      videoBlob: source.videoBlob,
      frames: source.frames || [],
    })
    : null;
  const finalFeedback = videoFeedback
    ? normalizeFeedback({ ...feedback, ...videoFeedback }, feedback)
    : feedback;
  const effectiveTranscript = videoFeedback?.inferredTranscript?.trim() || transcript;
  if (videoFeedback?.inferredTranscript?.trim() && !rawTranscript.trim()) {
    setInferredUploadTranscript(videoFeedback.inferredTranscript);
  }

  renderList(deliveryList, finalFeedback.delivery);
  renderList(contentList, finalFeedback.content);
  rewriteText.textContent = finalFeedback.suggestedRewrite;
  followupText.textContent = finalFeedback.followupQuestion;
  dashboard.classList.remove("hidden");
  const initialNotes = mergeTimelineNotes(finalFeedback.performanceNotes, timeline);
  renderTimeline(initialNotes);
  enableFeedbackChat({
    transcript: effectiveTranscript,
    durationSeconds: elapsed,
    wpm,
    fillers: fillers.total,
    visual,
    audio,
    timeline: initialNotes,
    feedback: finalFeedback,
  });
  if (!source.preferVideoFeedback) {
    requestVideoPerformanceNotes({
      transcript,
      timeline: initialNotes,
      feedback: finalFeedback,
      videoBlob: source.videoBlob,
    }).then((videoNotes) => {
      if (!videoNotes.length) return;
      const merged = mergeTimelineNotes(initialNotes, videoNotes);
      renderTimeline(merged);
      if (state.lastFeedbackContext) state.lastFeedbackContext.timeline = merged;
    });
  }
  setAnalyzing(false);
  startBtn.disabled = false;
  retryBtn.disabled = false;
  syncUploadControls();
  say(finalFeedback.coachResponse, finalFeedback.avatarState);
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
    performanceNotes: buildGenericTimeline(scores, visual, audio),
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
    performanceNotes: normalizePerformanceNotes(feedback.performanceNotes, fallback.performanceNotes),
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

function recordTranscriptSegment(text) {
  const cleanText = text.trim();
  if (!cleanText) return;

  const time = getElapsedSeconds();
  state.transcriptSegments.push({ time, text: cleanText });

  const lower = cleanText.toLowerCase();
  const weakTerms = ["basically", "kind of", "sort of", "thing", "stuff", "you know"];
  const matchedWeakTerm = weakTerms.find((term) => lower.includes(term));
  if (matchedWeakTerm) {
    addTimelineEvent("wording", time, "Loose wording", `"${matchedWeakTerm}" can sound vague here. Replace it with a specific user, problem, or result.`);
  }
  if (/\bgive me\b|\bi will listen\b|\blistening for\b/.test(lower)) {
    addTimelineEvent("wording", time, "Prompt-like phrasing", "This sounds like instructions to the coach rather than your actual presentation opening.");
  }
}

function recordVisionEvent(sample) {
  const level = effectiveEyeLevel(sample);
  if (sample.faceDetectorActive && !sample.faceDetected) {
    addTimelineEvent("eye", getElapsedSeconds(), "Face left frame", "The tracker lost your face here. Re-center before the next key point.", 5);
    return;
  }
  if (!sample.isBlinking && (level > 0.3 || sample.recentAlert)) {
    const direction = sample.horizontalBias > 0 ? "camera right" : "camera left";
    addTimelineEvent("eye", getElapsedSeconds(), "Eye drift", `Your eye line drifted toward ${direction}. Re-lock on the lens for the next sentence.`, 4);
  }
}

function recordAudioEvent(sample) {
  const time = getElapsedSeconds();
  if (sample.voiced && volumeScore(sample.db) < 0.38) {
    addTimelineEvent("audio", time, "Low volume", "Your voice dropped here. Add a little more projection on the next sentence.", 5);
  }
  if (sample.voiced && sample.pitchHz > 0 && pitchScore(sample) < 0.38) {
    addTimelineEvent("audio", time, "Flat tone", "Pitch variation was low here. Lift the key phrase so it sounds more intentional.", 6);
  }
  if (!sample.voiced && state.recentPauseMs > 1100) {
    addTimelineEvent("pause", time, "Long pause", "This pause may feel long unless it follows a major point.", 6);
  }
}

function addTimelineEvent(type, time, label, detail, cooldownSeconds = 3) {
  const rounded = Math.max(0, Math.round(time));
  const key = `${type}:${label}`;
  if (rounded - (state.eventCooldowns[key] ?? -Infinity) < cooldownSeconds) return;
  state.eventCooldowns[key] = rounded;
  state.timelineEvents.push({ type, time: rounded, label, detail });
  if (state.timelineEvents.length > 36) state.timelineEvents.shift();
}

function buildTimelineEvents() {
  const events = [...state.timelineEvents];
  if (!events.length && state.transcriptSegments.length) {
    const first = state.transcriptSegments[0];
    events.push({
      type: "wording",
      time: first.time,
      label: "Opening line",
      detail: `Review this opening: "${first.text.slice(0, 110)}"`,
    });
  }

  return events
    .sort((a, b) => a.time - b.time)
    .filter((event, index, list) => index === 0 || event.time !== list[index - 1].time || event.label !== list[index - 1].label)
    .slice(0, 8);
}

function buildGenericTimeline(scores, visual, audio) {
  const notes = [];
  if (scores.problem < 6) notes.push({ type: "wording", time: 5, label: "Problem clarity", detail: "The opening needs a clearer audience problem." });
  if (visual.eyeScore < 0.55) notes.push({ type: "eye", time: 12, label: "Eye contact", detail: "Review this section for eye drift and re-lock on the lens." });
  if (audio.volumeScore < 0.45) notes.push({ type: "audio", time: 18, label: "Volume", detail: "Voice energy sounded low around this part." });
  if (audio.pitchScore < 0.45) notes.push({ type: "audio", time: 24, label: "Pitch variation", detail: "Add more vocal lift on the key idea." });
  return notes;
}

async function requestVideoPerformanceNotes(context) {
  const result = await requestVideoFeedback(context);
  return normalizePerformanceNotes(result?.performanceNotes, []);
}

async function requestVideoFeedback(context) {
  const videoBlob = context.videoBlob || state.recordingBlob || (state.uploadMedia?.tagName === "VIDEO" ? state.uploadFileBlob : null);
  if (!videoBlob) return null;
  const mimeType = getGeminiVideoMime(videoBlob);

  if (!mimeType) {
    recordingStatus.textContent = "Unsupported video";
    return null;
  }

  try {
    recordingStatus.textContent = context.frames?.length ? `Gemini video + ${context.frames.length} frames` : "Gemini video";
    setAnalyzing(true, "Asking Gemini", context.frames?.length
      ? `Sending video, audio, and ${context.frames.length} sampled frames for feedback.`
      : "Sending video and audio for feedback.");
    const videoData = await blobToBase64(videoBlob);
    const response = await fetch("/api/video-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: videoBlob.name || "practice-video",
        mimeType,
        videoData,
        frames: context.frames || [],
        context: {
          presentation: state.context,
          durationSeconds: context.durationSeconds || state.uploadDuration || getElapsedSeconds(),
          transcript: context.transcript,
          sampledFrames: summarizeFramePayload(context.frames || []),
          timeline: context.timeline,
          feedback: context.feedback,
          transcriptSegments: state.transcriptSegments.slice(0, 24),
        },
      }),
    });

    if (!response.ok) throw new Error(`Video feedback returned ${response.status}`);
    const result = await response.json();
    recordingStatus.textContent = result.source === "gemini" ? "Gemini video" : "Ready";
    return result;
  } catch {
    recordingStatus.textContent = "Ready";
    return null;
  }
}

function summarizeFramePayload(frames) {
  return {
    count: frames.length,
    fps: estimateFrameRate(frames),
    firstSecond: frames[0]?.time ?? 0,
    lastSecond: frames.at(-1)?.time ?? 0,
    width: frames[0]?.width,
    height: frames[0]?.height,
  };
}

function estimateFrameRate(frames) {
  if (frames.length < 2) return 0;
  const duration = Math.max((frames.at(-1)?.time || 0) - (frames[0]?.time || 0), 1);
  return Math.round((frames.length / duration) * 10) / 10;
}

function getGeminiVideoMime(file) {
  const declared = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  if (["video/mp4", "video/mpeg", "video/mov", "video/avi", "video/x-flv", "video/mpg", "video/webm", "video/wmv", "video/3gpp"].includes(declared)) return declared;
  if (declared === "video/quicktime") return "video/mov";
  if (declared === "video/x-msvideo") return "video/avi";
  if (declared === "video/x-ms-wmv") return "video/wmv";
  if (declared === "video/x-m4v") return "video/mp4";
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/mov";
  if (name.endsWith(".mpeg")) return "video/mpeg";
  if (name.endsWith(".mpg")) return "video/mpg";
  if (name.endsWith(".avi")) return "video/avi";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".wmv")) return "video/wmv";
  if (name.endsWith(".flv")) return "video/x-flv";
  if (name.endsWith(".3gp") || name.endsWith(".3gpp")) return "video/3gpp";
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function enableFeedbackChat(context) {
  state.lastFeedbackContext = {
    presentation: state.context,
    transcript: context.transcript,
    durationSeconds: context.durationSeconds,
    delivery: {
      wordsPerMinute: context.wpm,
      fillerWords: context.fillers,
      visual: context.visual,
      audio: context.audio,
    },
    timeline: context.timeline,
    transcriptSegments: state.transcriptSegments.slice(0, 24),
    feedback: context.feedback,
  };
  state.chatHistory = [];
  chatMessages.innerHTML = "";
  appendChatMessage("assistant", "Ask me anything about this feedback, or ask for a stronger rewrite.");
  chatPanel.classList.remove("hidden");
  setChatStatus("Gemini ready");
  chatInput.disabled = false;
  chatSendBtn.disabled = false;
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question || !state.lastFeedbackContext) return;

  chatInput.value = "";
  appendChatMessage("user", question);
  setChatStatus("Thinking", true);
  chatInput.disabled = true;
  chatSendBtn.disabled = true;

  try {
    const result = await requestFeedbackChat(question);
    const answer = result.answer || "I could not generate a follow-up answer. Try asking in a simpler way.";
    appendChatMessage("assistant", answer);
    state.chatHistory.push({ role: "user", content: question }, { role: "assistant", content: answer });
    setChatStatus(result.source === "gemini" ? "Gemini" : result.source === "feedback-fallback" ? "Gemini fallback" : "Local");
  } catch (error) {
    const answer = error?.message || "I could not reach Gemini for this follow-up. Try again after checking the server.";
    appendChatMessage("assistant", answer);
    state.chatHistory.push({ role: "user", content: question }, { role: "assistant", content: answer });
    setChatStatus("Chat unavailable");
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    chatInput.focus();
  }
}

async function requestFeedbackChat(question) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      context: state.lastFeedbackContext,
      history: state.chatHistory.slice(-8),
    }),
  });

  if (response.ok) return response.json();
  if (![404, 405].includes(response.status)) {
    throw new Error(`Chat API returned ${response.status}. Check the Node server terminal.`);
  }

  const fallbackResponse = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: state.lastFeedbackContext?.presentation || state.context,
      transcript: [
        "This is a follow-up coaching chat, not a new presentation.",
        `User question: ${question}`,
        `Previous transcript: ${state.lastFeedbackContext?.transcript || ""}`,
        `Previous feedback: ${JSON.stringify(state.lastFeedbackContext?.feedback || {})}`,
      ].join("\n\n"),
      durationSeconds: state.lastFeedbackContext?.durationSeconds || 60,
      delivery: state.lastFeedbackContext?.delivery || {},
      visual: state.lastFeedbackContext?.delivery?.visual || {},
      audio: state.lastFeedbackContext?.delivery?.audio || {},
      timeline: state.lastFeedbackContext?.timeline || [],
      transcriptSegments: state.lastFeedbackContext?.transcriptSegments || [],
    }),
  });

  if (!fallbackResponse.ok) throw new Error(`Feedback fallback returned ${fallbackResponse.status}. Check the Node server terminal.`);
  const feedback = await fallbackResponse.json();
  return {
    answer: feedback.coachResponse || feedback.suggestedRewrite || "Try focusing on one specific improvement from the feedback.",
    source: feedback.source === "gemini" ? "feedback-fallback" : "local",
  };
}

function appendChatMessage(role, text) {
  const message = document.createElement("p");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setChatStatus(text, loading = false) {
  chatStatus.textContent = text;
  chatStatus.classList.toggle("loading", loading);
}

function resetFeedbackChat() {
  state.lastFeedbackContext = null;
  state.chatHistory = [];
  chatMessages.innerHTML = "";
  chatPanel.classList.add("hidden");
  setChatStatus("Ready after feedback");
  chatInput.value = "";
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
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
  if (!state.overlayVisible) return;

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

function toggleTrackingOverlay() {
  state.overlayVisible = !state.overlayVisible;
  trackingOverlay.classList.toggle("hidden-overlay", !state.overlayVisible);
  trackingToggle.classList.toggle("active", state.overlayVisible);
  trackingToggle.setAttribute("aria-pressed", String(state.overlayVisible));
  trackingToggle.textContent = state.overlayVisible ? "Face box" : "Face box off";
  if (!state.overlayVisible) clearTrackingOverlay();
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

function setAnalyzing(active, status = "Analyzing practice", detail = "Extracting speech, frames, and delivery signals.") {
  analysisPanel.classList.toggle("hidden", !active);
  analysisStatus.textContent = status;
  analysisDetail.textContent = detail;
  document.body.classList.toggle("is-analyzing", active);
}

function getElapsedSeconds() {
  return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
}

