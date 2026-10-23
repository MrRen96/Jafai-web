"use strict";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const sendButton = form.querySelector("button");
const dock = document.querySelector(".composer-dock");

function updateComposer() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = !input.value.trim();
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
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  document.querySelector("#empty-state")?.remove();
  appendMessage("You", text);
  input.value = "";
  updateComposer();
  appendMessage("JAFAI", "Awaiting backend connection...");
  input.focus();
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
