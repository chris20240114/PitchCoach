import { state } from "./state.js";

export function analyzeAudioFrame(buffer, sampleRate) {
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

  return { rms, db, peak, voiced, pitchHz, pitchDelta, pauseMs: state.recentPauseMs, atSeconds: getElapsedSecondsFallback() };
}

export function volumeLabel(db) {
  if (db > -18) return "strong";
  if (db > -26) return "clear";
  if (db > -34) return "soft";
  return "too quiet";
}

export function volumeScore(db) {
  if (db > -18) return 0.9;
  if (db > -26) return 0.72;
  if (db > -34) return 0.48;
  return 0.24;
}

export function energyLabel(sample) {
  if (!sample.voiced) return "waiting";
  if (sample.peak > 0.2) return "animated";
  if (sample.peak > 0.1) return "steady";
  return "flat";
}

export function energyScore(sample) {
  if (!sample.voiced) return 0.4;
  if (sample.peak > 0.2) return 0.9;
  if (sample.peak > 0.1) return 0.66;
  return 0.34;
}

export function pitchLabel(sample) {
  if (!sample.pitchHz) return "listening";
  if (sample.pitchDelta > 28) return "varied";
  if (sample.pitchDelta > 12) return "moderate";
  return "narrow";
}

export function pitchScore(sample) {
  if (!sample.pitchHz) return 0.4;
  if (sample.pitchDelta > 28) return 0.88;
  if (sample.pitchDelta > 12) return 0.62;
  return 0.32;
}

export function pauseLabel(sample) {
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

export function pauseScore(sample) {
  if (sample.pauseMs > 1100) return 0.3;
  if (sample.pauseMs > 420) return 0.84;
  if (sample.voiced) return 0.46;
  return 0.58;
}

export function audioFeedbackText(sample) {
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

function getElapsedSecondsFallback() {
  return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
}
