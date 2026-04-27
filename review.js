import {
  eventTimeline,
  momentDetail,
  momentText,
  momentTitle,
  recordingPlayback,
  recordingStatus,
  reviewPanel,
  timelineStatus,
} from "./dom.js";
import { state } from "./state.js";
import { formatTime } from "./utils.js";

export function normalizePerformanceNotes(notes, fallbackNotes = []) {
  if (!Array.isArray(notes) || notes.length === 0) return fallbackNotes || [];
  return notes.slice(0, 8).map((note, index) => ({
    time: Number.isFinite(Number(note.time)) ? Number(note.time) : Number(note.second ?? fallbackNotes[index]?.time ?? 0),
    type: normalizeNoteType(note.type || fallbackNotes[index]?.type),
    label: note.label || fallbackNotes[index]?.label || "Review moment",
    detail: note.detail || note.value || fallbackNotes[index]?.detail || "",
  }));
}

export function normalizeNoteType(type = "moment") {
  if (["eye", "wording", "audio", "pause", "posture"].includes(type)) return type;
  if (["volume", "pitch", "energy"].includes(type)) return "audio";
  if (["gesture", "movement", "head"].includes(type)) return "posture";
  return "wording";
}

export function mergeTimelineNotes(primary = [], secondary = []) {
  const merged = [...normalizePerformanceNotes(primary, []), ...normalizePerformanceNotes(secondary, [])];
  const seen = new Set();
  return merged
    .sort((a, b) => a.time - b.time)
    .filter((note) => {
      const key = `${Math.round(note.time)}:${note.type}:${note.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

export function renderTimeline(notes) {
  const normalized = normalizePerformanceNotes(notes, []);
  eventTimeline.innerHTML = "";
  timelineStatus.textContent = normalized.length ? `${normalized.length} moments` : "No moments";
  reviewPanel.classList.remove("hidden");
  hideMomentDetail();

  if (!normalized.length) return;

  const duration = Math.max(recordingPlayback.duration || state.lastFeedbackContext?.durationSeconds || getElapsedSecondsFallback() || 60, 1);
  normalized.forEach((note) => {
    const button = document.createElement("button");
    button.className = `timeline-marker ${note.type}`;
    button.type = "button";
    button.style.left = `${Math.min(Math.max((Number(note.time) / duration) * 100, 1), 99)}%`;
    button.setAttribute("aria-label", `${formatTime(Math.round(note.time))} ${note.label}`);
    button.addEventListener("mouseenter", () => showMomentDetail(note));
    button.addEventListener("focus", () => showMomentDetail(note));
    button.addEventListener("mouseleave", hideMomentDetail);
    button.addEventListener("blur", hideMomentDetail);
    button.addEventListener("click", () => {
      if (recordingPlayback.src) {
        recordingPlayback.pause();
        recordingPlayback.currentTime = Math.max(0, Math.min(Number(note.time), duration));
      }
      showMomentDetail(note);
    });
    eventTimeline.appendChild(button);
  });
}

export function clearRecordingReview() {
  reviewPanel.classList.add("hidden");
  eventTimeline.innerHTML = "";
  hideMomentDetail();
  timelineStatus.textContent = "Waiting";
  recordingStatus.textContent = "No recording";
  recordingPlayback.removeAttribute("src");
  recordingPlayback.load();
  if (state.recordingUrl && state.recordingUrl !== state.uploadUrl) URL.revokeObjectURL(state.recordingUrl);
  state.recordingUrl = "";
  state.recordingBlob = null;
}

function showMomentDetail(note) {
  momentDetail.classList.remove("hidden");
  timelineStatus.textContent = "Selected";
  momentTitle.textContent = `${formatTime(Math.round(note.time))} ${note.label}`;
  momentText.textContent = note.detail;
}

function hideMomentDetail() {
  momentDetail.classList.add("hidden");
  momentTitle.textContent = "";
  momentText.textContent = "";
}

function getElapsedSecondsFallback() {
  return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
}
