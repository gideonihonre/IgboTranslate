# Handoff — Speech-to-Speech: working end-to-end, including on-device

**For:** Claude Code, working across two folders on the user's Windows machine
(Git Bash / MINGW64):
- Backend: `speech-to-speech-backend`
- Frontend: `Speech-Translation-App-Frontend-main` (flat folder now — it used
  to be double-nested with a duplicate inner folder of the same name; that's
  gone. `hooks/AudioRecorder.tsx` and `app/home.tsx` are the two files that
  matter most.)

**Plain-language note for how to work with this user:** explain things in
plain language, define unfamiliar terms on first use, lead with the bottom
line before details, and do one thing at a time. The user often prefers to
run terminal commands themselves rather than have them run for them — offer
the exact command and let them run it, rather than assuming permission to
execute long-lived/foreground processes. They've also said explicitly they
sometimes want to debug an issue themselves — don't assume you should keep
driving just because you were driving a moment ago.

---

## Where things stand right now

- The full pipeline works end-to-end, **verified through the actual phone
  app**: record → `/speak` → Igbo text + audio → correct-pitched, properly
  loud playback, at a reasonable speed (`num_beams=1`). This took a long
  debugging arc — pitch (see "The big bug" below) and then volume (see
  fix #6 in "Frontend fixes made") both had to be found and fixed
  separately. Both are now confirmed on-device, not just on the PC/curl.
- Convex has been **fully removed** from the frontend (not just bypassed) —
  no `convex/` folder, no `ConvexProvider`, no related dependencies. See
  `APPLICATION_OVERVIEW.md` at the repo root for the full picture of what's
  live vs. dead in this project; don't re-derive that from scratch.
- **The backend is now deployed on Google Cloud Run** — see "Production
  deployment" below. `BACKEND_URL` in `hooks/AudioRecorder.tsx` points at
  the permanent Cloud Run URL, not a local tunnel. The phone no longer needs
  the laptop running at all for the app to work. Local Docker + ngrok is
  still useful for dev/debugging (see "Local dev setup") but is no longer
  what the app actually talks to.

## Production deployment — Google Cloud Run

- **Project**: `project-06b13408-364a-405b-a78` (one of two default "My
  First Project" projects on the user's GCP account — picked arbitrarily,
  nothing special about it). **Service**: `igbo-speech-backend`, region
  `us-central1`.
- **URL**: `https://igbo-speech-backend-939898024934.us-central1.run.app` —
  permanent, doesn't change on redeploy (unlike the old ngrok tunnel).
- **Why Cloud Run and not Hugging Face Spaces** (the originally-planned free
  host): HF now requires a PRO subscription to run Docker/Gradio Spaces even
  on the free `cpu-basic` tier — only fully static (no backend) Spaces are
  free. Discovered this by actually trying to create the Space via `hf repos
  create ... --sdk docker`, which returned a `402 Payment Required`. Also
  ruled out for the same underlying reason (too little free RAM for this
  model's ~2.5GB+ footprint): Render, Railway, Koyeb (all ~512MB-1GB free
  tier). Supabase/Firebase aren't real candidates either — Supabase Edge
  Functions are Deno/TS-only (no Python), and Firebase Functions are Cloud
  Run under the hood anyway, so deploying to Cloud Run directly is more
  direct than going through Firebase's wrapper.
- **Resources**: `--memory 8Gi --cpu 4`. 4Gi was tried first and hit a real
  OOM crash — the two model checkpoints alone need ~2.5GB, and torch/
  transformers overhead pushed it over 4Gi in practice.
- **`--min-instances 0`** (scale to zero) is load-bearing for cost — Cloud
  Run's free monthly grant (180,000 vCPU-seconds + 360,000 GiB-seconds) only
  keeps this near-$0/month if it's *not* billed while idle between requests.
  Do not change this to `1+` without understanding that tradeoff (a
  continuously-running 4vCPU/8Gi instance would cost roughly $200+/month).
- **`--startup-probe=httpGet.path=/,initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=60`**
  — required. Cloud Run's default startup health-check timeout is too short
  for this container: `main.py`'s `lifespan` loads both models (including
  downloading YarnGPT from the HF Hub) *before* Uvicorn starts accepting
  connections, and the default probe gave up before that finished. This
  gives it up to 10 minutes.
- **IAM grants needed on a fresh project** (both were the actual blockers
  before deployment succeeded — if redeploying under a different GCP
  project/account, expect to hit these again):
  ```bash
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/storage.objectViewer"
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/logging.logWriter"
  ```
