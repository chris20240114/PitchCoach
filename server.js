import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnv();

const port = Number(getCliPort() || process.env.PORT || 3000);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/feedback") {
      await handleFeedback(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/video-feedback") {
      await handleVideoFeedback(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error("Open the existing server at that port, stop the process using it, or run: npm run dev:3001");
    process.exit(1);
  }

  throw error;
});

server.listen(port, () => {
  console.log(`PitchCoach server running at http://localhost:${port}`);
});

function getCliPort() {
  const index = process.argv.indexOf("--port");
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

async function serveStatic(pathname, response, headOnly) {
  const cleanPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = normalize(join(root, cleanPath));

  if (!filePath.startsWith(root)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (!headOnly) response.end(body);
    else response.end();
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function handleFeedback(request, response) {
  const payload = await readJsonBody(request);
  const fallback = buildFallbackFeedback(payload);

  if (!process.env.LLM_API_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    sendJson(response, 200, { ...fallback, source: "local" });
    return;
  }

  try {
    const llmFeedback = await requestLlmFeedback(payload);
    sendJson(response, 200, { ...fallback, ...llmFeedback, source: "llm" });
  } catch (error) {
    console.error("LLM feedback failed:", error);
    sendJson(response, 200, { ...fallback, source: "local", warning: "LLM unavailable; used local fallback." });
  }
}

async function handleChat(request, response) {
  const payload = await readJsonBody(request);
  const fallback = buildFallbackChat(payload);

  if (!process.env.LLM_API_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    sendJson(response, 200, { answer: fallback, source: "local" });
    return;
  }

  try {
    const answer = await requestLlmChat(payload);
    sendJson(response, 200, { answer, source: "llm" });
  } catch (error) {
    console.error("LLM chat failed:", error);
    sendJson(response, 200, { answer: fallback, source: "local", warning: "LLM unavailable; used local fallback." });
  }
}

async function handleVideoFeedback(request, response) {
  const payload = await readJsonBody(request);

  if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL || !payload?.videoData) {
    sendJson(response, 200, { performanceNotes: [], source: "local" });
    return;
  }

  try {
    const performanceNotes = await requestGeminiVideoFeedback(payload);
    sendJson(response, 200, { performanceNotes, source: "llm" });
  } catch (error) {
    console.error("Gemini video feedback failed:", error);
    sendJson(response, 200, { performanceNotes: [], source: "local", warning: "Video feedback unavailable." });
  }
}

async function requestLlmFeedback(payload) {
  const prompt = [
    "You are PitchMirror, a direct but constructive AI presentation coach.",
    "Evaluate this pitch using the supplied transcript and delivery signals.",
    "Return only JSON with keys: coachResponse, delivery, content, performanceNotes, suggestedRewrite, followupQuestion.",
    "delivery and content must be arrays of objects with label, value, and score from 0 to 1.",
    "performanceNotes must be an array of up to 6 objects with time, type, label, and detail. Use exact seconds from the supplied timeline when available.",
    "If transcriptSegments are supplied, use their time values to identify wording moments by second.",
    "Call out specific wording issues, eye drift, volume, pause, or pitch variation at the relevant second.",
    "Do not overclaim emotion detection. Mention visual signals only as observable behavior.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");

  const result = await fetch(process.env.LLM_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });

  if (!result.ok) {
    throw new Error(`LLM request failed with ${result.status}`);
  }

  const data = await result.json();
  const text = data.choices?.[0]?.message?.content || data.output_text;

  if (!text) {
    throw new Error("LLM response did not include JSON text.");
  }

  return JSON.parse(text);
}

async function requestLlmChat(payload) {
  const context = payload?.context || {};
  const history = Array.isArray(payload?.history) ? payload.history.slice(-8) : [];
  const question = String(payload?.question || "").trim();
  const prompt = [
    "You are PitchMirror, a concise AI presentation coach.",
    "Answer the user's follow-up question using the pitch transcript, delivery signals, and feedback context.",
    "Be specific and actionable. Do not invent details that are not in the context.",
    "Return only JSON with key: answer.",
    "",
    JSON.stringify({ question, context }, null, 2),
  ].join("\n");

  const result = await fetch(process.env.LLM_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [
        ...history.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: String(item.content || ""),
        })),
        { role: "user", content: prompt },
      ],
      temperature: 0.35,
      response_format: { type: "json_object" },
    }),
  });

  if (!result.ok) {
    throw new Error(`LLM chat request failed with ${result.status}`);
  }

  const data = await result.json();
  const text = data.choices?.[0]?.message?.content || data.output_text;
  if (!text) throw new Error("LLM chat response did not include JSON text.");

  const parsed = JSON.parse(text);
  return parsed.answer || buildFallbackChat(payload);
}

async function requestGeminiVideoFeedback(payload) {
  const context = payload?.context || {};
  const prompt = [
    "You are PitchMirror reviewing a recorded practice pitch video.",
    "Return only JSON with key performanceNotes.",
    "performanceNotes must be an array of up to 8 objects with time, type, label, and detail.",
    "Use timestamps in seconds. Types must be one of: eye, wording, audio, pause, posture.",
    "Call out observable moments only: eye drift, face leaving frame, posture/head movement, awkward pause, unclear wording, low energy, or delivery mismatch.",
    "Prefer timestamps visible in the video/audio. Use the supplied context only as support.",
    "",
    JSON.stringify(context, null, 2),
  ].join("\n");

  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.LLM_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.LLM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: payload.mimeType || "video/webm",
              data: payload.videoData,
            },
          },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0.25,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!result.ok) {
    throw new Error(`Gemini video request failed with ${result.status}`);
  }

  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) throw new Error("Gemini video response did not include JSON text.");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.performanceNotes) ? parsed.performanceNotes : [];
}

