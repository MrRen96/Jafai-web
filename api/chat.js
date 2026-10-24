"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const SYSTEM_PROMPT = `You are JAFAI (Just Another Fucking AI). Speak in the Street Dialect with the calm, quiet confidence of a seasoned intelligence officer or a street-smart mentor. Be direct, matter-of-fact, and grounded. Avoid aggressive introductions, theatrical toughness, and lists of what you are not.

Write in natural, conversational paragraphs. Avoid excessive bold text and numbered lists for simple answers. Use a list only when necessary, with a maximum of 3 short bullet points.

Conserve Mana: the user may be tired. Be concise and give the structural truth directly. Keep answers short unless the user asks for depth or the subject needs it.

Keep the Fear and Invoice diagnostic lens, the Street Dialect, and the refusal to use corporate smoothing or jargon. Apply the framework with calm clarity rather than aggression. Use Knowledge V1 for substance; these tone and formatting rules govern how you express it.`;

async function buildSystemPrompt() {
  try {
    const knowledge = (await fs.readFile(path.join(process.cwd(), "knowledge-v1.txt"), "utf8")).trim();
    if (knowledge) {
      return `${SYSTEM_PROMPT}\n\nHere is your Knowledge Base (Knowledge V1). Use it to inform your answers, but do not quote it word-for-word unless necessary:\n${knowledge}`;
    }
    console.warn("[JAFAI] knowledge-v1.txt is empty. Using the base system prompt.");
  } catch (error) {
    console.warn(`[JAFAI] Could not read knowledge-v1.txt (${error.code || "read error"}). Using the base system prompt.`);
  }
  return SYSTEM_PROMPT;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to send a message." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }

  const message = body?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 10000) {
    return res.status(400).json({ error: "Message must contain between 1 and 10,000 characters." });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ error: "Chat is not configured. Set DEEPSEEK_API_KEY on the server." });
  }

  try {
    const systemPrompt = await buildSystemPrompt();
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message.trim() },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(25000),
    });

    // Keep provider errors and credentials out of client responses.
    if (!response.ok) {
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429
          ? "Chat is busy. Please try again shortly."
          : "The AI service could not complete the request. Please try again.",
      });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      return res.status(502).json({ error: "The AI service returned an empty response. Please try again." });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "The AI service took too long to respond. Please try again."
        : "Unable to reach the AI service. Please try again.",
    });
  }
};
