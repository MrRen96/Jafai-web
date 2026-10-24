"use strict";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const sendButton = form.querySelector("button");
const dock = document.querySelector(".composer-dock");
const sessionList = document.querySelector("#session-list");
const sidebar = document.querySelector("#history-sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const storageStatus = document.querySelector("#storage-status");
const exportButton = document.querySelector("#export-chat");
const mobileLayout = window.matchMedia("(max-width: 760px)");
const STORAGE_KEY = "jafai.chatSessions.v1";
const ACTIVE_KEY = "jafai.activeSession.v1";
const emptyState = document.querySelector("#empty-state").cloneNode(true);
let sessions = [];
let activeSessionId = null;
let currentRequest = null;
let saveTimer = null;
let storageReadable = true;
let isSending = false;

function storageWarning(text) {
  storageStatus.textContent = text;
  storageStatus.hidden = !text;
}

function loadSessions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) throw new Error("Invalid history");
    const ids = new Set();
    sessions = stored.map((session) => {
      if (!session || typeof session.id !== "string" || !session.id || ids.has(session.id)
        || typeof session.title !== "string" || !Number.isFinite(Date.parse(session.timestamp))
        || !Array.isArray(session.messages)) throw new Error("Invalid session");
      ids.add(session.id);
      return {
        id: session.id, title: session.title, timestamp: session.timestamp,
        messages: session.messages.map((message) => {
          if (!message || !["user", "assistant"].includes(message.role)
            || typeof message.content !== "string" || !Number.isFinite(Date.parse(message.timestamp))) {
            throw new Error("Invalid message");
          }
          const interrupted = message.status === "streaming";
          return {
            role: message.role,
            content: interrupted ? `${message.content}${message.content ? "\n\n" : ""}Response interrupted. Send your message again to retry.` : message.content,
            timestamp: message.timestamp,
            status: interrupted ? "interrupted" : message.status === "error" || message.status === "interrupted" ? message.status : "complete",
          };
        }),
      };
    });
    const savedActive = localStorage.getItem(ACTIVE_KEY);
    activeSessionId = sessions.some((session) => session.id === savedActive)
      ? savedActive : savedActive === "" ? null : sessions[0]?.id || null;
  } catch {
    sessions = [];
    storageReadable = false;
    storageWarning("Saved history could not be read. Chats will stay in memory for this visit.");
  }
}

function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storageReadable) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_KEY, activeSessionId || "");
    storageWarning("");
    return true;
  } catch {
    storageWarning("History could not be saved. Browser storage may be full or unavailable.");
    return false;
  }
}

function scheduleSave() {
  if (saveTimer === null) saveTimer = setTimeout(saveSessions, 200);
}

function exportActiveChat() {
  if (!activeSessionId) return;
  // Flush pending stream text before reading the saved snapshot for export.
  if ((saveTimer !== null || currentRequest) && !saveSessions()) return;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const session = Array.isArray(stored) ? stored.find((item) => item?.id === activeSessionId) : null;
    if (!session || !Array.isArray(session.messages)) throw new Error("No saved chat");
    const transcript = session.messages.map((message) => {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
        throw new Error("Invalid saved message");
      }
      return message.content.trim() ? `${message.role === "user" ? "USER" : "JAFAI"}: ${message.content}` : "";
    }).filter(Boolean).join("\n\n");
    if (!transcript) throw new Error("Empty chat");

    const date = new Date(session.timestamp).toISOString().slice(0, 10);
    const title = String(session.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const blob = new Blob([`${transcript}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `jafai-chat-${date}${title ? `-${title}` : ""}.txt`;
    link.hidden = true;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      // Allow the browser to start the download before releasing the Blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch {
    storageWarning("This saved chat could not be exported. Check that browser storage is available.");
  }
}

function renderHistory() {
  sessionList.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your conversations will appear here.";
    sessionList.append(empty);
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `session-row${session.id === activeSessionId ? " is-active" : ""}`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";
    if (session.id === activeSessionId) open.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const date = document.createElement("time");
    date.className = "session-date";
    date.dateTime = session.timestamp;
    date.textContent = new Date(session.timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
    open.append(title, date);
    open.addEventListener("click", () => selectSession(session.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "session-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete chat: ${session.title}`);
    remove.addEventListener("click", () => deleteSession(session.id));
    row.append(open, remove);
    sessionList.append(row);
  }
}

function renderConversation() {
  messages.replaceChildren();
  const session = sessions.find((item) => item.id === activeSessionId);
  if (!session?.messages.length) messages.append(emptyState.cloneNode(true));
  for (const message of session?.messages || []) {
    const body = appendMessage(message.role === "user" ? "You" : "JAFAI", message.content, message.timestamp);
    if (["error", "interrupted"].includes(message.status)) body.classList.add("message-body--error");
  }
}