function buildFallbackChat(payload) {
  const question = String(payload?.question || "").toLowerCase();
  const feedback = payload?.context?.feedback || {};

  if (question.includes("rewrite") || question.includes("say") || question.includes("怎么说") || question.includes("改写") || question.includes("重写") || question.includes("怎么改")) {
    return feedback.suggestedRewrite || "Start with the audience's problem, then give one concrete proof point and a clear ask.";
  }

  if (question.includes("eye") || question.includes("camera") || question.includes("眼神") || question.includes("镜头")) {
    return "Use the camera as the audience member. Hold eye contact on your strongest sentence, then glance away only during natural transitions.";
  }

  if (question.includes("pace") || question.includes("speed") || question.includes("语速")) {
    return "Add a short pause after the problem sentence and before the demo sentence. That usually makes the pitch feel more controlled.";
  }

  return feedback.coachResponse || "Focus on one concrete improvement from the feedback, then practice the same pitch once more.";
}

function buildFallbackFeedback(payload) {
  const transcript = String(payload?.transcript || "");
  const words = transcript.match(/\b[\w'-]+\b/g) || [];
  const durationSeconds = Math.max(Number(payload?.durationSeconds || 60), 1);
  const wpm = Math.round((words.length / durationSeconds) * 60);
  const fillers = countFillers(transcript);
  const scores = scoreContent(transcript);
  const visual = payload?.visual || {};

  return {
    coachResponse: buildCoachResponse(wpm, fillers.total, scores, visual),
    delivery: [
      { label: "Speaking pace", value: paceLabel(wpm), score: paceScore(wpm) },
      { label: "Eye contact", value: visual.eye || "not measured", score: Number(visual.eyeScore ?? 0.45) },
      { label: "Filler words", value: String(fillers.total), score: fillers.total <= 4 ? 0.9 : fillers.total <= 9 ? 0.55 : 0.25 },
      { label: "Pauses", value: wpm > 165 ? "too few" : "workable", score: wpm > 165 ? 0.35 : 0.75 },
      { label: "Energy", value: visual.movement || "not measured", score: Number(visual.movementScore ?? 0.45) },
    ],
    content: [
      { label: "Clear problem", value: `${scores.problem}/10`, score: scores.problem / 10 },
      { label: "Specific user", value: `${scores.user}/10`, score: scores.user / 10 },
      { label: "Demo clarity", value: `${scores.demo}/10`, score: scores.demo / 10 },
      { label: "Impact", value: `${scores.impact}/10`, score: scores.impact / 10 },
      { label: "Call to action", value: scores.cta > 5 ? `${scores.cta}/10` : "missing", score: scores.cta / 10 },
    ],
    suggestedRewrite: buildRewrite(scores),
    followupQuestion: followupFor(payload?.audience || "hackathon"),
  };
}

function scoreContent(transcript) {
  const text = transcript.toLowerCase();
  const has = (terms) => terms.some((term) => text.includes(term));
  return {
    problem: clampScore(3 + (has(["problem", "struggle", "pain", "hard", "waste", "miss", "too late"]) ? 4 : 0) + (has(["because", "so that", "which means"]) ? 2 : 0)),
    user: clampScore(3 + (has(["student", "founder", "judge", "teacher", "developer", "team", "customer", "user"]) ? 4 : 0) + (has(["for ", "when they", "who "]) ? 1 : 0)),
    demo: clampScore(3 + (has(["demo", "shows", "watch", "listen", "real time", "feedback", "dashboard"]) ? 4 : 0) + (has(["example", "for instance"]) ? 1 : 0)),
    impact: clampScore(2 + (has(["before", "improve", "save", "confidence", "better", "faster", "practice"]) ? 4 : 0) + (has(["high-stakes", "interview", "presentation", "pitch"]) ? 2 : 0)),
    cta: clampScore(2 + (has(["try", "use", "join", "next", "ask", "looking for", "we need"]) ? 5 : 0)),
  };
}

function buildCoachResponse(wpm, fillers, scores, visual) {
  if (scores.problem < 6) return "Pause. Your pitch needs a clearer pain point. Start with who is struggling, then explain what changes when your product works.";
  if (wpm > 170) return `You are speaking clearly, but the pace is fast at about ${wpm} words per minute. Add a pause after your main problem sentence.`;
  if (fillers > 8) return `You used ${fillers} filler words. Replace them with short pauses, especially before the demo explanation.`;
  if (Number(visual.eyeScore || 0) < 0.5) return "The content is landing, but your camera presence is inconsistent. Look into the camera during your strongest sentence.";
  return "Much better. The structure is clear. Now add one concrete proof point so a judge remembers why this matters.";
}

function buildRewrite(scores) {
  if (scores.problem < 6 || scores.user < 6) {
    return "Instead of starting with the technology, start with the person: 'Students practicing important presentations usually get feedback too late. PitchMirror watches and listens in real time, then tells them what the audience actually heard and saw.'";
  }

  if (scores.cta < 6) {
    return "Keep your current opening, then end with a clear ask: 'Today we want judges to test a 60-second pitch and tell us whether the feedback feels like a real coach.'";
  }

  return "Tighten the strongest version into one sentence: 'PitchMirror is a live AI audience member that helps students and founders fix delivery and content before the real room is watching.'";
}

function followupFor(audience) {
  if (audience === "interview") return "What tradeoff did you make, and what would you change with another week?";
  if (audience === "investor") return "Who urgently needs this, and why will they choose you over the current workaround?";
  return "What is the one moment in your demo that proves this is more than a concept?";
}

function countFillers(transcript) {
  const matches = transcript.toLowerCase().match(/\b(um|uh|like|basically|actually|literally|kind of|sort of|you know)\b/g) || [];
  return { total: matches.length };
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

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function loadEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
