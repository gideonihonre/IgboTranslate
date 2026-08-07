# How this application actually works, end to end

This document explains, in full detail, what happens from the moment someone
opens the app to the moment they hear translated Igbo speech — every file,
every function, and every technology involved, in the order they run. It
reflects the code as it exists right now (not the original design, which has
since changed in several places — noted where relevant).

There are two independent programs that make up "the app":

1. **The backend** — a Python web server (`speech-to-speech-backend/`) that
   does the actual speech-to-speech translation work.
2. **The frontend** — a React Native / Expo phone app
   (`Speech-Translation-App-Frontend-main/Speech-Translation-App-Frontend-main/`)
   that records the user's voice and talks to the backend over the network.

They communicate over plain HTTP. The frontend does not do any translation or
speech processing itself — it just records audio, sends it to the backend,
and plays back whatever audio the backend sends in return.

---

## Part 1 — The full journey of one recording, step by step

This is the complete path from "user taps the button" to "Igbo audio plays,"
naming every function involved in order.

1. **User opens the app.** `app/index.tsx` renders a 2-second black splash
   screen (a `useEffect` with `setTimeout`), then calls
   `router.replace('/home')` to navigate to the real screen. This is the
   `expo-router` file-based router — the file's *name and location* under
   `app/` determines the route; `index.tsx` is `/`, `home.tsx` is `/home`.

2. **`app/home.tsx` renders.** It calls the `useAudioRecorder()` hook
   (defined in `hooks/AudioRecorder.tsx`) to get recording state and two
   functions, `startRecording` and `stopRecording`. It renders one big round
   button. `onPress` is wired to call `startRecording` if not currently
   recording, or `stopRecording` if currently recording — the same button
   toggles between the two.

