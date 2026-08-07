# Handoff — Speech-to-Speech: backend proven, React Native wired up, not yet confirmed on-device

**For:** Claude Code, working across two folders on the user's Windows machine
(Git Bash / MINGW64):
- Backend: `speech-to-speech-backend`
- Frontend: `Speech-Translation-App-Frontend-main/Speech-Translation-App-Frontend-main`

**Plain-language note for how to work with this user:** explain things in plain
language, define unfamiliar terms on first use, lead with the bottom line before
details, and do one thing at a time. Avoid dumping architecture + code + caveats
in a single message. The user often prefers to run terminal commands themselves
rather than have them run for them — offer the exact command and let them run
it, rather than assuming permission to execute long-lived/foreground processes.

---

## Where things stand right now

- The backend is a single FastAPI app. One main endpoint, `POST /speak`:
  audio in (English speech) -> transcribe (AssemblyAI) -> translate to Igbo
  (the `translators` package) -> synthesize Igbo speech (YarnGPT + WavTokenizer)
  -> returns JSON `{ "text": <igbo text>, "audio_base64": <base64 wav> }`.
- **The Docker image is built and the pipeline is proven end-to-end.** Tag: `s2s`.
  A test run against a real audio clip produced `result.json` and a decoded
  `out.wav` with intelligible Igbo speech in the backend folder — this
  milestone (previously "Step 1–5" in this doc) is DONE. Do not re-litigate it.
- **The React Native app has been wired to call `/speak` directly.** In
  `hooks/AudioRecorder.tsx`, the three Convex `useAction` calls
  (`transcribeAudio`, `translateToIgbo`, `textToSpeech`) were removed and
  replaced with a single `fetch` to the backend's `/speak` endpoint. See
  "Frontend changes made" below for exact details.
- **Not yet done: confirming this actually works on a physical phone.** The
  code is written and frontend dependencies are installed, but nobody has
  pressed record in the actual Expo Go app yet and heard Igbo audio come back
  through this new path. That's the next milestone.

## The single most important next action

**Run `npx expo start` in the frontend folder, open the app in Expo Go on a
phone on the same Wi-Fi network, record something, and confirm Igbo audio
plays back.** Everything after this (HF Spaces deployment, shared-secret
header) is blocked until this passes.

---

## Backend: how it was proven (for reference — already done)

1. `.env` file created in `speech-to-speech-backend/` with the user's
   AssemblyAI key (a previously-pasted key was treated as compromised; the
   user generated a fresh one).
2. `docker run -p 7860:7860 --env-file .env --name s2s-server s2s` — starts
   cleanly, logs `Uvicorn running on http://0.0.0.0:7860 (Press CTRL+C to quit)`.
   First startup is slow (downloads the YarnGPT model from Hugging Face); later
   startups are faster.
3. `curl http://localhost:7860/` → `{"status":"ok"}`.
4. `curl -X POST http://localhost:7860/speak -F "file=@test.m4a" -o result.json`
   → JSON with `text` (Igbo) and `audio_base64`.
5. Decoded `audio_base64` to `out.wav` and confirmed it's intelligible Igbo
   speech.

The four fixes that got the image to build in the first place (import path fix
in `tts.py`, base64 JSON response, `ffmpeg`/`libsndfile1`/`build-essential` in
the Dockerfile, WavTokenizer checkpoint URL swap) are unchanged and still
correct — no need to touch them again.