- **`gcloud run deploy --source .` (remote Cloud Build) never actually
  worked** — it failed with an opaque "Build failed; check build logs" and
  the real Cloud Build logs came back empty even after the IAM fixes above
  (never root-caused). Worked around by building the image **locally**
  (same Dockerfile, already proven reliable throughout this whole project)
  and deploying with `--image` instead of `--source`:
  ```bash
  docker build -t us-central1-docker.pkg.dev/PROJECT_ID/cloud-run-source-deploy/igbo-speech-backend:latest .
  gcloud auth configure-docker us-central1-docker.pkg.dev
  docker push us-central1-docker.pkg.dev/PROJECT_ID/cloud-run-source-deploy/igbo-speech-backend:latest
  gcloud run deploy igbo-speech-backend --image us-central1-docker.pkg.dev/PROJECT_ID/cloud-run-source-deploy/igbo-speech-backend:latest ...
  ```
- **Windows/Git-Bash gotcha**: any `gcloud` flag value containing a bare `/`
  (e.g. `--startup-probe=httpGet.path=/,...`) gets silently mangled by Git
  Bash's MSYS path-auto-conversion — it rewrites the `/` into a Windows path
  mid-argument, producing a bizarre `'C:\Users\...' is not recognized`
  error that looks unrelated to the actual command. Fix: prefix the command
  with `MSYS_NO_PATHCONV=1`. Same class of issue hit earlier in this project
  with `docker exec ... /app/...` paths.
- **The deployed source is a separate, cleaned-up copy**, not
  `speech-to-speech-backend/` itself — staged (at the time) in this
  session's scratchpad temp folder with just the 6 files actually needed to
  run (`Dockerfile`, `main.py`, `stt.py`, `translate.py`, `tts.py`,
  `requirements.txt`) plus a fresh `README.md`/`.gitignore`, deliberately
  excluding `.env` and the large pile of debug `.wav`/`.json` test artifacts
  that had accumulated in the real backend folder. If redeploying after
  further code changes, rebuild the image from `speech-to-speech-backend/`
  directly instead (same Dockerfile either way) rather than hunting for that
  temp folder, which isn't guaranteed to still exist.
- **The `hf` CLI is installed** (`C:\Users\Gideon Ihonre\.local\bin\hf.exe`,
  not yet on PATH in already-open terminals — new terminals should pick it
  up) and **`gcloud` CLI is installed**
  (`C:\Users\Gideon Ihonre\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`,
  same PATH caveat). Both were left logged in.

## The big bug — and the actual fix (read this before touching tts.py)

Symptom: generated Igbo audio sounded pitch-shifted/"chipmunk"-like and was
unintelligible, sometimes with an even shorter/garbled result on repeat
tries. This took several wrong turns before finding the real cause — **do
not re-attempt the wrong turns**, they're recorded here so they aren't
re-tried:

- ❌ Swapping the WavTokenizer checkpoint between the large-repo `_v2` and
  medium-repo `_v2` files — made **zero** measurable difference (identical
  ~1s output both times). Not the cause.
- ❌ Greedy vs. sampled decoding (`do_sample=True`, `temperature`) — also
  made no measurable difference to duration or quality. Not the cause.
- ❌ Forcing more output via `min_new_tokens=200` + explicit
  `attention_mask` — this DID change duration (roughly doubled), proving the
  model's stopping point is controllable, but the result was **garbled,
  repetitive, noise-like** audio, not fixed audio. Wrong lever.

✅ **The actual cause**: the checkpoint had been substituted with an
incompatible file the entire time. novateur (the WavTokenizer repo owner)
deleted the original `wavtokenizer_large_speech_320_24k.ckpt` from Hugging
Face at some point before this project existed in its current form. Every
substitute since (`wavtokenizer_large_speech_320_v2.ckpt`, later
`wavtokenizer_medium_speech_320_24k_v2.ckpt`) has a `_v2` suffix — a later,
separately-trained checkpoint generation, not a re-upload of the same
weights, and not guaranteed compatible with a config built around the
original. This is why swapping between two `_v2` files changed nothing:
neither was ever the right one.

