import { clampScore } from "./utils.js";

export function followupForContext(context) {
  if (context.presentationType === "interview-answer") return "What tradeoff did you make, and what would you change with another week?";
  if (context.audienceType === "investor") return "Who urgently needs this, and why will they choose you over the current workaround?";
  if (context.presentationType === "teaching") return "What concept should your audience remember five minutes after you finish?";
  if (context.presentationType === "sales-demo") return "What customer pain does the demo prove you can solve today?";
  return "What is the one sentence you want this audience to remember?";
}

export function scoreContent(transcript) {
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

export function buildRewrite(transcript, scores) {
  if (scores.problem < 6 || scores.user < 6) {
    return "Instead of starting with the technology, start with the person: 'Students practicing important presentations usually get feedback too late. PitchCoach watches and listens in real time, then tells them what the audience actually heard and saw.'";
  }

  if (scores.cta < 6) {
    return "Keep your current opening, then end with a clear ask: 'Today we want judges to test a 60-second pitch and tell us whether the feedback feels like a real coach.'";
  }

  return "Tighten the strongest version into one sentence: 'PitchCoach is a live AI audience member that helps students and founders fix delivery and content before the real room is watching.'";
}

export function buildSpokenFeedback(wpm, fillers, scores, visual, audio = {}) {
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

export function countFillers(transcript) {
  const matches = transcript.toLowerCase().match(/\b(um|uh|like|basically|actually|literally|kind of|sort of|you know)\b/g) || [];
  return { total: matches.length, matches };
}