function stopResponse() {
  if (!currentRequest) return;
  const request = currentRequest;
  currentRequest = null;
  request.controller.abort();
  request.reply.content += `${request.reply.content ? "\n\n" : ""}Response stopped.`;
  request.reply.status = "interrupted";
  isSending = false;
  saveSessions();
  updateComposer();
}

function selectSession(id) {
  if (id !== null && !sessions.some((session) => session.id === id)) return;
  if (id !== activeSessionId) stopResponse();
  activeSessionId = id;
  input.value = "";
  renderHistory();
  // Selecting the currently streaming chat must not detach its live bubble.
  if (!currentRequest) renderConversation();
  saveSessions();
  updateComposer();
  if (mobileLayout.matches) setSidebar(false);
  input.focus();
}

function deleteSession(id) {
  const wasActive = id === activeSessionId;
  if (wasActive) stopResponse();
  sessions = sessions.filter((session) => session.id !== id);
  if (wasActive) {
    activeSessionId = sessions[0]?.id || null;
    input.value = "";
    renderConversation();
    updateComposer();
  }
  saveSessions();
  renderHistory();
  input.focus();
}

function setSidebar(open) {
  sidebar.hidden = !open;
  sidebarBackdrop.hidden = !open || !mobileLayout.matches;
  document.querySelector(".app").inert = open && mobileLayout.matches;
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#sidebar-close").focus();
  else sidebarToggle.focus();
}

function updateComposer() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = isSending || !input.value.trim();
  exportButton.disabled = !sessions.some((session) => session.id === activeSessionId && session.messages.some((message) => message.content.trim()));
}

function appendMessage(author, content, timestamp = new Date().toISOString()) {
  const message = document.createElement("article");
  message.className = `message message--${author === "JAFAI" ? "assistant" : "user"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = "message-author";
  name.textContent = author;
  const time = document.createElement("time");
  const now = new Date(timestamp);
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
  let session = sessions.find((item) => item.id === activeSessionId);
  if (!session) {
    session = {
      id: crypto.randomUUID(), title: Array.from(text).slice(0, 30).join(""),
      timestamp: new Date().toISOString(), messages: [],
    };
    sessions.unshift(session);
    activeSessionId = session.id;
  }
  session.timestamp = new Date().toISOString();
  const userMessage = { role: "user", content: text, timestamp: new Date().toISOString(), status: "complete" };
  const assistantMessage = { role: "assistant", content: "", timestamp: new Date().toISOString(), status: "streaming" };
  session.messages.push(userMessage, assistantMessage);
  const request = { controller: new AbortController(), reply: assistantMessage };
  currentRequest = request;
  saveSessions();
  renderHistory();
  document.querySelector("#empty-state")?.remove();
  appendMessage("You", text, userMessage.timestamp);
  input.value = "";
  updateComposer();
  const replyBody = appendMessage("JAFAI", "Thinking…", assistantMessage.timestamp);
  replyBody.setAttribute("aria-busy", "true");
  input.focus();
  let hasReply = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(35000)]),
    });
    if (currentRequest !== request) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Chat is unavailable. Please try again.");
    }
    await readChatStream(response, (text) => {
      if (currentRequest !== request) return;
      if (!hasReply) { replyBody.textContent = ""; hasReply = true; }
      const span = document.createElement("span");
      span.className = "fade-in-word";
      span.textContent = text;
      replyBody.append(span);
      assistantMessage.content += text;
      scheduleSave();
      messages.scrollTop = messages.scrollHeight;
    });
    if (currentRequest === request) assistantMessage.status = "complete";
  } catch (error) {
    if (currentRequest !== request) return;
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
    assistantMessage.content = replyBody.textContent;
    assistantMessage.status = "error";
    // Preserve the failed message for retry without replacing a new draft.
    if (!input.value) input.value = text;
  } finally {
    if (currentRequest === request) {
      replyBody.setAttribute("aria-busy", "false");
      currentRequest = null;
      isSending = false;
      saveSessions();
      updateComposer();
      messages.scrollTop = messages.scrollHeight;
    }
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

sidebarToggle.addEventListener("click", () => setSidebar(true));
exportButton.addEventListener("click", exportActiveChat);
document.querySelector("#sidebar-close").addEventListener("click", () => setSidebar(false));
sidebarBackdrop.addEventListener("click", () => setSidebar(false));
document.querySelector("#new-chat").addEventListener("click", () => selectSession(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !sidebar.hidden) setSidebar(false);
});
mobileLayout.addEventListener("change", () => setSidebar(!mobileLayout.matches));
window.addEventListener("pagehide", saveSessions);
loadSessions();
renderHistory();
renderConversation();
setSidebar(!mobileLayout.matches);
updateComposer();
