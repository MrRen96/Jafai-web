"use strict";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const sendButton = form.querySelector("button");
const dock = document.querySelector(".composer-dock");
let isSending = false;

function updateComposer() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = isSending || !input.value.trim();
}

function appendMessage(author, content) {
  const message = document.createElement("article");
  message.className = `message message--${author === "JAFAI" ? "assistant" : "user"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = "message-author";
  name.textContent = author;
  const time = document.createElement("time");
  const now = new Date();
  time.className = "message-time";
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.append(name, time);

  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = content;
  message.append(meta, body);
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
  return body;
}

async function readChatStream(response, onText) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Chat returned an invalid stream. Please try again.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let receivedText = "";

  function processEvent(event) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return; // Ignore keep-alive comments and metadata.
    if (data.trim() === "[DONE]") { finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { throw new Error("Chat returned an invalid stream. Please try again."); }
    if (chunk.error) throw new Error("The AI service interrupted the response. Please try again.");
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      receivedText += text;
      onText(text);
    }
  }

  function drainEvents() {
    let boundary;
    while (!finished && (boundary = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      processEvent(event);
    }
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      drainEvents();
      if (done) {
        if (!finished && buffer.trim()) processEvent(buffer);
        break;
      }
    }
    if (!finished) throw new Error("The response was interrupted. Please try again.");
    if (!receivedText.trim()) throw new Error("The AI service returned an empty response. Please try again.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || isSending) return;

  isSending = true;
  document.querySelector("#empty-state")?.remove();
  appendMessage("You", text);
  input.value = "";
  updateComposer();
  const replyBody = appendMessage("JAFAI", "Thinking…");
  replyBody.setAttribute("aria-busy", "true");
  input.focus();
  let hasReply = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Chat is unavailable. Please try again.");
    }
    await readChatStream(response, (text) => {
      if (!hasReply) { replyBody.textContent = ""; hasReply = true; }
      const span = document.createElement("span");
      span.className = "fade-in-word";
      span.textContent = text;
      replyBody.append(span);
      messages.scrollTop = messages.scrollHeight;
    });
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const errorText = timedOut
      ? "The request timed out. Please try again."
      : `Could not send: ${error.message || "Check your connection and try again."}`;
    if (hasReply) {
      const notice = document.createElement("span");
      notice.className = "stream-error";
      notice.textContent = `\n\n${errorText}`;
      replyBody.append(notice);
    } else {
      replyBody.textContent = errorText;
    }
    replyBody.classList.add("message-body--error");
    replyBody.setAttribute("role", "alert");
    // Preserve the failed message for retry without replacing a new draft.
    if (!input.value) input.value = text;
  } finally {
    replyBody.setAttribute("aria-busy", "false");
    isSending = false;
    updateComposer();
    messages.scrollTop = messages.scrollHeight;
  }
});

input.addEventListener("input", updateComposer);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Reserve the actual composer height as the textarea grows, including on mobile.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--dock-height", `${dock.offsetHeight}px`);
  messages.scrollTop = messages.scrollHeight;
}).observe(dock);

updateComposer();
