import { Notice } from "obsidian";

export interface MimeCandidate {
  mime: string;
  extension: string;
}

const MIME_CANDIDATES: MimeCandidate[] = [
  { mime: "audio/mp4", extension: "m4a" },
  { mime: "audio/aac", extension: "aac" },
  { mime: "audio/webm;codecs=opus", extension: "webm" },
  { mime: "audio/webm", extension: "webm" },
  { mime: "audio/ogg;codecs=opus", extension: "ogg" },
  { mime: "audio/ogg", extension: "ogg" }
];

const SILENCE_RMS_THRESHOLD = 0.01;
const SILENCE_WARNING_MS = 5000;
const SILENCE_AUTO_STOP_MS = 60000;
const SILENCE_POLL_MS = 250;

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  durationSeconds: number;
}

export interface RecorderHandlers {
  onFinish: (result: RecordingResult) => void;
  onError: (error: Error) => void;
  onStateChange: (state: RecorderState, message?: string) => void;
}

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "recovering" | "error";

export class RecorderController {
  private state: RecorderState = "idle";
  private cancelRequested = false;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private selectedMime: MimeCandidate | null = null;
  private startedAt = 0;
  private stoppedAt: number | null = null;
  private pausedAt: number | null = null;
  private totalPausedMs = 0;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private silenceInterval: number | null = null;

  private deviceChangeHandler: (() => void) | null = null;
  private activeDeviceId = "";
  private disconnectNotified = false;
  private manuallyPaused = false;
  private trackEndedHandler: (() => void) | null = null;

  constructor(private handlers: RecorderHandlers) {}

  get isActive(): boolean {
    return this.state !== "idle";
  }

  get isRecording(): boolean {
    return this.state === "recording";
  }

  get currentState(): RecorderState {
    return this.state;
  }

  /**
   * The live analyser node for the current recording, or null when not
   * recording (or when AudioContext is unavailable). Shared with silence
   * detection — it reads the same signal, it doesn't open a second capture.
   */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  async start(startDelayMs: number): Promise<void> {
    if (this.state !== "idle") {
      return;
    }

    this.state = "starting";
    this.handlers.onStateChange("starting");
    this.cancelRequested = false;
    this.stoppedAt = null;
    this.pausedAt = null;
    this.totalPausedMs = 0;
    this.disconnectNotified = false;

    try {
      this.selectedMime = pickMimeType();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = this.selectedMime ? { mimeType: this.selectedMime.mime } : undefined;
      const recorder = new MediaRecorder(this.mediaStream, options);
      this.mediaRecorder = recorder;
      this.chunks = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };
      recorder.onstop = () => this.finalize();

      // The stream is already open at this point, so any hardware warm-up
      // has happened; the delay only postpones when capture begins.
      if (startDelayMs > 0) {
        await sleep(startDelayMs);
      }
      if (this.cancelRequested) {
        this.cleanup();
        this.state = "idle";
        return;
      }

      recorder.start();
      this.startedAt = Date.now();
      this.state = "recording";
      this.watchSilence();
      this.watchDeviceChanges();
      this.handlers.onStateChange("recording");
    } catch (error) {
      this.cleanup();
      this.state = "idle";
      this.handlers.onStateChange("error", getErrorText(error));
      this.handlers.onStateChange("idle");
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  stop(): void {
    if (this.state === "starting") {
      this.cancelRequested = true;
      return;
    }
    if (
      !["recording", "paused", "recovering", "error"].includes(this.state) ||
      !this.mediaRecorder ||
      this.mediaRecorder.state === "inactive"
    ) {
      return;
    }

    this.stoppedAt = Date.now();
    this.state = "idle";
    this.handlers.onStateChange("idle");
    this.mediaRecorder.stop();
  }

  pause(message = "Transcription paused."): void {
    if (this.state !== "recording" || !this.mediaRecorder) return;
    this.manuallyPaused = true;
    this.pausedAt = Date.now();
    if (this.mediaRecorder.state === "recording") {
      this.mediaRecorder.requestData();
      this.mediaRecorder.pause();
    }
    this.state = "paused";
    this.stopSilenceWatch();
    this.handlers.onStateChange("paused", message);
  }

  async resume(): Promise<void> {
    if (this.state !== "paused" && this.state !== "error") return;
    this.manuallyPaused = false;
    const track = this.mediaStream?.getAudioTracks()[0];
    if (track?.readyState === "live" && this.mediaRecorder?.state === "paused") {
      this.finishPauseTiming();
      this.mediaRecorder.resume();
      this.state = "recording";
      this.watchSilence();
      this.handlers.onStateChange("recording", "Transcription resumed.");
      return;
    }
    await this.recoverMicrophone();
  }

  /** Tear everything down without producing a recording (plugin unload). */
  dispose(): void {
    this.cancelRequested = true;
    if (this.mediaRecorder) {
      this.mediaRecorder.onstop = null;
      if (this.mediaRecorder.state === "recording") {
        try {
          this.mediaRecorder.stop();
        } catch (error) {
          console.error(error);
        }
      }
    }
    this.cleanup();
    this.state = "idle";
    this.handlers.onStateChange("idle");
  }

  private finalize(): void {
    const chunks = this.chunks;
    const selectedMime = this.selectedMime;
    const mimeType = selectedMime?.mime || chunks[0]?.type || "audio/webm";
    const extension = selectedMime?.extension || extensionFromMime(mimeType);
    const pausedMs = this.totalPausedMs + (this.pausedAt === null ? 0 : (this.stoppedAt ?? Date.now()) - this.pausedAt);
    const durationSeconds = Math.max(0, ((this.stoppedAt ?? Date.now()) - this.startedAt - pausedMs) / 1000);

    this.cleanup();
    this.state = "idle";

    if (!chunks.length) {
      this.handlers.onError(new Error("No audio was captured."));
      return;
    }

    this.handlers.onFinish({
      blob: new Blob(chunks, { type: mimeType }),
      mimeType,
      extension,
      durationSeconds
    });
  }

  private cleanup(): void {
    this.stopSilenceWatch();

    if (this.deviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener("devicechange", this.deviceChangeHandler);
      this.deviceChangeHandler = null;
    }

    if (this.mediaStream) {
      const track = this.mediaStream.getAudioTracks()[0];
      if (track && this.trackEndedHandler) track.removeEventListener("ended", this.trackEndedHandler);
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    this.trackEndedHandler = null;

    this.mediaRecorder = null;
    this.chunks = [];
    this.selectedMime = null;
  }

  private watchSilence(): void {
    if (typeof AudioContext === "undefined" || !this.mediaStream) {
      return;
    }

    let analyser: AnalyserNode;
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.analyser = analyser;
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume();
      }
    } catch (error) {
      console.error(error);
      return;
    }

    const data = new Uint8Array(analyser.fftSize);

    // Runs for the whole recording, not just the start: a mic can go silent
    // mid-recording too (OS-level mute, unplugged capsule, etc). Muting
    // doesn't fire `devicechange` or drop the device from
    // `enumerateDevices()` — it's the same device, just producing silence —
    // so volume analysis is the only reliable way to catch it.
    let hasHeardSound = false;
    let silenceStartedAt: number | null = Date.now();
    let earlyWarningShown = false;

    this.silenceInterval = window.setInterval(() => {
      // A suspended context reads as pure silence; don't judge until it runs.
      if (this.audioContext?.state !== "running") {
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);

      if (rms > SILENCE_RMS_THRESHOLD) {
        hasHeardSound = true;
        silenceStartedAt = null;
        return;
      }

      if (silenceStartedAt === null) {
        silenceStartedAt = Date.now();
      }
      const silenceElapsed = Date.now() - silenceStartedAt;

      // Only warn about "no audio yet" before anything has ever come through —
      // a normal mid-conversation pause shouldn't trigger a "check your mic" notice.
      if (!hasHeardSound && !earlyWarningShown && silenceElapsed >= SILENCE_WARNING_MS) {
        earlyWarningShown = true;
        new Notice("No audio detected from your microphone. Check your input device.");
      }

      if (silenceElapsed >= SILENCE_AUTO_STOP_MS) {
        this.stopSilenceWatch();
        new Notice("No audio detected for over a minute — stopping the recording automatically to save battery.");
        this.stop();
      }
    }, SILENCE_POLL_MS);
  }

