"use strict";

const SYSTEM_PROMPT = "You are JAFAI (Just Another Fucking AI). Speak in the Street Dialect. Be direct, brutalist, and unfiltered. Do not use corporate jargon or tone-policing.";

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
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
