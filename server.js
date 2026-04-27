import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnv();

const port = Number(getCliPort() || process.env.PORT || 3000);
const maxJsonBodyBytes = 145 * 1024 * 1024;
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
    if (error.message === "Request body too large.") {
      sendJson(response, 413, { error: "Upload is too large. Please use a shorter or smaller video." });
      return;
    }
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

async function handleChat(request, response) {
  const payload = await readJsonBody(request);
  const fallback = buildFallbackChat(payload);

  try {
    if (!process.env.GEMINI_API_KEY) {
      sendJson(response, 200, { answer: fallback, source: "local" });
      return;
    }

    const answer = await requestGeminiChat(payload);
    sendJson(response, 200, { answer, source: "gemini" });
  } catch (error) {
    console.error("Gemini chat failed:", error);
    sendJson(response, 200, { answer: fallback, source: "local", warning: "Gemini unavailable; used local fallback." });
  }
}

async function handleVideoFeedback(request, response) {
  const payload = await readJsonBody(request);

  try {
    if (!process.env.GEMINI_API_KEY || !payload?.videoData) {
      sendJson(response, 200, { performanceNotes: [], source: "local" });
      return;
    }

    const videoFeedback = await requestGeminiVideoFeedback(payload);
    sendJson(response, 200, { ...videoFeedback, source: "gemini" });
  } catch (error) {
    console.error("Gemini video feedback failed:", error);
    sendJson(response, 200, { performanceNotes: [], source: "local", warning: "Gemini video unavailable." });
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

async function requestGeminiChat(payload) {
  const prompt = buildChatPrompt(payload);
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
        temperature: 0.45,
        responseMimeType: "application/json",
        responseSchema: geminiChatSchema,
      },
    }),
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`Gemini chat failed with ${result.status}: ${body}`);
  }

  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini chat response did not include JSON text.");
  return JSON.parse(text).answer;
}

async function requestGeminiVideoFeedback(payload) {
  const prompt = buildVideoPrompt(payload);
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const mimeType = normalizeVideoMime(payload.mimeType, payload.fileName);
  if (!mimeType) throw new Error(`Unsupported video MIME type: ${payload.mimeType || payload.fileName || "unknown"}`);
  const videoBuffer = Buffer.from(payload.videoData, "base64");
  const videoPart = videoBuffer.byteLength > 18 * 1024 * 1024
    ? await uploadGeminiFile({ buffer: videoBuffer, mimeType, displayName: payload.fileName || "practice-video" })
    : {
      inlineData: {
        mimeType,
        data: payload.videoData,
      },
    };
  const frameParts = normalizeFrameParts(payload.frames);
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
          parts: [
            videoPart,
            ...frameParts,
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.25,
        responseMimeType: "application/json",
        responseSchema: geminiVideoSchema,
      },
    }),
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`Gemini video request failed with ${result.status}: ${body}`);
  }

  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini video response did not include JSON text.");
  const parsed = JSON.parse(text);
  return {
    ...parsed,
    performanceNotes: normalizePerformanceNotes(parsed.performanceNotes),
  };
}

function normalizeFrameParts(frames = []) {
  if (!Array.isArray(frames)) return [];
  return frames
    .slice(0, 80)
    .filter((frame) => frame?.data && Number.isFinite(Number(frame.time)))
    .flatMap((frame) => [
      { text: `Sampled frame at ${formatSeconds(Number(frame.time))}.` },
      {
        inlineData: {
          mimeType: frame.mimeType || "image/jpeg",
          data: frame.data,
        },
      },
    ]);
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(value));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

async function uploadGeminiFile({ buffer, mimeType, displayName }) {
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  if (!start.ok) {
    const body = await start.text();
    throw new Error(`Gemini file upload start failed with ${start.status}: ${body}`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload did not return an upload URL.");

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });

  if (!upload.ok) {
    const body = await upload.text();
    throw new Error(`Gemini file upload failed with ${upload.status}: ${body}`);
  }

  const data = await upload.json();
  const file = await waitForGeminiFile(data.file);
  return {
    fileData: {
      mimeType: file.mimeType || mimeType,
      fileUri: file.uri,
    },
  };
}