The fix: the user's own original Kaggle notebook (the one that first proved
this whole pipeline, hosted behind ngrok before this backend/Docker setup
existed) revealed the answer — it didn't get the checkpoint from Hugging
Face at all, but from a personal Google Drive mirror via `gdown` (file ID
`1-ASeEkrn4HY49yZWHTASgfGFNXdVnLTt`), because it predates the HF deletion.
That mirror is still live. The Dockerfile now:
```dockerfile
RUN pip install --no-cache-dir gdown && \
    ... \
    gdown 1-ASeEkrn4HY49yZWHTASgfGFNXdVnLTt \
      -O /app/assets/wavtokenizer_large_speech_320_24k.ckpt
```
and `tts.py`'s `WAV_TOKENIZER_MODEL_PATH` default points at that file. The
WavTokenizer **config** was never the problem — it's always been the medium
repo's yaml, unchanged throughout this whole investigation.

`tts.py`'s `synthesize_igbo()` generate() call was also reverted to match
the original Kaggle script exactly (`num_beams=4`, no `do_sample`, no
`attention_mask`, no `min_new_tokens`) to make the checkpoint fix the only
variable in the final confirming test — confirmed correct, then speed
re-tuned to **`num_beams=1`** on top of the correct checkpoint, which is
also confirmed correct and much faster (~34s vs. ~60-110s for `num_beams=4`
on the same short test phrase).

**`max_length` — do not lower this below `8192`.** It caps the *combined*
input-prompt + generated-audio-codes token count, and `8192` is not just the
original script's setting — it's `max_position_embeddings` in the model's
own `config.json`, i.e. its actual architectural ceiling. The user had
manually lowered it to `4000` at one point, which silently truncated
generation for longer input sentences (short prompts had enough headroom
either way, which is why this wasn't caught immediately) — restored to
`8192` after confirming, via a direct `synthesize_igbo()` call bypassing
`/speak`, that a 218-character multi-sentence input produced properly
proportional ~9.9s of audio at `8192` versus truncated/short output before.
That same test measured **187s of raw generation time** for that longer
sentence — which is *why* `AudioRecorder.tsx`'s `postSpeak()` timeout was
bumped from 180000ms to 360000ms (6 min); the old 3-minute value was already
too tight the moment sentences get long, independent of network flakiness.

## Local dev setup (optional — the app talks to Cloud Run now, not this)

Useful for testing backend code changes before redeploying, or debugging.
Not required for the app to function day-to-day anymore.

1. **Docker Desktop must be running** (a GUI app — can't be started from a
   script). It's gone down between sessions repeatedly; check with
   `docker info`.
2. Backend container:
   ```bash
   cd speech-to-speech-backend
   docker run --rm -p 7860:7860 --env-file .env --name s2s-server s2s
   ```
   Wait for `Uvicorn running on http://0.0.0.0:7860`. First-ever load of the
   1.75GB checkpoint takes noticeably longer than the old `_v2` files did.
3. ngrok tunnel (separate terminal, also needs restarting after any reboot —
   it does not survive a Docker/machine restart):
   ```bash
   ngrok http 7860
   ```
   Get the current URL from `http://127.0.0.1:4040/api/tunnels`. **This URL
   changes every time the tunnel restarts** unless a reserved ngrok domain
   is set up (not done yet) — update `BACKEND_URL` in
   `hooks/AudioRecorder.tsx` to match every time.
4. Requests to the tunnel need the header `ngrok-skip-browser-warning: true`
   or ngrok serves an HTML interstitial instead of forwarding to the
   backend — already handled in `AudioRecorder.tsx`'s `postSpeak()` helper,
   but remember this if testing via curl too.
5. Frontend: `npx expo start` in `Speech-Translation-App-Frontend-main/`,
   scan the QR with Expo Go. `node_modules` is already installed.

## Frontend fixes made since the app was first wired up

Beyond the original Convex→`/speak` rewire (see `APPLICATION_OVERVIEW.md`),
`hooks/AudioRecorder.tsx` has had several real bugs fixed:

1. **Request timeout.** Plain `fetch()` in React Native has no way to set a
   timeout and falls back to the platform default (60s on iOS via
   `NSURLSession`) — too short for a `/speak` call that can take 60-100+s.
   Replaced with a `postSpeak()` helper using `XMLHttpRequest` directly
   (which *does* respect an explicit `.timeout`, currently 360000ms/6min —
   see the `max_length` note above for why 3 minutes turned out to be too
   tight), and it also parses the backend's JSON `{detail}` error body so
   failures show a real reason instead of a bare status code.
2. **Playback cut short.** `Audio.Sound.createAsync(..., {shouldPlay:true})`
   resolves once playback *starts*, not once it *finishes* — so the old code
   raced ahead to `setStatus("waiting")` (re-enabling the record button,
   hiding the translated-text UI) while audio was still playing.
   `playAudioResponse()` now awaits an explicit promise that only resolves
   on the sound's `didJustFinish` callback.
3. **`expo-file-system` v19 (from the SDK 54 upgrade) split its API** — the
   functions this file uses (`writeAsStringAsync`, `EncodingType`,
   `cacheDirectory`, `deleteAsync`) moved behind `expo-file-system/legacy`;
   the top-level import no longer has them. Import is now
   `import * as FileSystem from "expo-file-system/legacy"`.
4. **`home.tsx` never showed the translated text** — it checked
   `status == "translating"`, a status value that stopped existing once the
   three-Convex-call pipeline was consolidated into one backend call. Fixed
   to just show `outputText` whenever it's non-empty, persistently (not only
   during `"synthesising"`).