To restart the server later: `docker run --rm -p 7860:7860 --env-file .env
--name s2s-server s2s` from `speech-to-speech-backend/` (add `--rm` so old
stopped containers don't block the name on reuse).

## Frontend changes made — `hooks/AudioRecorder.tsx`

1. **Removed** the `convex/react` import and the three `useAction` calls
   (`transcribeAudio`, `translateToIgbo`, `textToSpeech`), plus the now-unused
   `handleWebRecording`/`handleNativeRecording` base64-conversion helpers and
   the `processTranscription` helper — none of that is needed when one backend
   call does the whole pipeline.
2. **Added** a `BACKEND_URL` constant at the top of the file:
   ```ts
   const BACKEND_URL = "http://192.168.5.210:7860"
   ```
   This is the PC's LAN Wi-Fi IP (from `ipconfig`), **not** `localhost` —
   a physical phone running Expo Go can't reach the PC's `localhost`.
   **If the PC's IP changes (different network, router reassigns it), this
   line must be updated to match**, or requests will just hang/fail. Check
   with `ipconfig` → IPv4 Address under the Wi-Fi adapter. This is also the
   line to change to the Hugging Face Space URL once that's deployed.
3. **Rewrote `stopRecording`** to build multipart `FormData` from the
   recording (native: `{ uri, name: "recording.m4a", type: "audio/m4a" }`;
   web: fetches the blob URI and appends the blob), POSTs it to
   `${BACKEND_URL}/speak`, and reads `{ text, audio_base64 }` from the JSON
   response — `text` goes into `outputText`/`transcription`, `audio_base64`
   goes straight into the existing `playAudioResponse()` (unchanged, still
   decodes base64 to a temp wav and plays it).
4. **Added a double-tap guard.** `stopRecording` now starts with:
   ```ts
   if (!recording || isStoppingRef.current) return
   isStoppingRef.current = true
   ```
   (`isStoppingRef` is a `useRef(false)`, released in the `finally` block.)
   Reasoning: `recording`/`isSaving` are React state, which only updates on
   the next render — so two near-simultaneous stop-button presses could both
   read the same non-null `recording` before either state update lands, firing
   two overlapping `/speak` requests for one recording. A ref updates
   synchronously, so the second call sees the lock immediately and bails out.
   Applies only to `stopRecording`; `startRecording` was not touched.
5. `npm install` was run in the frontend folder — `node_modules` did not
   exist before this (dependencies were never installed for this checkout).

Status values in the hook are now just `"waiting" | "transcribing" |
"synthesising"` (the old `"translating"` state was removed since there's no
longer a separate translate round-trip visible to the frontend). `home.tsx`
was NOT changed — it still reads `status`, `outputText`, `isRecording`,
`isSaving`, `savedUri`, `startRecording`, `stopRecording` from the hook, all of
which are still returned with the same names.

---

## Next action, step by step

1. In `Speech-Translation-App-Frontend-main/Speech-Translation-App-Frontend-main`,
   confirm `ipconfig`'s Wi-Fi IPv4 address still matches `BACKEND_URL` in
   `hooks/AudioRecorder.tsx` (it may have changed since last set).
2. Make sure the backend container is running (`docker ps` should show
   `s2s-server`; if not, restart it per the command above) and that the
   phone and PC are on the same Wi-Fi network with Windows Firewall allowing
   inbound on port 7860.
3. `npx expo start` in the frontend folder, scan the QR code with Expo Go.
4. Tap the button to record, speak a short English phrase, tap again to stop.
5. **Success signal:** the status text shows `synthesising...`, then Igbo
   audio plays. If it errors instead, the `transcription` text on screen will
   show `Error: <message>` — that message is the next thing to debug.

## Likely failure points and how to respond

1. **Fetch fails / hangs from the phone**: almost always `BACKEND_URL`
   pointing at a stale IP, phone/PC on different networks, or a firewall
   blocking port 7860. Not a code bug — check network first.
2. **Slow response**: expected on CPU — a single `/speak` request can take
   tens of seconds to a couple of minutes. If it's unacceptably slow, the
   cheap first fix (documented before, not yet applied) is changing
   `num_beams=4` to `num_beams=1` in `tts.py`'s `_model.generate(...)` call —
   but only after a correct run, so speed changes aren't conflated with
   correctness bugs.
3. **CORS or multipart errors from the backend**: `main.py` already has
   `CORSMiddleware` with `allow_origins=["*"]`, so this is unlikely, but if it
   surfaces, check the exact error body in the phone's error text.

## What comes AFTER on-device confirmation

- **Deploy to Hugging Face Spaces (Docker SDK)** — the chosen free host. The
  same image that runs locally is what deploys. AssemblyAI key goes in as a
  Space secret (not committed). Once deployed, swap `BACKEND_URL` in
  `AudioRecorder.tsx` from the LAN IP to the Space's public URL.
- **Add a shared-secret header** on `/speak` before it's public, so the
  endpoint can't be abused to burn free compute.
- **Fine-tuned checkpoint (optional/deferred):** `tts.py` currently uses the
  upstream `saheedniyi/YarnGPT-local` (via `HF_PATH`), NOT the user's own Colab
  fine-tune. The user's tokenizer was pushed to `saheedniyi/yih3` but the final
  model-weights push was never confirmed complete. Only revisit swapping
  `HF_PATH` after confirming that repo actually holds complete weights.

## Handy reference

- Env vars `tts.py` respects (all have working defaults for Docker):
  `HF_PATH`, `WAV_TOKENIZER_CONFIG_PATH`, `WAV_TOKENIZER_MODEL_PATH`, `YARNGPT_SRC`.
- Endpoints: `GET /` (health), `POST /transcribe` (STT only, returns `{text}`),
  `POST /speak` (full pipeline, returns `{text, audio_base64}`).
- Rebuild backend image after any backend code change: `docker build -t s2s .`
  (Docker caches the heavy layers; only changed steps re-run).
- Frontend entry point for the record button: `app/home.tsx` → `useAudioRecorder()`
  in `hooks/AudioRecorder.tsx`.
