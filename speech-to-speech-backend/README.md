# speech-to-speech-backend

Unified backend merging the STT + translate logic from `gideon-translate`
with the TTS server that was previously running standalone behind an ngrok
tunnel. One FastAPI app, one `/speak` endpoint: audio in, translated Igbo
speech out.

## Endpoints
- `GET /` — healthcheck
- `POST /transcribe` — audio in, transcript text out (useful for debugging the STT step in isolation)
- `POST /speak` — the full pipeline: audio in -> transcribe -> translate to Igbo -> synthesize -> wav out

## Local setup
```bash
python -m venv .venv && source .venv/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
git clone --depth 1 https://github.com/saheedniyi02/yarngpt.git yarngpt_src
pip install -r requirements.txt

mkdir -p assets
wget -O assets/wavtokenizer_config.yaml \
  https://huggingface.co/novateur/WavTokenizer-medium-speech-75token/resolve/main/wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml
wget -O assets/wavtokenizer_large_speech_320_v2.ckpt \
  https://huggingface.co/novateur/WavTokenizer-large-speech-75token/resolve/main/wavtokenizer_large_speech_320_v2.ckpt
```
Note: locally, `tts.py` expects `yarngpt_src` and `assets/` at `/app/...` —
change those two path constants at the top of `tts.py` if running outside
Docker, or just run from a directory structured to match.

Set `ASSEMBLYAI_API_KEY` in a `.env` file, then:
```bash
uvicorn main:app --reload
```

## Deploying to Hugging Face Spaces (free)
1. Create a new Space, SDK = Docker.
2. Push this folder to it:
   ```bash
   git remote add hf https://huggingface.co/spaces/<username>/<space-name>
   git push hf main
   ```
3. In the Space's Settings -> Repository secrets, add `ASSEMBLYAI_API_KEY`.
4. The Space builds the Dockerfile automatically and gives you a public
   URL like `https://<username>-<space-name>.hf.space`.

## Known things to sort out
- **Generation speed**: the TTS step uses `num_beams=4, max_length=8192`,
  copied as-is from the original script. This is expensive on CPU-only
  hosting — time it early. If it's too slow, try `num_beams=1` first.
- **Cold start**: the YarnGPT-local model weights download from the HF Hub
  the first time the app starts (not baked into the image), so the first
  request after a Space wakes from sleep will be slow. Bake them into the
  Docker image too if that's a problem.
- **Your own fine-tuned checkpoint** (`aybdee/igboSpeechSynthesis` from the
  training notebook) isn't wired into `tts.py` — it still points at the
  upstream `saheedniyi/YarnGPT-local`. Swap `HF_PATH` if you want your own
  fine-tune in the loop instead.
- **`translators` library**: scrapes Google Translate rather than calling
  a billed API, so it needs no credentials but is more failure-prone under
  real traffic. `google-cloud-translate` v3 (already partially written in
  the original backend repo) is the fallback if this breaks.

## Updating the React Native app
In `hooks/AudioRecorder.tsx`, replace the three Convex `useAction` calls
(`transcribeAudio`, `translateToIgbo`, `textToSpeech`) with a single
`fetch` to this backend's `/speak` endpoint.

`/speak` returns JSON:
```json
{ "text": "<igbo text>", "audio_base64": "<base64 wav>" }
```
POST the recorded audio as multipart form-data, read `audio_base64` from
the JSON, and pass that straight into the `playAudioResponse` function you
already have — it already expects a base64 string, so playback is unchanged.

Sketch:
```ts
const form = new FormData();
form.append("file", {
  uri,                       // the recording URI
  name: "recording.m4a",
  type: "audio/m4a",
} as any);

const res = await fetch("https://<your-space>.hf.space/speak", {
  method: "POST",
  body: form,
});
const { text, audio_base64 } = await res.json();
setOutputText(text);
await playAudioResponse(audio_base64);
```
