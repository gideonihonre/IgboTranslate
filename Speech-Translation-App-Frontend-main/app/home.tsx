import React, { useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  Pressable
} from "react-native"
import { Audio } from "expo-av"
import { useAudioRecorder } from "../hooks/AudioRecorder"

export default function Home() {
  const { width } = Dimensions.get("window")
  const buttonSize = width / 3
  const [scaleValue] = useState(new Animated.Value(1))

  const {
    isRecording,
    status,
    outputText,
    isSaving,
    savedUri,
    canReplay,
    startRecording,
    stopRecording,
    replayAudio
  } = useAudioRecorder()

  const handlePressIn = () => {
    Animated.spring(scaleValue, {
      toValue: 0.95,
      useNativeDriver: true
    }).start()
  }

  const handlePressOut = () => {
    Animated.spring(scaleValue, {
      toValue: 1,
      friction: 3,
      useNativeDriver: true
    }).start()
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={isRecording ? stopRecording : startRecording}
        disabled={isSaving}
        accessibilityLabel={isRecording ? "Stop recording" : "Start recording"}
        accessibilityHint={
          isRecording
            ? "Tapping this will stop the recording and save the file."
            : "Tapping this will start recording your voice."
        }
        accessibilityRole="button"
      >
        <Animated.View
          style={[
            styles.button,
            {
              width: buttonSize,
              height: buttonSize,
              borderRadius: buttonSize / 2,
              backgroundColor: isRecording ? "#e74c3c" : "#3498db",
              transform: [{ scale: scaleValue }],
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 6,
              elevation: 8
            }
          ]}
        >
          <Text style={styles.buttonText}>
            {isRecording ? "Stop Listening" : "Tap to Translate"}
          </Text>
        </Animated.View>
      </Pressable>

      <Text style={styles.infoText}>
        {status != "waiting" ? `${status}...` : ""}
      </Text>
      {/* The backend only ever returns the Igbo translation, not the
          English transcript, so there's nothing to show for a separate
          "Transcribed Text" state. Shown persistently (not just during
          "synthesising") so it stays readable after playback ends. */}
      <Text style={styles.infoTextLower}>
        {outputText ? `Translated Igbo: ${outputText}` : ""}
      </Text>

      {canReplay && (
        <TouchableOpacity
          style={styles.replayButton}
          onPress={replayAudio}
          disabled={isRecording || isSaving}
          accessibilityLabel="Replay translated audio"
          accessibilityRole="button"
        >
          <Text style={styles.replayButtonText}>Replay</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    padding: 16
  },
  button: {
    justifyContent: "center",
    alignItems: "center"
  },
  infoText: {
    color: "#fff",
    marginTop: 50,
    fontSize: 25
  },
  infoTextLower: {
    color: "#fff",
    marginTop: 10,
    fontSize: 25
  },
  buttonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 20,
    textAlign: "center",
    paddingHorizontal: 10
  },
  replayButton: {
    marginTop: 24,
    backgroundColor: "#2ecc71",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24
  },
  replayButtonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
    textAlign: "center"
  },
  uriText: {
    marginTop: 24,
    color: "#fff",
    fontSize: 14,
    textAlign: "center"
  }
})
