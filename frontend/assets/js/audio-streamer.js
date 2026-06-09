/**
 * AudioStreamer - Handles audio input (microphone) and output (playback)
 * for Gemini Live API integration.
 *
 * Features:
 * - Microphone capture at 16kHz via AudioWorklet
 * - Gapless audio playback at 24kHz
 * - Interruption support (stop playback immediately)
 * - Resource cleanup
 */
class AudioStreamer {
    constructor(options = {}) {
        this.onAudioData = options.onAudioData || null;
        this.onPlaybackStart = options.onPlaybackStart || null;
        this.onPlaybackEnd = options.onPlaybackEnd || null;

        // Audio format constants (Gemini API requirements)
        this.inputSampleRate = 16000;
        this.outputSampleRate = 24000;

        // Audio contexts
        this.inputContext = null;
        this.outputContext = null;

        // Microphone resources
        this.workletNode = null;
        this.mediaStream = null;
        this.sourceNode = null;

        // Playback resources
        this.audioSources = new Set();
        this.nextStartTime = 0;
        this.isCurrentlyPlaying = false;
    }

    /**
     * Start capturing audio from microphone
     */
    async startCapture() {
        try {
            // Request microphone permission
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: this.inputSampleRate,
                    echoCancellation: true,
                    noiseSuppression: true,
                }
            });

            // Create input audio context at 16kHz
            this.inputContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.inputSampleRate
            });

            // Create output audio context at 24kHz
            this.outputContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.outputSampleRate
            });

            // Load AudioWorklet processor
            await this.inputContext.audioWorklet.addModule('/gpt/frontend/assets/js/audio-processor.js');

            // Create media stream source
            this.sourceNode = this.inputContext.createMediaStreamSource(this.mediaStream);

            // Create worklet node
            this.workletNode = new AudioWorkletNode(this.inputContext, 'audio-processor');

            // Handle PCM data from worklet
            this.workletNode.port.onmessage = (event) => {
                if (event.data.pcmData && this.onAudioData) {
                    const base64Data = this.arrayBufferToBase64(event.data.pcmData);
                    this.onAudioData(base64Data);
                }
            };

            // Connect the audio pipeline
            this.sourceNode.connect(this.workletNode);

            // Browsers can create AudioContexts in 'suspended' state on pages
            // that already hold other audio contexts. Force-resume both so the
            // worklet actually receives samples.
            if (this.inputContext.state === 'suspended') await this.inputContext.resume();
            if (this.outputContext.state === 'suspended') await this.outputContext.resume();
            console.log('[AudioStreamer] Microphone capture started');
            return true;
        } catch (error) {
            console.error('[AudioStreamer] Failed to start capture:', error);
            throw error;
        }
    }

    /**
     * Stop capturing audio from microphone
     */
    stopCapture() {
        // Disconnect worklet
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }

        // Disconnect source
        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        // Stop media stream tracks
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        console.log('[AudioStreamer] Microphone capture stopped');
    }

    /**
     * Play audio received from Gemini API (Base64 PCM at 24kHz)
     * Uses gapless scheduling for smooth playback
     */
    async playAudio(base64Data) {
        if (!this.outputContext) {
            console.warn('[AudioStreamer] Output context not initialized');
            return;
        }

        try {
            // Decode Base64 to Uint8Array
            const pcmData = this.base64ToArrayBuffer(base64Data);

            // Convert Int16 PCM to AudioBuffer
            const audioBuffer = this.pcmToAudioBuffer(pcmData);

            // Create buffer source
            const bufferSource = this.outputContext.createBufferSource();
            bufferSource.buffer = audioBuffer;
            bufferSource.connect(this.outputContext.destination);

            // Track playback state
            if (!this.isCurrentlyPlaying) {
                this.isCurrentlyPlaying = true;
                if (this.onPlaybackStart) {
                    this.onPlaybackStart();
                }
            }

            // Handle playback end
            bufferSource.addEventListener('ended', () => {
                this.audioSources.delete(bufferSource);
                if (this.audioSources.size === 0) {
                    this.isCurrentlyPlaying = false;
                    if (this.onPlaybackEnd) {
                        this.onPlaybackEnd();
                    }
                }
            });

            // Schedule gapless playback
            this.nextStartTime = Math.max(this.nextStartTime, this.outputContext.currentTime);
            bufferSource.start(this.nextStartTime);
            this.nextStartTime += audioBuffer.duration;

            // Track active source
            this.audioSources.add(bufferSource);

        } catch (error) {
            console.error('[AudioStreamer] Failed to play audio:', error);
        }
    }

    /**
     * Stop all audio playback immediately (for interruption handling)
     */
    stopPlayback() {
        this.audioSources.forEach(source => {
            try {
                source.stop();
            } catch (e) {
                // Source may have already ended
            }
        });
        this.audioSources.clear();
        this.nextStartTime = 0;
        this.isCurrentlyPlaying = false;

        if (this.onPlaybackEnd) {
            this.onPlaybackEnd();
        }

        console.log('[AudioStreamer] Playback stopped');
    }

    /**
     * Check if audio is currently playing
     */
    isPlaying() {
        return this.isCurrentlyPlaying;
    }

    /**
     * Get the output AudioContext for visualizer
     */
    getOutputContext() {
        return this.outputContext;
    }

    /**
     * Cleanup all resources
     */
    cleanup() {
        this.stopCapture();
        this.stopPlayback();

        if (this.inputContext) {
            this.inputContext.close();
            this.inputContext = null;
        }

        if (this.outputContext) {
            this.outputContext.close();
            this.outputContext = null;
        }

        console.log('[AudioStreamer] Cleanup complete');
    }

    /**
     * Convert ArrayBuffer to Base64 string
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert Base64 string to ArrayBuffer
     */
    base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Convert Int16 PCM data to AudioBuffer
     */
    pcmToAudioBuffer(pcmData) {
        const int16Array = new Int16Array(pcmData.buffer);
        const frameCount = int16Array.length;
        const audioBuffer = this.outputContext.createBuffer(1, frameCount, this.outputSampleRate);
        const channelData = audioBuffer.getChannelData(0);

        // Convert Int16 [-32768, 32767] to Float32 [-1, 1]
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = int16Array[i] / 32768.0;
        }

        return audioBuffer;
    }
}

// Export for use in other modules
window.AudioStreamer = AudioStreamer;
