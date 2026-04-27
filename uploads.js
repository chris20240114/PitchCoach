import {
  analyzeUploadBtn,
  canvas,
  clearUploadBtn,
  ctx,
  mediaPreview,
  recordingPlayback,
  recordingStatus,
  reviewPanel,
  speechStatus,
  transcriptEl,
  uploadFile,
  uploadStatus,
  uploadTranscript,
} from "./dom.js";
import {
  UPLOAD_FRAME_MAX,
  UPLOAD_FRAME_QUALITY,
  UPLOAD_FRAME_WIDTH,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_DURATION_SECONDS,
} from "./config.js";
import { state } from "./state.js";
import { formatTime } from "./utils.js";

let handlers = {};

export function setupUploadHandlers(callbacks) {
  handlers = callbacks;
  uploadFile.addEventListener("change", handleUploadFile);
  uploadTranscript.addEventListener("input", syncUploadControls);
  analyzeUploadBtn.addEventListener("click", analyzeUpload);
  clearUploadBtn.addEventListener("click", clearUpload);
}

export function setInferredUploadTranscript(transcript) {
  const clean = transcript.trim();
  if (!clean) return;
  uploadTranscript.value = clean;
  transcriptEl.textContent = clean;
  state.transcript = clean;
  state.transcriptEvents = [{ atSeconds: 0, text: clean, type: "video-transcript" }];
  state.transcriptSegments = [{ time: 0, text: clean }];
  syncUploadControls();
}

export function syncUploadControls() {
  const hasFile = Boolean(uploadFile.files?.[0]);
  const hasTranscript = Boolean(uploadTranscript.value.trim());
  const mediaTooLong = state.uploadMedia && state.uploadDuration > UPLOAD_MAX_DURATION_SECONDS;
  analyzeUploadBtn.disabled = (!hasFile && !hasTranscript) || mediaTooLong;
  clearUploadBtn.disabled = !hasFile && !hasTranscript;
}

function handleUploadFile() {
  const file = uploadFile.files?.[0];
  clearUploadPreview();
  handlers.resetDashboard();
  handlers.resetFeedbackChat();
  handlers.setAnalyzing(false);

  if (!file) {
    state.uploadFileBlob = null;
    syncUploadControls();
    return;
  }

  if (!validateUploadFile(file)) {
    uploadFile.value = "";
    state.uploadFileBlob = null;
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
      handlers.say("Transcript loaded. I can analyze this like a practice round.", "listening");
    };
    reader.readAsText(file);
    return;
  }

  if (isVideoFile(file) || file.type.startsWith("audio/")) {
    state.uploadUrl = URL.createObjectURL(file);
    const media = document.createElement(isVideoFile(file) ? "video" : "audio");
    media.controls = true;
    media.src = state.uploadUrl;
    mediaPreview.appendChild(media);
    mediaPreview.classList.remove("hidden");
    state.uploadMedia = media;
    state.uploadFileBlob = file;
    media.addEventListener("loadedmetadata", () => {
      state.uploadDuration = Number.isFinite(media.duration) ? Math.max(Math.round(media.duration), 1) : 60;
      if (state.uploadDuration > UPLOAD_MAX_DURATION_SECONDS) {
        handlers.say(`This upload is ${formatTime(state.uploadDuration)}. Please use a clip under ${formatTime(UPLOAD_MAX_DURATION_SECONDS)}.`, "confused");
        uploadStatus.textContent = `Too long (${formatTime(state.uploadDuration)})`;
        analyzeUploadBtn.disabled = true;
        return;
      }
      syncUploadControls();
    });
    speechStatus.textContent = "Upload media";
    syncUploadControls();
    handlers.say(isVideoFile(file)
      ? "Video loaded. I can review the audio and visual delivery directly; a transcript is optional."
      : "Audio loaded. Add the transcript, then I will give feedback on the presentation.", "listening");
  }
}

async function analyzeUpload() {
  const transcript = uploadTranscript.value.trim();
  const isVideoUpload = state.uploadMedia?.tagName === "VIDEO" && state.uploadFileBlob;

  if (state.uploadFileBlob && !validateUploadFile(state.uploadFileBlob)) return;
  if (isVideoUpload && state.uploadDuration > UPLOAD_MAX_DURATION_SECONDS) {
    handlers.say(`Please trim the video under ${formatTime(UPLOAD_MAX_DURATION_SECONDS)} before analyzing.`, "confused");
    return;
  }

  if (!transcript && !isVideoUpload) {
    handlers.say("I need a transcript for content feedback. Paste the words from the presentation, then analyze again.", "confused");
    uploadTranscript.focus();
    return;
  }

  if (isVideoUpload) {
    try {
      await ensureMediaReady(state.uploadMedia);
      state.uploadDuration = Number.isFinite(state.uploadMedia.duration) ? Math.max(Math.round(state.uploadMedia.duration), 1) : state.uploadDuration;
    } catch {
      handlers.say("I could not read this video's duration. Try exporting it as MP4 or WebM.", "confused");
      return;
    }
    if (state.uploadDuration > UPLOAD_MAX_DURATION_SECONDS) {
      handlers.say(`This upload is ${formatTime(state.uploadDuration)}. Please use a clip under ${formatTime(UPLOAD_MAX_DURATION_SECONDS)}.`, "confused");
      uploadStatus.textContent = `Too long (${formatTime(state.uploadDuration)})`;
      analyzeUploadBtn.disabled = true;
      return;
    }
  }

  state.transcript = transcript;
  state.interim = "";
  state.transcriptEvents = transcript ? [{ atSeconds: 0, text: transcript, type: "upload" }] : [];
  state.liveEvents = [];
  state.timelineEvents = [];
  state.transcriptSegments = transcript ? [{ time: 0, text: transcript }] : [];
  state.eventCooldowns = {};
  handlers.resetInterruptionState();
  transcriptEl.textContent = transcript || "Video uploaded. Gemini will review the recording directly.";
  speechStatus.textContent = "Upload analyzed";
  handlers.setAnalyzing(true, "Preparing upload", isVideoUpload ? "Checking video duration and extracting representative frames." : "Preparing transcript for coaching feedback.");
  analyzeUploadBtn.disabled = true;
  clearUploadBtn.disabled = true;

  const visual = await summarizeUploadVisual();
  let frames = [];
  if (isVideoUpload) {
    recordingPlayback.src = state.uploadUrl;
    reviewPanel.classList.remove("hidden");
    recordingStatus.textContent = "Extracting frames";
    handlers.setAnalyzing(true, "Extracting frames", "Sampling timestamped frames for gaze, posture, and framing feedback.");
    frames = await extractVideoFrames(state.uploadMedia, state.uploadDuration);
    recordingStatus.textContent = frames.length ? `${frames.length} frames sampled` : "Uploaded video";
  }
  handlers.showFeedback({
    transcript,
    durationSeconds: state.uploadDuration || estimateDurationFromTranscript(transcript),
    visual,
    videoBlob: isVideoUpload ? state.uploadFileBlob : null,
    frames,
    preferVideoFeedback: isVideoUpload,
  });
}

