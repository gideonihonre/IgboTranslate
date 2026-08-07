# Why the Docker build keeps taking so long

This backend's image (`s2s`) has taken anywhere from a few minutes to
several hours to build across different attempts today, sometimes failing
partway through. Here's what's actually causing that, in plain terms.

## The core problem: the internet connection during this session has been unreliable

Almost everything below traces back to this. Evidence seen directly during
troubleshooting:

- The laptop's Wi-Fi IP address changed three separate times in one session
  (`192.168.5.210` → `192.168.7.203` → `192.168.100.4`), which points to an
  unstable Wi-Fi connection re-establishing itself repeatedly.
- Download speeds during the build have swung wildly — from single-digit
  KB/s (dial-up speed) up to a few hundred KB/s, sometimes within the same
  build.
- One build failed with `ReadTimeoutError` — pip waited too long for the
  next chunk of data from `files.pythonhosted.org` and gave up.
- A later build failed with a **hash mismatch** — a downloaded package's
  contents didn't match what PyPI says they should be. On this flaky a
  connection, that's almost certainly a corrupted/truncated download, not
  actual tampering.

## Why one slow step drags the whole build down

- The Dockerfile installs a genuinely large set of Python packages:
  `torch`/`torchaudio` (CPU build, ~190MB alone), then a long chain of
  dependencies pulled in transitively by `outetts` — things like `scipy`
  (35MB), `librosa`, `matplotlib` (10MB), `polars` and its native runtime
  (57MB), `torchcrepe` (72MB), and `llvmlite` (60MB), on top of everything
  else in `requirements.txt`.
- All of that has to come down over the same unreliable connection
  described above. A large file at a slow, fluctuating speed is exactly
  the scenario that produces multi-hour installs.
- `pip install --no-cache-dir` (used deliberately, to keep the final image
  small) means pip never reuses a previously-downloaded package between
  separate build attempts — every retry re-downloads everything for that
  step from zero, even packages that downloaded fine last time.

## Why "just the code changed" builds have sometimes still been slow

In theory, Docker should skip re-downloading anything when only a Python
file like `tts.py` changes — that file is only touched by the very last
`COPY . .` step in the Dockerfile, so everything before it (system
packages, `torch`, the YarnGPT clone, `pip install -r requirements.txt`,
the WavTokenizer downloads) should stay cached and skip straight to done.

That held true for one rebuild (the `num_beams=1` change, tens of seconds).
It did **not** hold for a later rebuild (`num_beams=2`), which went back to
redownloading `scipy`/`matplotlib`/`polars_runtime` from scratch despite no
change to anything upstream of the code copy. The most likely explanation:

- **Docker Desktop's build cache got evicted between builds.** Docker
  Desktop on Windows runs everything inside a WSL2 virtual machine with a
  capped virtual disk size. This project's build cache is large (multiple
  hundreds of MB of downloaded packages), and Docker will silently drop
  older cached layers to make room when that disk fills up. When a cached
  layer is evicted, Docker has no choice but to re-run that step (and
  everything after it) from scratch on the next build, even though nothing
  in the Dockerfile or the source code actually changed.
- A related but distinct possibility (seen once, confirmed as the cause
  that time): the base image tag `python:3.11-slim` is a *floating* tag —
  Docker Hub periodically republishes a newer image under that same name
  (a Debian security patch, for example). If that happens between two
  builds, Docker sees a different starting point and has to invalidate
  every layer built on top of it, again regardless of what code changed.

**Fix applied:** the Dockerfile's `FROM python:3.11-slim` is now pinned to
an exact image digest (`@sha256:...`) instead of the floating tag, so this
specific cause can't happen again. Re-pinning to a newer base image later
is a deliberate, one-line action (command is in the Dockerfile comment),
not something that happens silently. The Docker-Desktop-cache-eviction
cause above is unrelated to this fix and can still occur.

## Net effect

Slow/unstable internet is the root cause. It directly causes failed and
retried downloads, and it's also *why* a full from-scratch rebuild (which
cache eviction or a base-image update can force at any time, unpredictably)
is so painful here — a rebuild that would take seconds on a fast, stable
connection can take hours on this one.
