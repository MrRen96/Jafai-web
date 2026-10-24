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

Store Knowledge V1 as UTF-8 `.txt` files directly inside `knowledge/`, then deploy
the updated files. The existing manifesto is in `knowledge/knowledge-v1.txt`.
On each request, the function loads text files in filename order and joins their
contents with blank lines before appending them to the system prompt. Other
file types and subdirectories are ignored. Blank files are skipped; unreadable
files generate a warning without preventing other files from loading. An empty
or missing folder falls back to the base prompt. Server logs report the number
of non-empty files loaded. `vercel.json` includes `knowledge/**` in the function
bundle. The combined text is sent with each message and must fit the model's
context limit.

`jafai-logo.png` is a copy of the supplied `Image conpets/Jafai Logo.png`.
