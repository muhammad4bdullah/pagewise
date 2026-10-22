# Pagewise

A no-build, browser-first PDF study tool. It extracts and displays PDF text on your device, finds the document's bookmarks when available, and can explain each page, answer questions, and talk with you using a natural AI voice.

## Start it

1. Double-click `start-local.bat` (or run `python -m http.server 8000` in this folder).
2. Use the browser page it opens at `http://localhost:8000`. Do not open `index.html` directly from the file system; browsers restrict PDF workers, API requests, and microphone access on `file://` pages.
3. Choose a PDF. To enable AI, open **Voice & AI settings**, create a Gemini API key at [Google AI Studio](https://aistudio.google.com/app/apikey), paste it in, choose a text model, and click **Save settings**. **Check model access** lists text models exposed to that key but cannot report remaining quota. **Test AI connection** reports text and Live Voice results separately, even if the text request fails; its text probe allows 256 output tokens and includes candidate finish/block details when text is empty. The Live probe distinguishes a WebSocket timeout from a setup timeout, with a 30-second limit. The text check may use quota. If a check fails, follow its error; API keys restricted by website referrer must allow your localhost address.

The local web server only serves these static files. There is no app server, account, build step, or paid hosting required. PDF.js is loaded from a public CDN, so the first load needs an internet connection.

## Publish with GitHub Pages

This repository includes a GitHub Actions workflow that publishes the static site when changes are pushed to `main`. Create a GitHub repository, push this project to its `main` branch, then open **Settings → Pages** and set the publishing source to **GitHub Actions**. The workflow deploys the site files and the included OCR sample PDF under `assets/`; it does not publish the README or local server script. The first workflow run publishes the site at `https://<your-github-username>.github.io/<repository-name>/`. The site and sample book are public, so never commit a Gemini API key; each user enters their own key in the browser.

## What it does

- Reads selectable PDF text in the browser and follows embedded chapter bookmarks. When there are no bookmarks, it guesses headings and falls back to page groups.
- Shows one page at a time with previous/next and chapter navigation.
- Supplies up to 10 consecutive pages of extracted text as study context. Requests such as “explain pages 203–205” include that exact range, with page labels; Live Voice can retrieve other page ranges without changing the visible page. For explicitly requested multi-page ranges, page images are included where available.
- Includes an optional OCR sample book that visitors can load from the home screen without choosing a local file.
- Uses Gemini for page explanations and chapter questions, with streamed text replies from the AI teacher, Zeemal. Zeemal introduces themself with “I’m Zeemal, very intelligent. How can I help you?” Page lessons are prompted to cover important ideas in order, explain them thoroughly with examples, and continue in parts when a page is too dense for one reply. Zeemal is instructed to answer only in English, even when a question is asked in another language.
- Lets you select a text model and check which text models are listed for your API key. Retired Gemini 2.5 Flash choices are excluded, and a previously saved selection is migrated to Gemini 3.8 Flash. After any Gemini model response error, Pagewise checks available models and tries each alternative once for that question; the first one that works is saved and used until it errors. Network failures do not trigger model rotation. Model listing does not test remaining quota, and fallback requests after quota errors can incur charges if billing is enabled.
- **Teach from here** explains pages in order and reads each lesson with generated Gemini Flash TTS audio. It can be paused and resumed.
- **Talk to your teacher** uses Gemini 3.8 Live for a real-time, bidirectional voice session. When you ask it to teach a page or concept, it is instructed to give a fuller, example-led spoken lesson and has a larger response-token budget; quick follow-up questions can still get concise answers. You can interrupt, ask questions, and say things like “go to chapter 3”; the tutor can navigate the outline. The Live Voice panel shows Gemini-reported token usage over the rolling last 60 seconds and the reported total for the current Live session, when usage metadata is supplied; these are not a quota meter or a prediction. Pagewise no longer intentionally disconnects Live Voice when its tab is hidden and tries to resume suspended audio when you return. Browsers and operating systems may still throttle or suspend background tabs; keep Pagewise open and visible for the most reliable listening and playback.
- Saves up to 80 recent chat messages per PDF in this browser and restores them when the same PDF is opened again. The conversation menu clears both the visible chat and its saved local memory.
- Uses a browser speech voice if generated audio is unavailable.
- Shows the returned connection error when text AI, generated voice, or Live Voice cannot connect. Temporary Gemini text-service overloads (HTTP 503) are retried automatically; quota/rate-limit errors are reported so you can check usage in Google AI Studio.

## $0 setup and privacy

The files and local app have no charge. Gemini free-tier access depends on account eligibility and model-specific quotas; a model appearing in the model list does not mean it has remaining quota, and no model is guaranteed unlimited. Provider limits and terms can change. If you need a hard $0 ceiling, do not enable billing for the Gemini project. See [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).

The app never sends a user-opened PDF file itself. PDF text is extracted locally. When you ask the AI teacher something, the app sends up to 10 consecutive pages of extracted text and a rendered image of the current page to Gemini; when you ask about an explicit page range, it also sends rendered images of those pages when available. Live voice sends microphone audio to Gemini while the session is active and can retrieve page text for a requested range. Recent chat history is stored in this browser's local storage, separate for each PDF, and can be removed with the conversation menu. The included OCR sample PDF is publicly downloadable from the site. Gemini receives the AI key directly from your browser; the key is kept in session storage by default, or local storage if you choose **Remember on this browser**. Use this as a personal tool and do not publish a copy containing your key.

Scanned-only PDFs can be read page by page through the rendered page image in AI mode, but their local text pane will be empty. Reading progress is not saved after the tab closes.

## Files

- `index.html` — page layout and controls
- `styles.css` — visual design and responsive layout
- `app.js` — PDF, tutor, voice, and navigation behavior
