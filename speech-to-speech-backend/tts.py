import base64
import io
import os
import sys

import soundfile as sf
import torch
from transformers import AutoModelForCausalLM

# yarngpt isn't on PyPI — it's vendored into the image by the Dockerfile
# (git clone into /app/yarngpt_src). See Dockerfile for details.
# NOTE: in the real repo, audiotokenizer.py sits at the ROOT of the clone,
# not inside a yarngpt/ package folder — so we add that folder to the path
# and import the bare module. The module also finds its speaker files via
# os.path.dirname(__file__), so it must stay inside the cloned repo dir.
YARNGPT_SRC = os.getenv("YARNGPT_SRC", "/app/yarngpt_src")
sys.path.insert(0, YARNGPT_SRC)
from audiotokenizer import AudioTokenizerForLocal  # noqa: E402

HF_PATH = os.getenv("HF_PATH", "saheedniyi/YarnGPT-local")
WAV_TOKENIZER_CONFIG_PATH = os.getenv(
    "WAV_TOKENIZER_CONFIG_PATH", "/app/assets/wavtokenizer_config.yaml"
)
WAV_TOKENIZER_MODEL_PATH = os.getenv(
    "WAV_TOKENIZER_MODEL_PATH", "/app/assets/wavtokenizer_large_speech_320_v2.ckpt"
)

_audio_tokenizer = None
_model = None


def load_tts():
    """Load the TTS model + vocoder once. Call this at app startup, not per-request."""
    global _audio_tokenizer, _model
    if _model is None:
        _audio_tokenizer = AudioTokenizerForLocal(
            HF_PATH, WAV_TOKENIZER_MODEL_PATH, WAV_TOKENIZER_CONFIG_PATH
        )
        _model = AutoModelForCausalLM.from_pretrained(
            HF_PATH, torch_dtype="auto"
        ).to(_audio_tokenizer.device)
    return _audio_tokenizer, _model


def synthesize_igbo(text: str) -> str:
    """Turn Igbo text into a base64-encoded wav string.

    Returns base64 (not raw bytes) because the React Native app's existing
    playAudioResponse() writes the received string straight to disk with
    EncodingType.Base64. Returning base64 keeps that playback code unchanged.
    """
    audio_tokenizer, model = load_tts()

    prompt = audio_tokenizer.create_prompt(text, "igbo", "igbo_male2")
    input_ids = audio_tokenizer.tokenize_prompt(prompt)

    # num_beams=4 (the original script's setting) measured ~108s end-to-end,
    # num_beams=2 ~57s. Settled on num_beams=1 (greedy decoding, ~46s) —
    # fastest option and sounded fine on comparison.
    output = model.generate(
        input_ids=input_ids,
        temperature=0.1,
        repetition_penalty=1.1,
        num_beams=1,
        max_length=8192,
    )

    codes = audio_tokenizer.get_codes(output)
    audio = audio_tokenizer.get_audio(codes)

    # soundfile wants (samples,) / (samples, channels) numpy, not torchaudio's
    # (channels, samples) tensor convention — audio comes out as (1, samples).
    buffer = io.BytesIO()
    sf.write(buffer, audio.squeeze(0).numpy(), samplerate=24000, format="WAV")
    buffer.seek(0)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")
