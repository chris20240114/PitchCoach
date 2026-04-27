export function formatTime(seconds) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

export function paceLabel(wpm) {
  if (wpm > 180) return `${wpm} wpm, too fast`;
  if (wpm > 155) return `${wpm} wpm, slightly fast`;
  if (wpm < 95) return `${wpm} wpm, slow`;
  return `${wpm} wpm, clear`;
}

export function paceScore(wpm) {
  if (wpm >= 110 && wpm <= 155) return 0.9;
  if (wpm >= 95 && wpm <= 180) return 0.58;
  return 0.28;
}

export function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

export function clampScore(value) {
  return Math.max(1, Math.min(10, value));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function samplePitch() {
  return "So basically we made an AI thing that uses vision and audio and it is kind of like a coach. It watches and listens in real time and gives feedback for presentations.";
}
