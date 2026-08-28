English → Igbo Speech-to-Speech Translator

Record English speech on your phone, get it translated and spoken back in
Igbo. The app has two parts that run on two separate devices during local
development: a Python backend (your computer) and a React Native frontend
(your phone, via Expo Go).

Pipeline: speech in → transcription (AssemblyAI) → translation (Google
Translate) → Igbo speech synthesis (YarnGPT + WavTokenizer) → audio back to
the phone.

Repo structure
.
├── backend/     FastAPI backend — STT, translation, TTS
└── frontend/    Expo React Native app

Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — must be running before you start the backend
- [Node.js](https://nodejs.org/) + npm
- [Expo Go](https://expo.dev/go) installed on your phone (iOS or Android)
- [ngrok](https://ngrok.com/) account (free tier is fine) — tunnels your local backend to the internet so your phone can reach it
- An [AssemblyAI](https://www.assemblyai.com/) API key (free tier available)

1. Clone the repo
bash
git clone <your-repo-url>
cd <repo-name>

2. Start the backend
bash
cd backend
Create a `.env` file in this folder:
ASSEMBLYAI_API_KEY=your_key_here
Build and run the container:
bash
docker build -t s2s .
docker run --rm -p 7860:7860 --env-file .env --name s2s-server s2s
Wait for this in the logs — it means the models have finished loading and
the server is ready:

Uvicorn running on http://0.0.0.0:7860

> First run downloads a ~1.75GB model checkpoint, so it'll take a few
> minutes the first time. Subsequent runs are much faster.

3. Expose the backend with ngrok

In a new terminal:

bash
ngrok http 7860

Grab the public URL it gives you, e.g. `https://abcd1234.ngrok-free.app`.
You can also find it at `http://127.0.0.1:4040/api/tunnels`.

> This URL changes every time you restart ngrok (unless you've set up a
> reserved domain). You'll need to update the frontend each time it changes.

4. Configure and start the frontend

bash
cd frontend
npm install

Open `hooks/AudioRecorder.tsx` and set `BACKEND_URL` to the ngrok URL from
step 3.

Start the app:

bash
npx expo start

Scan the QR code with the Expo Go app on your phone. The phone needs to use the same internet connection as the laptop preferably using the phone's hotspot as the internet connection for the laptop.

5. Try it out

Tap record, speak in English, and stop recording. The app sends the audio
to your backend, and after a short wait (translation + speech synthesis
takes anywhere from ~30 seconds to a couple of minutes depending on sentence
length) you'll see the Igbo text and hear it spoken back.

Notes 

- Requests to the ngrok tunnel need the header `ngrok-skip-browser-warning: true`, or ngrok serves an HTML interstitial page instead of forwarding to
  the backend. The app already sends this — worth knowing if you're testing
  with `curl` directly.
- Backend requests can take a while. Longer sentences can take minutes
  to synthesize, so the frontend's request timeout is set generously (6
  minutes) to accommodate this.
- Docker Desktop needs to be running as a background app before you run
  the `docker run` command — it won't start itself.
- If you stop and restart Docker or your machine, both the backend
  container and the ngrok tunnel need to be started again, and the ngrok
  URL will change.

Endpoints (for reference)

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Health check |
| `/transcribe` | POST | Speech-to-text only |
| `/speak` | POST | Full pipeline: audio in → Igbo text + audio out |
