// services/AudioRecorder.tsx
import { useState, useEffect, useRef } from "react"
import { Audio } from "expo-av"
import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"

// Speech-to-speech backend, reached through an ngrok tunnel to the laptop's
// Docker container. Using ngrok instead of the laptop's LAN IP directly
// sidesteps Wi-Fi IP churn and Windows Firewall entirely. Restarting the
// tunnel without a reserved ngrok domain will change this URL — check
// http://127.0.0.1:4040/api/tunnels on the laptop for the current one.
// Swap for the Hugging Face Space URL once deployed.
const BACKEND_URL = "https://a3f7-102-216-236-218.ngrok-free.app"

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
  const isStoppingRef = useRef(false)

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
    try {
      // Create a temporary file to store the audio
      const tempFile = `${FileSystem.cacheDirectory}temp_audio.wav`

      // Write the base64 audio to a temporary file
      await FileSystem.writeAsStringAsync(tempFile, base64Audio, {
        encoding: FileSystem.EncodingType.Base64
      })

      const { sound } = await Audio.Sound.createAsync(
        { uri: tempFile },
        { shouldPlay: true }
      )

      // Handle playback completion
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync()
          // Clean up the temporary file
          FileSystem.deleteAsync(tempFile, { idempotent: true }).catch((err) =>
            console.error("Error cleaning up temp file:", err)
          )
        }
      })
    } catch (error) {
      console.error("Error playing audio:", error)
    }
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

      const res = await fetch(`${BACKEND_URL}/speak`, {
        method: "POST",
        // Free ngrok tunnels show an HTML "visitor warning" interstitial to
        // any request without this header, instead of forwarding to the
        // backend — this would otherwise silently break every request.
        headers: { "ngrok-skip-browser-warning": "true" },
        body: form
      })

      if (!res.ok) {
        throw new Error(`Backend returned ${res.status}`)
      }

      const { text, audio_base64 } = await res.json()

      setTranscription(text ?? "No speech detected")
      setOutputText(text ?? "")

      if (audio_base64) {
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
    startRecording,
    stopRecording
  }
}
