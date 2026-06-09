/**
 * AudioWorklet Processor for microphone input.
 * Runs on a separate thread for better performance.
 * Accumulates samples and sends Int16 PCM to main thread.
 *
 * Required by Gemini Live API: 16kHz, 16-bit PCM, mono
 */
class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Buffer size of 2048 samples at 16kHz = ~128ms latency
        // Trade-off: Lower = less latency but more CPU/network overhead
        this._bufferSize = 2048;
        this._buffer = new Float32Array(this._bufferSize);
        this._writeIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const inputData = input[0];

        // Accumulate samples
        for (let i = 0; i < inputData.length; i++) {
            this._buffer[this._writeIndex++] = inputData[i];

            // When buffer is full, convert and send
            if (this._writeIndex >= this._bufferSize) {
                // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
                const int16 = new Int16Array(this._bufferSize);
                for (let j = 0; j < this._bufferSize; j++) {
                    // Clamp to prevent overflow
                    const sample = Math.max(-1, Math.min(1, this._buffer[j]));
                    int16[j] = sample * 32767;
                }

                // Send to main thread
                this.port.postMessage({
                    pcmData: int16.buffer
                });

                this._writeIndex = 0;
            }
        }

        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);
