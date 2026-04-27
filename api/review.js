import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Missing GEMINI_API_KEY environment variable",
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const { transcript = "", metrics = {} } = req.body || {};

    const prompt = `
You are a presentation coach.

Analyze this presentation transcript and audio metrics.

Transcript:
${transcript}

Audio metrics:
${JSON.stringify(metrics, null, 2)}

Give concise feedback with:
1. Main strengths
2. Problems to fix
3. Specific practice advice
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    return res.status(200).json({
      feedback: response.text,
    });
  } catch (error) {
    console.error("Gemini API error:", error);

    return res.status(500).json({
      error: "Failed to generate feedback",
      details: error.message,
    });
  }
}