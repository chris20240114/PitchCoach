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

  try {
    if (process.env.GEMINI_API_KEY) {
      const geminiFeedback = await requestGeminiFeedback(payload);
      sendJson(response, 200, { ...fallback, ...geminiFeedback, source: "gemini" });
      return;
    }

    if (process.env.OPENAI_API_KEY) {
      const openAiFeedback = await requestOpenAiFeedback(payload);
      sendJson(response, 200, { ...fallback, ...openAiFeedback, source: "openai" });
      return;
    }

    sendJson(response, 200, { ...fallback, source: "local" });
  } catch (error) {
    console.error("AI feedback failed:", error);
    sendJson(response, 200, { ...fallback, source: "local", warning: "AI provider unavailable; used local fallback." });
  }
}

async function requestGeminiFeedback(payload) {
  const prompt = buildCoachPrompt(payload);
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: geminiFeedbackSchema,
      },
    }),
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`Gemini request failed with ${result.status}: ${body}`);
  }

  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();

  if (!text) {
    throw new Error("Gemini response did not include JSON text.");
  }

  return JSON.parse(text);
}

async function requestOpenAiFeedback(payload) {
  const prompt = buildCoachPrompt(payload);

  const result = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.4,
      text: {
        format: {
          type: "json_schema",
          name: "pitchmirror_feedback",
          strict: true,
          schema: feedbackSchema,
        },
      },
    }),
  });

  if (!result.ok) {
    throw new Error(`LLM request failed with ${result.status}`);
  }

  const data = await result.json();
  const text = extractResponseText(data);

  if (!text) {
    throw new Error("LLM response did not include JSON text.");
  }

  return JSON.parse(text);
}

function buildCoachPrompt(payload) {
  return [
    "You are PitchMirror, a direct but constructive AI presentation coach.",
    "Evaluate the user's practice presentation using the supplied context, transcript, delivery signals, and session timeline.",
    "Return coaching that feels like a real audience member, not a generic report.",
    "Use short, specific feedback. Mention only observable delivery signals.",
    "Do not diagnose emotions. You may describe observable expression, gaze, head position, posture, pacing, and energy changes.",
    "For avatarState, choose listening, nodding, confused, or speaking.",
    "Adapt criteria to the presentation type and audience. A pitch needs problem and impact; a class presentation needs definitions and structure; an interview answer needs evidence and tradeoffs; a sales demo needs customer pain and next step.",
    "Use timeline observations when helpful, especially changes near the opening, strongest point, and ending.",
    "Prioritize: audience fit, message clarity, structure, specificity, evidence, pacing, filler words, gaze, head movement, face visibility, and ending strength.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

const metricSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    value: { type: "string" },
    score: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["label", "value", "score"],
};

const feedbackSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    coachResponse: { type: "string" },
    avatarState: { type: "string", enum: ["listening", "nodding", "confused", "speaking"] },
    delivery: {
      type: "array",
      items: metricSchema,
      minItems: 5,
      maxItems: 5,
    },
    content: {
      type: "array",
      items: metricSchema,
      minItems: 5,
      maxItems: 5,
    },
    suggestedRewrite: { type: "string" },
    followupQuestion: { type: "string" },
  },
  required: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion"],
};

const geminiMetricSchema = {
  type: "OBJECT",
  properties: {
    label: { type: "STRING" },
    value: { type: "STRING" },
    score: { type: "NUMBER" },
  },
  required: ["label", "value", "score"],
  propertyOrdering: ["label", "value", "score"],
};

const geminiFeedbackSchema = {
  type: "OBJECT",
  properties: {
    coachResponse: { type: "STRING" },
    avatarState: { type: "STRING", enum: ["listening", "nodding", "confused", "speaking"] },
    delivery: {
      type: "ARRAY",
      minItems: 5,
      maxItems: 5,
      items: geminiMetricSchema,
    },
    content: {
      type: "ARRAY",
      minItems: 5,
      maxItems: 5,
      items: geminiMetricSchema,
    },
    suggestedRewrite: { type: "STRING" },
    followupQuestion: { type: "STRING" },
  },
  required: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion"],
  propertyOrdering: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion"],
};

function extractResponseText(data) {
  if (data.output_text) return data.output_text;

  return data.output
    ?.flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("")
    .trim();
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
    avatarState: scores.problem < 6 ? "confused" : "speaking",
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
    followupQuestion: followupFor(payload?.context || {}),
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

function followupFor(context) {
  if (context.presentationType === "interview-answer") return "What tradeoff did you make, and what would you change with another week?";
  if (context.audienceType === "investor") return "Who urgently needs this, and why will they choose you over the current workaround?";
  if (context.presentationType === "teaching") return "What concept should your audience remember five minutes after you finish?";
  if (context.presentationType === "sales-demo") return "What customer pain does the demo prove you can solve today?";
  return "What is the one sentence you want this audience to remember?";
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
