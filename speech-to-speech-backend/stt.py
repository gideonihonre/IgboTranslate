import os
import tempfile

import assemblyai as aai
from fastapi import HTTPException, UploadFile

aai.settings.api_key = os.getenv("ASSEMBLYAI_API_KEY")

ALLOWED_EXTENSIONS = (".m4a", ".mp3", ".wav", ".flac", ".mp4")


async def transcribe(file: UploadFile) -> str:
    """Transcribe an uploaded audio file to text using AssemblyAI."""
    if not file.filename.lower().endswith(ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format. Please upload m4a, mp3, wav, flac, or mp4.",
        )

    with tempfile.NamedTemporaryFile(delete=False, suffix=".m4a") as temp_file:
        content = await file.read()
        temp_file.write(content)
        temp_file_path = temp_file.name

    try:
        transcriber = aai.Transcriber()
        transcript = transcriber.transcribe(temp_file_path)

        if transcript.status == aai.TranscriptStatus.error:
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {transcript.error}"
            )

        return transcript.text or ""
    finally:
        os.unlink(temp_file_path)