5. The double-tap guard (`isStoppingRef`) from the original wire-up is still
   in place and unrelated to any of the above.
6. **Playback was too quiet.** `startRecording()` sets
   `allowsRecordingIOS: true` and never resets it — on iOS that keeps the
   audio session in a `PlayAndRecord` category through playback too, which
   can route audio through a quieter, voice-call-style path instead of the
   normal loud speaker. `playAudioResponse()` now calls
   `Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true })`
   before creating the `Sound`, and passes `volume: 1.0` explicitly.
   Confirmed fixed on-device.

## What comes AFTER (blocked on nothing now, but not started)

- **Add a shared-secret header** on `/speak` before wider use — right now
  anyone with the Cloud Run URL can call it and burn the user's GCP free
  quota (or beyond it, real money). This is more pressing now than it was
  with the ngrok setup, since the URL is permanent and public rather than
  a rotating tunnel.
- **Fine-tuned checkpoint**: separate from the WavTokenizer vocoder fix
  above — this is about the YarnGPT *language model* itself. The user's own
  fine-tune attempt (`train.ipynb`, at the repo root) trains Hausa/Igbo/
  Yoruba together from a Google Drive dataset and pushes to
  `saheedniyi/yih3` — whether that account is the user's own, and whether
  the training data is still accessible, was never confirmed. The user
  chose to shelve this and ship on the upstream `saheedniyi/YarnGPT-local`
  model instead; revisit only if asked.

## Handy reference

- Env vars `tts.py` respects: `HF_PATH`, `WAV_TOKENIZER_CONFIG_PATH`,
  `WAV_TOKENIZER_MODEL_PATH`, `YARNGPT_SRC`.
- Endpoints: `GET /` (health), `POST /transcribe` (STT only), `POST /speak`
  (full pipeline).
- Rebuild after any backend code change: `docker build -t s2s .` — usually
  fast (only the final `COPY . .` layer re-runs), but Docker Desktop's WSL2
  build cache has been observed to get silently evicted between sessions,
  occasionally forcing a very slow from-scratch rebuild for no code-related
  reason. See `WHY_DOCKER_BUILD_IS_SLOW.md` if a rebuild is unexpectedly slow
  again.
- `FROM python:3.11-slim` is pinned to an exact digest in the Dockerfile
  (not the floating tag) — see the comment there before changing it.
- **To redeploy after a backend code change**: build+push+deploy from
  `speech-to-speech-backend/` directly (no need to re-stage a separate
  clean copy — that was only done once to avoid pushing `.env`/debug
  artifacts, and this path doesn't risk that since it deploys straight to
  Cloud Run, not to a git-based host):
  ```bash
  cd speech-to-speech-backend
  docker build -t us-central1-docker.pkg.dev/project-06b13408-364a-405b-a78/cloud-run-source-deploy/igbo-speech-backend:latest .
  MSYS_NO_PATHCONV=1 gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
  docker push us-central1-docker.pkg.dev/project-06b13408-364a-405b-a78/cloud-run-source-deploy/igbo-speech-backend:latest
  MSYS_NO_PATHCONV=1 gcloud run deploy igbo-speech-backend \
    --image us-central1-docker.pkg.dev/project-06b13408-364a-405b-a78/cloud-run-source-deploy/igbo-speech-backend:latest \
    --region us-central1 --port 7860 --memory 8Gi --cpu 4 --timeout 900 \
    --min-instances 0 --max-instances 1 --allow-unauthenticated \
    --set-env-vars "ASSEMBLYAI_API_KEY=<from .env>" \
    --startup-probe=httpGet.path=/,initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=60
  ```
  (`gcloud`/`hf` aren't on PATH in already-open terminals — see "Production
  deployment" above for their full paths if a fresh terminal hasn't been
  opened since install.)