  private stopSilenceWatch(): void {
    if (this.silenceInterval !== null) {
      window.clearInterval(this.silenceInterval);
      this.silenceInterval = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
  }

  private watchDeviceChanges(): void {
    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }

    if (this.deviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener("devicechange", this.deviceChangeHandler);
    }
    const track = this.mediaStream?.getAudioTracks()[0];
    this.activeDeviceId = track?.getSettings?.().deviceId ?? "";
    if (track) {
      this.trackEndedHandler = () => void this.handleMicrophoneLost();
      track.addEventListener("ended", this.trackEndedHandler);
    }

    this.deviceChangeHandler = () => {
      void this.checkInputStillPresent();
    };
    navigator.mediaDevices.addEventListener("devicechange", this.deviceChangeHandler);
  }

  private async checkInputStillPresent(): Promise<void> {
    if (this.state !== "recording" || this.disconnectNotified) {
      return;
    }

    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
      console.error(error);
      return;
    }

    const inputs = devices.filter((device) => device.kind === "audioinput");
    const stillPresent = this.activeDeviceId
      ? inputs.some((device) => device.deviceId === this.activeDeviceId)
      : inputs.length > 0;
    if (stillPresent) {
      return;
    }

    await this.handleMicrophoneLost();
  }

  private async handleMicrophoneLost(): Promise<void> {
    if (!["recording", "paused"].includes(this.state) || this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.manuallyPaused = false;
    if (this.pausedAt === null) this.pausedAt = Date.now();
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.requestData();
      this.mediaRecorder.pause();
    }
    this.stopSilenceWatch();
    this.state = "recovering";
    this.handlers.onStateChange("recovering", "Microphone access was interrupted. Reconnecting…");
    await this.recoverMicrophone();
  }

  private async recoverMicrophone(): Promise<void> {
    this.state = "recovering";
    this.handlers.onStateChange("recovering", "Restoring microphone access…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const previousRecorder = this.mediaRecorder;
      if (previousRecorder && previousRecorder.state !== "inactive") {
        previousRecorder.onstop = null;
        previousRecorder.stop();
      }
      if (this.mediaStream) this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = stream;
      const options = this.selectedMime ? { mimeType: this.selectedMime.mime } : undefined;
      const recorder = new MediaRecorder(stream, options);
      recorder.ondataavailable = (event) => {
        if (event.data?.size) this.chunks.push(event.data);
      };
      recorder.onstop = () => this.finalize();
      this.mediaRecorder = recorder;
      recorder.start();
      this.disconnectNotified = false;
      this.finishPauseTiming();
      this.state = "recording";
      this.watchSilence();
      this.watchDeviceChanges();
      this.handlers.onStateChange("recording", "Transcription resumed.");
    } catch (error) {
      console.error(error);
      this.state = "error";
      this.handlers.onStateChange("error", "Microphone could not be restored. Use Resume to try again.");
    }
  }

  private finishPauseTiming(): void {
    if (this.pausedAt !== null) {
      this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }
}

function pickMimeType(): MimeCandidate | null {
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mime)) {
      return candidate;
    }
  }
  return null;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  return "audio";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
