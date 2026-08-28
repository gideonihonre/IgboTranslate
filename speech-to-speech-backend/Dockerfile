# Pinned to an exact digest, not the floating `:slim` tag — Docker Hub
# republishing a new image under that same tag (e.g. a Debian security
# patch) previously invalidated every cache layer built on top of it,
# forcing a multi-hour from-scratch rebuild with no code change involved.
# To intentionally pick up a newer base image later, re-pull and re-pin:
#   docker pull python:3.11-slim && docker inspect --format='{{index .RepoDigests 0}}' python:3.11-slim
FROM python:3.11-slim@sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff

WORKDIR /app

# git + wget: fetch yarngpt source and the WavTokenizer weights.
# ffmpeg + libsndfile1: audio backends torchaudio needs to save/load wav —
# without these, torchaudio.save(..., format="wav") fails at runtime on slim.
# build-essential: provides gcc, needed to compile packages that ship as C
# source (e.g. pesq, pulled in transitively by outetts) rather than prebuilt
# wheels. Without it those builds fail with "command 'gcc' failed".
RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget ffmpeg libsndfile1 build-essential \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch build — no GPU on free hosting, and this is far smaller
# than the default CUDA-bundled wheels.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# yarngpt has no setup.py/pyproject.toml, so it isn't pip-installable —
# vendor the source directly, same as the original Colab script did.
RUN git clone --depth 1 https://github.com/saheedniyi02/yarngpt.git /app/yarngpt_src

COPY requirements.txt .
# --timeout/--retries: this connection has repeatedly hit pip's default
# 15s read timeout partway through the larger transitive deps (librosa,
# outetts, etc.) on files.pythonhosted.org — not a package problem, just a
# slow/flaky link that needs more slack per chunk and more attempts.
RUN pip install --no-cache-dir --timeout 120 --retries 10 -r requirements.txt

# WavTokenizer config from its official Hugging Face URL (unchanged, still
# the medium repo's config — that part was never the problem).
#
# The CHECKPOINT is the one that matters. The original, proven-working setup
# (a Kaggle notebook that hosted /generate behind ngrok before this project
# existed) paired this medium config with wavtokenizer_large_speech_320_24k.ckpt
# — no "_v2" suffix. novateur has since deleted that exact file from Hugging
# Face; every substitute tried since (large-repo _v2, then medium-repo
# _24k_v2) produced consistently pitch-shifted/"chipmunk" audio regardless of
# which one, or of any decoding-parameter change — because neither is
# actually the checkpoint the config was built against, a "_v2" being a
# later, unrelated retrain rather than a re-upload of the same weights. The
# original Kaggle notebook also didn't get this file from Hugging Face — it
# pulled a personal Google Drive mirror via `gdown`, which is still live, so
# this does the same.
RUN pip install --no-cache-dir gdown && \
    mkdir -p /app/assets && \
    wget -q -O /app/assets/wavtokenizer_config.yaml \
      https://huggingface.co/novateur/WavTokenizer-medium-speech-75token/resolve/main/wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml && \
    gdown 1-ASeEkrn4HY49yZWHTASgfGFNXdVnLTt \
      -O /app/assets/wavtokenizer_large_speech_320_24k.ckpt

COPY . .

# Hugging Face Spaces expects the app on port 7860 by default.
EXPOSE 7860
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
