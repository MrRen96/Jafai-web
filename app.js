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

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(35000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || "Chat is unavailable. Please try again.");
    }
    if (typeof data?.reply !== "string" || !data.reply.trim()) {
      throw new Error("Chat returned an invalid response. Please try again.");
    }
    replyBody.textContent = data.reply;
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    replyBody.textContent = timedOut
      ? "The request timed out. Please try again."
      : `Could not send: ${error.message || "Check your connection and try again."}`;
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