async function waitForGeminiFile(file) {
  if (!file?.name) throw new Error("Gemini file upload response did not include a file name.");
  let current = file;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (!current.state || current.state === "ACTIVE") return current;
    if (current.state === "FAILED") throw new Error("Gemini file processing failed.");
    await delay(2500);
    const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/${current.name}`, {
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
    });
    if (!result.ok) {
      const body = await result.text();
      throw new Error(`Gemini file polling failed with ${result.status}: ${body}`);
    }
    current = await result.json();
  }
  throw new Error("Gemini file processing timed out.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          name: "pitchcoach_feedback",
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
    "You are PitchCoach, a direct but constructive AI presentation coach.",
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

function buildChatPrompt(payload) {
  return [
    "You are PitchCoach, a practical live presentation coach.",
    "Answer the user's follow-up question using the previous transcript, delivery metrics, visual observations, timeline moments, and feedback.",
    "Be specific and concise. Do not invent emotional diagnoses. Refer only to observable behavior and wording.",
    "Return JSON with one field: answer.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildVideoPrompt(payload) {
  return [
    "You are PitchCoach, a direct but constructive AI presentation coach reviewing an uploaded practice video.",
    "Evaluate both what the speaker says and how they deliver it, using the video/audio plus the extra timestamped sampled frames.",
    "If speech is audible, infer a practical transcript-level understanding from the audio. Do not require the user to paste a transcript.",
    "Return the same dashboard shape as normal coaching, an inferredTranscript, plus up to 6 timestamped performanceNotes.",
    "The sampled frames may be higher frequency than the model's default video sampling. Use them for gaze, notes-reading, head movement, posture, and framing.",
    "Use only observable cues: face visibility, gaze direction, head movement, posture, gestures, volume, pacing, pauses, vocal energy, and spoken wording.",
    "Do not infer anxiety, confidence, truthfulness, political beliefs, personality, or protected traits.",
    "For avatarState, choose listening, nodding, confused, or speaking.",
    "For content metrics, score clarity, structure, specificity, evidence, and impact for the selected presentation type and audience.",
    "Each performance note needs time in seconds, type, label, and detail. Allowed type values: eye, audio, pause, posture, wording.",
    "If the audio is unclear, inferredTranscript can be a short summary of the spoken content instead of a verbatim transcript.",
    "",
    JSON.stringify(payload.context || {}, null, 2),
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

const performanceNoteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    time: { type: "number" },
    type: { type: "string", enum: ["eye", "audio", "pause", "posture", "wording"] },
    label: { type: "string" },
    detail: { type: "string" },
  },
  required: ["time", "type", "label", "detail"],
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
    performanceNotes: {
      type: "array",
      items: performanceNoteSchema,
      minItems: 0,
      maxItems: 8,
    },
  },
  required: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion", "performanceNotes"],
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

const geminiPerformanceNoteSchema = {
  type: "OBJECT",
  properties: {
    time: { type: "NUMBER" },
    type: { type: "STRING", enum: ["eye", "audio", "pause", "posture", "wording"] },
    label: { type: "STRING" },
    detail: { type: "STRING" },
  },
  required: ["time", "type", "label", "detail"],
  propertyOrdering: ["time", "type", "label", "detail"],
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
    performanceNotes: {
      type: "ARRAY",
      minItems: 0,
      maxItems: 8,
      items: geminiPerformanceNoteSchema,
    },
  },
  required: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion", "performanceNotes"],
  propertyOrdering: ["coachResponse", "avatarState", "delivery", "content", "suggestedRewrite", "followupQuestion", "performanceNotes"],
};

const geminiChatSchema = {
  type: "OBJECT",
  properties: {
    answer: { type: "STRING" },
  },
  required: ["answer"],
  propertyOrdering: ["answer"],
};

const geminiVideoSchema = {
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
    inferredTranscript: { type: "STRING" },
    suggestedRewrite: { type: "STRING" },
    followupQuestion: { type: "STRING" },
    performanceNotes: {
      type: "ARRAY",
      minItems: 0,
      maxItems: 6,
      items: geminiPerformanceNoteSchema,
    },
  },
  required: ["coachResponse", "avatarState", "delivery", "content", "inferredTranscript", "suggestedRewrite", "followupQuestion", "performanceNotes"],
  propertyOrdering: ["coachResponse", "avatarState", "delivery", "content", "inferredTranscript", "suggestedRewrite", "followupQuestion", "performanceNotes"],
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
    performanceNotes: buildFallbackPerformanceNotes(scores, visual, wpm, fillers.total),
  };
}

function buildFallbackChat(payload) {
  const question = String(payload?.question || "").toLowerCase();
  const context = payload?.context || {};
  const feedback = context.feedback || {};

  if (question.includes("rewrite") || question.includes("better version")) {
    return feedback.suggestedRewrite || "Start with the audience problem, then give one concrete example and end with a clear next step.";
  }

  if (question.includes("eye") || question.includes("camera")) {
    return "Use the recording timeline to find the eye-contact markers. Practice saying your strongest sentence while looking directly into the lens, then glance away only between thoughts.";
  }

  if (question.includes("pace") || question.includes("fast") || question.includes("slow")) {
    return "Mark one pause after the problem sentence and one before the closing ask. Those two pauses usually make the whole delivery feel more controlled.";
  }

  return feedback.coachResponse || "Pick one improvement first: clarify the audience problem, add a concrete example, or strengthen the closing ask.";
}

function buildFallbackPerformanceNotes(scores, visual, wpm, fillerCount) {
  const notes = [];
  if (scores.problem < 6) notes.push({ time: 5, type: "wording", label: "Problem clarity", detail: "The opening needs a clearer audience problem before the solution." });
  if (Number(visual.eyeScore || 0) < 0.55) notes.push({ time: 12, type: "eye", label: "Eye contact", detail: "Review this section for camera drift and re-lock on the lens." });
  if (wpm > 170) notes.push({ time: 18, type: "audio", label: "Pacing", detail: "This section may feel rushed. Add a pause after the main point." });
  if (fillerCount > 6) notes.push({ time: 24, type: "wording", label: "Filler words", detail: "Replace filler words with a short pause before continuing." });
  return notes;
}

function normalizePerformanceNotes(notes = []) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, 8).map((note) => ({
    time: Number.isFinite(Number(note.time)) ? Number(note.time) : Number(note.second || 0),
    type: normalizeNoteType(note.type),
    label: String(note.label || "Review moment"),
    detail: String(note.detail || note.value || ""),
  }));
}

function normalizeNoteType(type = "wording") {
  if (["eye", "audio", "pause", "posture", "wording"].includes(type)) return type;
  if (["volume", "pitch", "energy"].includes(type)) return "audio";
  if (["gesture", "movement", "head"].includes(type)) return "posture";
  return "wording";
}

function normalizeVideoMime(mimeType = "", fileName = "") {
  const declared = String(mimeType || "").toLowerCase();
  const name = String(fileName || "").toLowerCase();
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
    return "Instead of starting with the technology, start with the person: 'Students practicing important presentations usually get feedback too late. PitchCoach watches and listens in real time, then tells them what the audience actually heard and saw.'";
  }

  if (scores.cta < 6) {
    return "Keep your current opening, then end with a clear ask: 'Today we want judges to test a 60-second pitch and tell us whether the feedback feels like a real coach.'";
  }

  return "Tighten the strongest version into one sentence: 'PitchCoach is a live AI audience member that helps students and founders fix delivery and content before the real room is watching.'";
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
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxJsonBodyBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
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