3. **User taps to start recording → `startRecording()` runs**
   (`hooks/AudioRecorder.tsx`):
   - Asks for microphone permission via `expo-av`'s `Audio.requestPermissionsAsync()`.
   - Configures the audio session with `Audio.setAudioModeAsync(...)` (needed
     on iOS so recording works even if the phone's silent switch is on).
   - Starts recording with `Audio.Recording.createAsync(HIGH_QUALITY preset)`.
   - Saves the resulting `recording` object to React state and flips
     `isRecording` to `true` (this is what makes the button's next tap call
     `stopRecording` instead).

4. **User taps again to stop → `stopRecording()` runs**
   (`hooks/AudioRecorder.tsx`, the core of the app):
   - Guards against being called twice at once (see "double-tap guard" note
     below), then calls `recording.stopAndUnloadAsync()` and reads the
     recorded file's local URI with `recording.getURI()`.
   - Sets `status` to `"transcribing"` (drives the on-screen status text in
     `home.tsx`).
   - Builds a multipart `FormData` containing the recorded audio file:
     - On a phone (iOS/Android): appends `{ uri, name: "recording.m4a", type:
       "audio/m4a" }` directly — React Native's `fetch` knows how to read a
       local file URI when given this shape.
     - On web: fetches the recording's blob URL and appends the actual
       `Blob`, since a plain `{uri,...}` object doesn't work in a browser.
   - Sends it with `fetch(`${BACKEND_URL}/speak`, { method: "POST", body:
     form })` — a single HTTP request to the backend. `BACKEND_URL` is a
     hardcoded constant at the top of the file (currently the developer's
     laptop LAN IP, `http://192.168.5.210:7860` — see "Known constraints"
     below).
   - **Everything from here until the response is entirely the backend's
     job** (see Part 2). The frontend just waits on this one `fetch` call.
   - When the response arrives, it's JSON: `{ text, audio_base64 }`. `text`
     (the Igbo translation) is stored in `outputText`/`transcription`
     (rendered on screen). `status` becomes `"synthesising"`, and
     `audio_base64` is handed to `playAudioResponse()`.
   - `playAudioResponse()`: writes the base64 string to a temporary local
     file with `expo-file-system`'s `writeAsStringAsync(..., {encoding:
     Base64})`, then plays that file with `Audio.Sound.createAsync({uri},
     {shouldPlay:true})`. When playback finishes, it deletes the temp file.
   - `status` returns to `"waiting"`, and `isRecording`/`isSaving` reset, in
     the `finally` block, whether or not anything above threw.

5. **Meanwhile, inside that one `fetch` call, the backend does everything**
   (`speech-to-speech-backend/main.py`, endpoint `POST /speak`):
   - `transcribe(file)` (`stt.py`) — sends the uploaded audio to
     **AssemblyAI** (a paid/free-tier third-party speech-to-text API) and
     gets back English text.
   - `translate_to_igbo(text)` (`translate.py`) — sends that English text to
     **Google Translate**, not via Google's official paid API, but via the
     `translators` Python package, which scrapes Google Translate's public
     web interface for a free translation to Igbo (`to_language="ig"`).
   - `synthesize_igbo(translated_text)` (`tts.py`) — turns the Igbo text into
     spoken audio using **YarnGPT** (a Igbo/Nigerian-language text-to-speech
     model, loaded from Hugging Face) plus **WavTokenizer** (the vocoder that
     turns YarnGPT's audio tokens into an actual waveform). Returns a
     base64-encoded WAV string.
   - `main.py` bundles the Igbo text and the base64 audio into one JSON
     response and returns it — this is what step 4 above receives.

That's the entire pipeline. One button tap, one HTTP request, three backend
steps chained together, one audio playback.

---

## Part 2 — Backend, file by file

Location: `speech-to-speech-backend/`. A single FastAPI app, run inside
Docker (image tag `s2s`), listening on port 7860.

### `main.py` — the web server / router
- Creates the FastAPI `app`.
- `lifespan()`: on server startup (not per-request), calls `load_tts()` once
  so the (slow) model load happens at boot instead of on the first user's
  request.
- `CORSMiddleware` with `allow_origins=["*"]`: lets any frontend origin call
  this API (needed since the RN app calls it directly from a phone/browser).
- `GET /` — health check, returns `{"status": "ok"}`.
- `POST /transcribe` — exposes `stt.transcribe()` alone, for debugging the
  speech-to-text step without running the whole pipeline.
- `POST /speak` — the real endpoint (see Part 1, step 5). Calls `transcribe`
  → `translate_to_igbo` → `synthesize_igbo` in sequence and returns
  `{text, audio_base64}`. Returns HTTP 400 if AssemblyAI found no speech.

### `stt.py` — speech-to-text
- `transcribe(file)`: validates the file extension
  (`.m4a/.mp3/.wav/.flac/.mp4`), writes the upload to a temp file (AssemblyAI's
  client needs a file path, not an in-memory stream), and calls
  `aai.Transcriber().transcribe(...)`. Cleans up the temp file in a `finally`
  block regardless of outcome. Requires `ASSEMBLYAI_API_KEY` (read from the
  environment at import time via `os.getenv`).

### `translate.py` — English → Igbo translation
- `translate_to_igbo(text)`: calls `translators.translate_text(text,
  to_language="ig", translator="google", is_detail_result=True)`. This
  library works by scraping Google Translate's web UI response — no API key
  needed, but more fragile/rate-limit-prone under real traffic than a paid
  API would be (this is a known, accepted tradeoff, documented in the code
  comment). Picks the translated text and detected source language back out
  of Google's raw nested JSON response shape.

### `tts.py` — Igbo text → Igbo speech
- Loads **YarnGPT**'s source code at import time: it isn't published on
  PyPI, so the Dockerfile `git clone`s it straight into the image
  (`/app/yarngpt_src`), and this file adds that folder to Python's import
  path so it can `import audiotokenizer`.
- `load_tts()`: loads two things once (guarded by a `None` check so repeated
  calls are cheap after the first):
  - `AudioTokenizerForLocal` (from the vendored YarnGPT source) — wraps the
    **WavTokenizer** vocoder, whose config/weights are baked into the Docker
    image (`/app/assets/...`).
  - The YarnGPT language model itself, `AutoModelForCausalLM` from
    Hugging Face's `transformers` library, downloaded from the repo named by
    `HF_PATH` (defaults to the public `saheedniyi/YarnGPT-local`).
- `synthesize_igbo(text)`: builds a YarnGPT prompt tagged for Igbo with a
  specific voice (`"igbo_male2"`), tokenizes it, runs the language model's
  `.generate(...)` (beam search, `num_beams=4` — this is the slowest part of
  the whole pipeline on CPU-only hosting), decodes the output tokens back
  into a raw waveform via the vocoder, and encodes that waveform as a WAV
  file in memory (`soundfile`), then returns it as a base64 string (so the
  existing RN playback code, which expects base64, needs no changes).

### `Dockerfile` — how the image is built
- Base: `python:3.11-slim`.
- System packages: `git`/`wget` (fetch YarnGPT source + model weights at
  build time), `ffmpeg`/`libsndfile1` (audio codecs `torchaudio` needs at
  runtime), `build-essential` (C compiler, needed because one of
  `outetts`'s transitive dependencies, `pesq`, ships as C source rather than
  a prebuilt wheel).
- Installs CPU-only `torch`/`torchaudio` from PyTorch's dedicated CPU wheel
  index (much smaller than the default CUDA-bundled build — this is a
  CPU-only deployment target).
- Clones YarnGPT's source, installs `requirements.txt`, downloads the
  WavTokenizer config + checkpoint from Hugging Face straight into the
  image (baked in at build time, not downloaded per-container-start).
- Exposes port 7860 (Hugging Face Spaces' expected default) and runs
  `uvicorn main:app`.

### `requirements.txt` — Python dependencies
`fastapi`, `uvicorn` (web server), `python-multipart` (file upload parsing),
`python-dotenv` (loads `.env`), `assemblyai` (STT client), `translators`
(translation), `outetts`/`transformers`/`uroman`/`inflect`/`huggingface_hub`
(YarnGPT's own dependency stack), `soundfile` (WAV encode/decode). `torch`/
`torchaudio` are deliberately *not* here — installed separately in the
Dockerfile from the CPU wheel index instead.

### `.env` (not committed)
Holds `ASSEMBLYAI_API_KEY`, read by `stt.py`. Passed into the container via
`docker run --env-file .env`.

---

## Part 3 — Frontend, file by file

Location:
`Speech-Translation-App-Frontend-main/Speech-Translation-App-Frontend-main/`.
An Expo (React Native) app, SDK 54, using `expo-router` for file-based
routing.

### Entry point and routing
- `package.json`'s `"main": "expo-router/entry"` is the actual JS entry
  point — it hands control to `expo-router`, which then looks at the `app/`
  folder to build the route tree.
- `app/_layout.tsx` — the root layout, wraps every screen. Currently wraps
  everything in a `ConvexProvider` (see Part 4 — this is dead weight,
  nothing under it uses Convex) and renders an `expo-router` `<Stack>` with
  headers hidden.
- `app/index.tsx` — route `/`. Shows a black splash screen for 2 seconds
  (`setTimeout`), then redirects to `/home` via `router.replace`.
- `app/home.tsx` — route `/home`, the actual (only) functional screen. Pure
  UI: a big animated round button (scales down on press-in via
  `Animated.spring`), status text, and transcript/translation text. All the
  real logic lives in the `useAudioRecorder()` hook it calls — this file
  just renders hook state and wires button taps to `startRecording`/
  `stopRecording`.
- `app/+not-found.tsx` — `expo-router`'s special filename for a 404/unknown
  route screen. Only reachable if the app is navigated to a route that
  doesn't exist (not part of the normal user flow, but not dead code either
  — it's the router's built-in fallback).

### `hooks/AudioRecorder.tsx` — the app's core logic
Everything described in Part 1, steps 3–4, lives here: `startRecording`,
`stopRecording`, `playAudioResponse`, the `BACKEND_URL` constant, and the
`isStoppingRef` double-tap guard. This is the one file that was rewritten to
talk to the Python backend instead of Convex (see Part 4 for what it used to
do).

### `hooks/useColorScheme.ts` / `useColorScheme.web.ts` / `useThemeColor.ts`
Part of Expo's default starter template (light/dark theme detection and a
helper to pick a themed color). Not currently used by anything in the app —
see Part 5.

### `components/`
All leftover from Expo's default tab-app starter template:
`ThemedText`/`ThemedView` (theme-aware text/view — the *only* two of this
group actually used, and only by `+not-found.tsx`), `HelloWave`,
`Collapsible`, `ParallaxScrollView`, `HapticTab`, `ui/IconSymbol`,
`ui/TabBarBackground`. See Part 5 for which of these are dead.

### `constants/Colors.ts`
Light/dark color palette, part of the same starter template. Only ever
consumed by `useThemeColor.ts`, which itself isn't used elsewhere — see
Part 5.

### `app.json` — Expo config
Declares the app name/slug, icon, splash screen, and the `expo-router`,
`expo-splash-screen`, `expo-font`, `expo-web-browser` plugins (the config
plugins Expo needs to wire those packages into the native build). No
backend URL or environment-specific config lives here — `BACKEND_URL` is
hardcoded in `AudioRecorder.tsx` instead.

### `package.json` — dependencies
Notable ones actually exercised by the running app: `expo`/`expo-router`
(app shell + routing), `expo-av` (recording + playback — see the
deprecation note below), `expo-file-system` (writing the temp playback
file), `react-native-reanimated`+`react-native-worklets` (used by
`Animated.spring` under the hood via the New Architecture), `@react-navigation/*`
(used internally by `expo-router`, not called directly by app code). Several
other dependencies are unused — see Part 5.

---

## Part 4 — What Convex used to do here (removed)

Convex (a backend-as-a-service platform) was the *original* architecture,
before the Python backend existed. It's since been removed from this
project entirely — this section is kept only as historical context for why
some things looked the way they did.

It used to host three serverless functions that the frontend called
directly:

- `convex/audio.ts` → `transcribeAudio` — called AssemblyAI directly from a
  Convex function (JS SDK), given base64 audio.
- `convex/translate.ts` → `translateToIgbo` — called Google Cloud
  Translate's official paid API (needs a `GOOGLE_APPLICATION_CREDENTIALS`
  service-account JSON).
- `convex/tts.ts` → `textToSpeech` — called out to a *separate*, older TTS
  server that was running standalone behind an ngrok tunnel (hardcoded URL
  in the file, `https://amusing-skilled-giraffe.ngrok-free.app/generate`) —
  this is the predecessor to today's `tts.py`/YarnGPT setup, and that ngrok
  tunnel is not expected to still be running.

`hooks/AudioRecorder.tsx` used to call all three of these in sequence via
Convex's `useAction` hook. That was fully replaced by the single `fetch` to
the Python backend's `/speak` endpoint described in Part 1, which made the
whole Convex layer dead weight. It has now been deleted:
- The `convex/` folder (all four functions plus generated bindings),
  `sampleData.jsonl`, and the local `.env.local` Convex created are gone.
- `app/_layout.tsx` no longer wraps the app in `ConvexProvider`/
  `ConvexReactClient` — it just renders the `<Stack>` directly.
- `package.json` no longer lists `convex`, `@google-cloud/text-to-speech`,
  `@google-cloud/translate`, or the JS `assemblyai` client — each of those
  existed solely to serve one of the three deleted functions.
- Run `npm install` once to let `node_modules`/`package-lock.json` catch up
  with the trimmed `package.json`.

---

## Part 5 — Components that do NOT contribute to the app's current operation

Everything below exists in the repo but is not exercised by the actual
record → translate → speak flow. Nothing here needs to work for the app to
function today.

### Removed entirely (previously dead, now deleted)
- **Convex** — `convex/audio.ts`, `convex/translate.ts`, `convex/tts.ts`,
  `convex/tasks.ts` (plus generated bindings), `sampleData.jsonl`, and the
  `ConvexProvider`/`ConvexReactClient` wrapper in `app/_layout.tsx` have all
  been deleted — see Part 4. `package.json` no longer lists `convex`,
  `@google-cloud/text-to-speech`, `@google-cloud/translate`, or the JS
  `assemblyai` client either.

### Entirely dead — not called from anywhere in the running app
- **`hooks/useColorScheme.ts`**, **`hooks/useColorScheme.web.ts`**,
  **`hooks/useThemeColor.ts`**, **`constants/Colors.ts`** — light/dark theme
  plumbing from Expo's starter template. `home.tsx` hardcodes its own colors
  instead of using these.
- **`components/HelloWave.tsx`**, **`components/Collapsible.tsx`**,
  **`components/ParallaxScrollView.tsx`**, **`components/HapticTab.tsx`**,
  **`components/ui/IconSymbol.tsx`** (+ `.ios.tsx`),
  **`components/ui/TabBarBackground.tsx`** (+ `.ios.tsx`) — all part of
  Expo's default tab-based demo app, never imported by `home.tsx`,
  `index.tsx`, or `_layout.tsx`.
- **`components/__tests__/ThemedText-test.tsx`** (+ its snapshot) — a test
  for `ThemedText`, which itself is barely used (only by the 404 screen).
  The test still runs under `npm test`, but validates nothing about the
  actual translation feature.

### Present but not part of the normal user path (not "dead," just not exercised)
- **`app/+not-found.tsx`** — only renders if the router hits an undefined
  route, which doesn't happen in normal use (there's no navigation UI that
  could reach it). It does still use `ThemedText`/`ThemedView`, which is why
  those two aren't in the fully-dead list above.
- **`GET /transcribe`** in `main.py` — a real, working endpoint, but it
  exists only for manually debugging the speech-to-text step in isolation;
  the app itself only ever calls `/speak`.

### Installed but unused (package.json dependencies with no reachable import)
- `@google-cloud/speech`, `@google/genai` — not imported by any remaining
  source file (they weren't even imported by the deleted Convex functions;
  these were unused independent of the Convex removal in Part 4).
- `dotenv` — not imported anywhere in the frontend source either. (The
  Python `python-dotenv` used by the backend's `main.py` is a separate,
  still-used dependency in `requirements.txt` — different ecosystem,
  same name.)
- `file-system` — an npm package name collision risk to note: the app
  actually uses Expo's own `expo-file-system` (imported as `expo-file-system`
  in `AudioRecorder.tsx`); the plain `file-system` package in
  `dependencies` is a different, unrelated package that nothing imports.

### Known constraint worth flagging (not dead code, but fragile)
- `BACKEND_URL` in `hooks/AudioRecorder.tsx` is a hardcoded LAN IP
  (`http://192.168.5.210:7860`). It only works when the phone and the
  laptop running the Docker backend are on the same Wi-Fi network, and only
  as long as the laptop's IP doesn't change. It will need to become the
  Hugging Face Spaces URL once the backend is deployed there.
- `expo-av` (recording/playback in `AudioRecorder.tsx`) is deprecated by
  Expo — SDK 54 is the last version that ships it; it's removed entirely in
  SDK 55, in favor of `expo-audio`. Not broken today, but the next SDK
  upgrade will require migrating `AudioRecorder.tsx`'s recording/playback
  calls.
