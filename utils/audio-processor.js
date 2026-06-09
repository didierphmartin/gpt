/**
 * AudioWorklet Processor for microphone input with Voice Activity Detection (VAD).
 * Runs on a separate thread for better performance.
 * Only sends audio when speech is detected to reduce API costs.
 *
 * COST OPTIMIZATION: Gemini Live API charges 32 tokens/second for ALL audio,
 * including silence. VAD can reduce costs by 70-90% for typical conversations.
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer size: 4096 samples at 16kHz = 256ms
    // Larger buffers = fewer API calls but higher latency
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;

    // Voice Activity Detection (VAD) settings
    // RMS threshold for speech detection (0.0 - 1.0)
    // Lower = more sensitive, Higher = less sensitive
    // 0.01 is good for most microphones, adjust if needed
    this._vadThreshold = 0.01;

    // Number of consecutive silent frames before stopping transmission
    // At 256ms per frame: 8 frames = ~2 seconds of holdover
    // This prevents cutting off speech mid-sentence
    this._silenceFramesThreshold = 8;
    this._consecutiveSilentFrames = 0;

    // Track if we're currently in "speech mode"
    this._isSpeaking = false;

    // Pre-buffer to capture speech onset (stores last N silent frames)
    // This captures the beginning of speech that might be cut off
    this._preBufferSize = 2;  // Store last 2 frames (~512ms)
    this._preBuffer = [];
  }

  /**
   * Calculate RMS (Root Mean Square) energy of audio buffer
   * This is a simple but effective measure of audio loudness
   */
  calculateRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  /**
   * Convert Float32 buffer to Int16 PCM
   */
  convertToInt16(float32Buffer) {
    const int16 = new Int16Array(float32Buffer.length);
    for (let i = 0; i < float32Buffer.length; i++) {
      // Clamp to prevent overflow
      const s = Math.max(-1, Math.min(1, float32Buffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputData = input[0];

    // Accumulate samples
    for (let i = 0; i < inputData.length; i++) {
      this._buffer[this._writeIndex++] = inputData[i];

      // When buffer is full, process and potentially send
      if (this._writeIndex >= this._bufferSize) {
        const rms = this.calculateRMS(this._buffer);
        const isSpeechDetected = rms > this._vadThreshold;

        // Create a copy of the buffer for potential sending
        const bufferCopy = new Float32Array(this._buffer);

        if (isSpeechDetected) {
          // Speech detected!
          this._consecutiveSilentFrames = 0;

          if (!this._isSpeaking) {
            // Transition from silence to speech
            this._isSpeaking = true;

            // Send any pre-buffered frames first (captures speech onset)
            for (const preFrame of this._preBuffer) {
              const int16 = this.convertToInt16(preFrame);
              this.port.postMessage({
                pcmData: int16.buffer,
                isSpeech: true,
                rms: this.calculateRMS(preFrame)
              });
            }
            this._preBuffer = [];
          }

          // Send current frame
          const int16 = this.convertToInt16(bufferCopy);
          this.port.postMessage({
            pcmData: int16.buffer,
            isSpeech: true,
            rms: rms
          });

        } else {
          // Silence detected
          this._consecutiveSilentFrames++;

          if (this._isSpeaking) {
            // Still in holdover period - keep sending to capture end of speech
            if (this._consecutiveSilentFrames <= this._silenceFramesThreshold) {
              const int16 = this.convertToInt16(bufferCopy);
              this.port.postMessage({
                pcmData: int16.buffer,
                isSpeech: false,  // Mark as holdover
                rms: rms
              });
            } else {
              // Holdover period ended, transition to silence
              this._isSpeaking = false;
              this._preBuffer = [];

              // Notify main thread that speech ended
              this.port.postMessage({
                speechEnded: true
              });
            }
          } else {
            // In silence mode - buffer frames for pre-roll
            this._preBuffer.push(bufferCopy);
            if (this._preBuffer.length > this._preBufferSize) {
              this._preBuffer.shift();
            }

            // Don't send silent audio - THIS IS THE KEY COST SAVING!
          }
        }

        this._writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
