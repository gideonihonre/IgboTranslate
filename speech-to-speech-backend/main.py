from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from stt import transcribe
from translate import translate_to_igbo
from tts import load_tts, synthesize_igbo


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the TTS model once at startup so the first request isn't the
    # one paying for the (slow) model load.
    load_tts()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def healthcheck():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe_only(file: UploadFile = File(...)):
    text = await transcribe(file)
    return {"text": text}


@app.post("/speak")
async def speak(file: UploadFile = File(...)):
    """The full pipeline: audio in (any language) -> translated Igbo speech out.

    Returns JSON: { "text": <igbo text>, "audio_base64": <base64 wav> }.
    The base64 field matches what the React Native app's playAudioResponse()
    already consumes, so the phone side needs only to swap three Convex calls
    for one fetch to this endpoint.
    """
    text = await transcribe(file)
    if not text:
        raise HTTPException(status_code=400, detail="No speech detected in the file.")

    translated = translate_to_igbo(text)
    audio_base64 = synthesize_igbo(translated["text"])

    return {"text": translated["text"], "audio_base64": audio_base64}