async function summarizeUploadVisual() {
  const media = state.uploadMedia;
  if (!media || media.tagName !== "VIDEO" || media.readyState < 2) {
    return { eye: "not measured", eyeScore: 0.45, movement: "not measured", movementScore: 0.45 };
  }

  try {
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    const sample = await handlers.analyzeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
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

async function extractVideoFrames(video, fallbackDuration = 60) {
  if (!video || video.tagName !== "VIDEO") return [];

  try {
    await ensureMediaReady(video);
    const duration = Number.isFinite(video.duration) ? video.duration : fallbackDuration;
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const wasPaused = video.paused;
    const originalTime = video.currentTime;
    const frameCanvas = document.createElement("canvas");
    const aspect = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
    frameCanvas.width = UPLOAD_FRAME_WIDTH;
    frameCanvas.height = Math.round(UPLOAD_FRAME_WIDTH * aspect);
    const frameCtx = frameCanvas.getContext("2d");
    const frames = [];

    for (const time of buildFrameTimes(duration)) {
      await seekMedia(video, time);
      frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
      const dataUrl = frameCanvas.toDataURL("image/jpeg", UPLOAD_FRAME_QUALITY);
      frames.push({
        time: Math.round(time * 10) / 10,
        mimeType: "image/jpeg",
        data: dataUrl.split(",")[1] || "",
        width: frameCanvas.width,
        height: frameCanvas.height,
      });
    }

    await seekMedia(video, Math.min(originalTime, duration));
    if (!wasPaused) video.play().catch(() => {});
    return frames.filter((frame) => frame.data);
  } catch {
    return [];
  }
}

function buildFrameTimes(duration) {
  const targetFps = duration <= 45 ? 2 : duration <= 120 ? 1.5 : 1;
  const interval = 1 / targetFps;
  const start = Math.min(0.35, Math.max(duration * 0.05, 0));
  const end = Math.max(start, duration - 0.25);
  const times = [];

  for (let time = start; time <= end; time += interval) {
    times.push(Math.min(time, end));
  }

  if (times.length <= UPLOAD_FRAME_MAX) return times;
  const sampled = [];
  for (let index = 0; index < UPLOAD_FRAME_MAX; index += 1) {
    const sourceIndex = Math.round((index / Math.max(UPLOAD_FRAME_MAX - 1, 1)) * (times.length - 1));
    sampled.push(times[sourceIndex]);
  }
  return sampled;
}

function ensureMediaReady(media) {
  if (media.readyState >= 2 && Number.isFinite(media.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Media metadata unavailable"));
    };
    const cleanup = () => {
      media.removeEventListener("loadedmetadata", done);
      media.removeEventListener("loadeddata", done);
      media.removeEventListener("error", fail);
    };
    media.addEventListener("loadedmetadata", done, { once: true });
    media.addEventListener("loadeddata", done, { once: true });
    media.addEventListener("error", fail, { once: true });
  });
}

function seekMedia(media, time) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(time, media.duration || time));
    if (Math.abs((media.currentTime || 0) - target) < 0.03 && media.readyState >= 2) {
      resolve();
      return;
    }

    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Media seek failed"));
    };
    const cleanup = () => {
      media.removeEventListener("seeked", done);
      media.removeEventListener("error", fail);
    };
    media.addEventListener("seeked", done, { once: true });
    media.addEventListener("error", fail, { once: true });
    media.currentTime = target;
  });
}

function clearUpload() {
  uploadFile.value = "";
  uploadTranscript.value = "";
  uploadStatus.textContent = "No file";
  state.uploadDuration = 60;
  state.uploadFileBlob = null;
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

function isTextFile(file) {
  return file.type.startsWith("text/") || /\.(txt|md|vtt|srt)$/i.test(file.name);
}

function isVideoFile(file) {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|mpeg|mpg|avi|webm|wmv|flv|3gp|3gpp)$/i.test(file.name);
}

function validateUploadFile(file) {
  if (!file) return false;
  if ((isVideoFile(file) || file.type.startsWith("audio/")) && file.size > UPLOAD_MAX_BYTES) {
    const maxMb = Math.round(UPLOAD_MAX_BYTES / 1024 / 1024);
    handlers.say(`This file is too large. Please upload a media file under ${maxMb} MB.`, "confused");
    uploadStatus.textContent = `Limit ${maxMb} MB`;
    return false;
  }
  return true;
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
