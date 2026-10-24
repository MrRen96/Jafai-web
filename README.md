# JAFAI

A vanilla HTML, CSS, and JavaScript chat frontend with a Vercel Serverless backend.

Deploy this directory to Vercel using the Other framework preset, no build
command, and the project root as the output directory. Add `DEEPSEEK_API_KEY`
in the project's environment variables for the environments you use, then
deploy (or redeploy after changing the key). The key stays on the server.

For local development, use `npx vercel dev` with `DEEPSEEK_API_KEY` in
`.env.local` (see `.env.example`). Opening `index.html` directly or using a
static-only server will display the UI but cannot run `/api/chat`.

Type a message and press Enter or click the arrow to send. Shift+Enter adds a
new line. The frontend posts `{ "message": "..." }` to `/api/chat`, which
returns DeepSeek's raw server-sent events (SSE), or a JSON `error` before the
stream begins. The browser decodes content deltas incrementally into fading
text spans, scrolling as the answer grows. Reduced-motion preferences disable
the animation. Interrupted streams retain partial text with an inline error.
Sending is disabled during a
request; failures appear inline and restore the message for retry if there
is no newer draft. Messages exist only for the current page session.

The backend sends the current message and the JAFAI system prompt to
`https://api.deepseek.com/v1/chat/completions` using `deepseek-chat`, exactly as
requested. Earlier messages are displayed locally but are not sent as context.
The provider request times out after 25 seconds; the function allows 30 seconds.
No SDK or runtime dependencies are required (use a current Vercel Node.js runtime).

The model name is deliberately fixed to the requested `deepseek-chat`; current
DeepSeek documentation lists newer model names. Verify its availability with
your account before relying on it in production.

Run `node --test` to exercise the backend and frontend with mocked requests.

Paste Knowledge V1 into the root `knowledge-v1.txt` file as UTF-8 text, then
deploy the updated file. The function reads it on each request and appends it
to the system prompt. Missing, unreadable, or blank knowledge files produce a
server console warning and fall back to the base prompt. The file starts empty.
`vercel.json` explicitly includes it in the function bundle. The full text is
sent to DeepSeek with each message, so it must fit the model's context limit.

`jafai-logo.png` is a copy of the supplied `Image conpets/Jafai Logo.png`.
