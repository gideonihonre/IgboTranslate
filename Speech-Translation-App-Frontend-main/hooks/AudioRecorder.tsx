// services/AudioRecorder.tsx
import { useState, useEffect, useRef } from "react"
import { Audio } from "expo-av"
// expo-file-system v19 (SDK 54) moved writeAsStringAsync/EncodingType/
// cacheDirectory/deleteAsync behind this subpath — the top-level import
// no longer has them.
import * as FileSystem from "expo-file-system/legacy"
import { Platform } from "react-native"

// Speech-to-speech backend, deployed on Google Cloud Run (project
// project-06b13408-364a-405b-a78, service "igbo-speech-backend", region
// us-central1). This URL is permanent — Cloud Run assigns one fixed URL
// per service, so unlike the old ngrok-tunnel/LAN-IP setup, it does NOT
// change across restarts and no laptop needs to be running for this to work.
const BACKEND_URL = "https://igbo-speech-backend-939898024934.us-central1.run.app"

// Plain fetch() in React Native has no way to set a timeout, so it falls
// back to the platform's native default — 60s on iOS via NSURLSession.
// /speak genuinely takes 36-100+s depending on network conditions, which
// straddles that ceiling. XMLHttpRequest does respect an explicit .timeout,
// so this bypasses fetch() specifically to get past that limit.
function postSpeak(url: string, form: FormData): Promise<{ text: string; audio_base64: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    // A 218-char, multi-sentence test measured 187s of generation time alone
    // (before network overhead) once max_length was raised to the model's
    // real ceiling (8192) — longer sentences take proportionally longer.
    // 3 minutes was too tight; 6 gives real headroom for longer input.
    xhr.timeout = 360000 // 6 minutes
    xhr.open("POST", url)

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error("Backend returned invalid JSON"))
        }
      } else {
        // FastAPI's HTTPException puts the real reason (e.g. "No speech
        // detected in the file.") in a JSON { detail } body — surface that
        // instead of a bare status code where possible.
        let detail = `Backend returned ${xhr.status}`
        try {
          const parsed = JSON.parse(xhr.responseText)
          if (parsed?.detail) detail = parsed.detail
        } catch {
          // response wasn't JSON — fall back to the status-code message
        }
        reject(new Error(detail))
      }
    }
    xhr.onerror = () => reject(new Error("Network request failed"))
    xhr.ontimeout = () => reject(new Error("Backend took too long to respond"))

    xhr.send(form)
  })
}

export function useAudioRecorder() {
  const [recording, setRecording] = useState<Audio.Recording | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [savedUri, setSavedUri] = useState<string | null>(null)
  const [status, setStatus] = useState<
    "waiting" | "transcribing" | "synthesising"
  >("waiting")
  const [transcription, setTranscription] = useState<string | null>(null)
  const [outputText, setOutputText] = useState<string>("")
  const [lastAudioBase64, setLastAudioBase64] = useState<string | null>(null)
  const isStoppingRef = useRef(false)
  const isPlayingRef = useRef(false)

  // Clean up recording on unmount
  useEffect(() => {
    return () => {
      if (recording) {
        recording
          .getStatusAsync()
          .then((status) => {
            if ("canRecord" in status && status.canRecord) {
              recording
                .stopAndUnloadAsync()
                .catch((err) => console.error("Cleanup error:", err))
            }
          })
          .catch((err) => console.error("Status check error:", err))
      }
    }
  }, [recording])

  const startRecording = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync()
      if (status !== "granted")
        throw new Error("Microphone permission not granted")

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true
      })

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      )

      setRecording(recording)
      setIsRecording(true)
      setSavedUri(null)
      setTranscription(null)
    } catch (err) {
      console.error("Failed to start recording:", err)
    }
  }

  const playAudioResponse = async (base64Audio: string) => {
    // Guards against overlapping Sound instances if replay is tapped while
    // something is already playing (the initial response or a prior replay).
    if (isPlayingRef.current) return
    isPlayingRef.current = true
    try {
      // startRecording() left the audio session in allowsRecordingIOS:true
      // (a "PlayAndRecord" category on iOS) and never reset it — that
      // category can route playback through a quieter, voice-call-style
      // path instead of the normal loud speaker. Switch to a
      // playback-oriented mode before playing.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true
      })

      // Create a temporary file to store the audio
      const tempFile = `${FileSystem.cacheDirectory}temp_audio.wav`

      // Write the base64 audio to a temporary file
      await FileSystem.writeAsStringAsync(tempFile, base64Audio, {
        encoding: FileSystem.EncodingType.Base64
      })

      const { sound } = await Audio.Sound.createAsync(
        { uri: tempFile },
        { shouldPlay: true, volume: 1.0 }
      )

      // createAsync() resolves once playback STARTS, not once it finishes —
      // wait for didJustFinish so callers (stopRecording's status/UI updates)
      // don't race ahead of the actual audio.
      await new Promise<void>((resolve) => {
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync()
            FileSystem.deleteAsync(tempFile, { idempotent: true }).catch((err) =>
              console.error("Error cleaning up temp file:", err)
            )
            resolve()
          }
        })
      })
    } catch (error) {
      console.error("Error playing audio:", error)
    } finally {
      isPlayingRef.current = false
    }
  }

  const replayAudio = async () => {
    if (!lastAudioBase64) return
    await playAudioResponse(lastAudioBase64)
  }

  const stopRecording = async () => {
    if (!recording || isStoppingRef.current) return
    isStoppingRef.current = true

    try {
      setIsRecording(false)
      setIsSaving(true)

      await recording.stopAndUnloadAsync()
      const uri = recording.getURI()

      if (!uri) throw new Error("Could not get recording URI")

      setSavedUri(uri)
      setStatus("transcribing")

      // Single round trip: the backend does transcribe -> translate ->
      // synthesize and hands back the Igbo text plus the wav to play.
      const form = new FormData()
      if (Platform.OS === "web") {
        const blob = await (await fetch(uri)).blob()
        form.append("file", blob, "recording.webm")
      } else {
        form.append("file", {
          uri,
          name: "recording.m4a",
          type: "audio/m4a"
        } as any)
      }

      const { text, audio_base64 } = await postSpeak(`${BACKEND_URL}/speak`, form)

      setTranscription(text ?? "No speech detected")
      setOutputText(text ?? "")

      if (audio_base64) {
        setLastAudioBase64(audio_base64)
        setStatus("synthesising")
        await playAudioResponse(audio_base64)
      }
      setStatus("waiting")
    } catch (err: any) {
      console.error("Error stopping recording:", err)
      setTranscription(`Error: ${err.message}`)
      setStatus("waiting")
    } finally {
      setRecording(null)
      setIsSaving(false)
      isStoppingRef.current = false
    }
  }

  return {
    isRecording,
    status,
    outputText,
    isSaving,
    savedUri,
    transcription,
    canReplay: lastAudioBase64 !== null,
    startRecording,
    stopRecording,
    replayAudio
  }
}
