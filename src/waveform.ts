/**
 * A small live waveform renderer. Reads time-domain samples from an
 * AnalyserNode (supplied lazily, since the node only exists while recording)
 * and paints them onto a canvas with a requestAnimationFrame loop.
 *
 * The view is deliberately dumb about *where* it lives — main.ts hands it a
 * container (a status bar item on desktop, a floating pill on mobile) and
 * drives start()/stop() from the recording state.
 */
export class WaveformView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private rafId: number | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;

  constructor(
    private container: HTMLElement,
    private getAnalyser: () => AnalyserNode | null
  ) {
    this.canvas = container.createEl("canvas", { cls: "flux-tts-waveform-canvas" });
    this.ctx = this.canvas.getContext("2d");
  }

  /** Begin animating. Safe to call when already running. */
  start(): void {
    if (this.rafId !== null) {
      return;
    }
    this.container.toggleClass("is-recording", true);
    const loop = () => {
      this.draw();
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  /** Stop animating and clear the canvas. Safe to call when already stopped. */
  stop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.container.toggleClass("is-recording", false);
    this.clear();
  }

  /** Remove the canvas from the DOM (plugin unload). */
  dispose(): void {
    this.stop();
    this.canvas.remove();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const { width, height } = this.syncCanvasSize();
    ctx.clearRect(0, 0, width, height);

    const analyser = this.getAnalyser();
    ctx.fillStyle = this.strokeColor();

    if (!analyser) {
      // No signal (not recording, or AudioContext unavailable): flat midline.
      ctx.fillRect(0, Math.floor(height / 2), width, Math.max(1, Math.floor(height / 12)));
      return;
    }

    const bins = analyser.fftSize;
    if (!this.data || this.data.length !== bins) {
      this.data = new Uint8Array(new ArrayBuffer(bins));
    }
    const data = this.data;
    analyser.getByteTimeDomainData(data);

    const barCount = Math.max(12, Math.min(48, Math.floor(width / 6)));
    const gap = Math.max(1, Math.floor(width / barCount / 4));
    const barWidth = Math.max(1, width / barCount - gap);
    const samplesPerBar = Math.max(1, Math.floor(bins / barCount));
    for (let bar = 0; bar < barCount; bar += 1) {
      let peak = 0;
      const start = bar * samplesPerBar;
      for (let index = start; index < Math.min(bins, start + samplesPerBar); index += 1) {
        peak = Math.max(peak, Math.abs(data[index] - 128) / 128);
      }
      const barHeight = Math.max(2, peak * height);
      ctx.fillRect(bar * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
    }
  }

  /** Match the backing store to the element's CSS size (crisp on HiDPI). */
  private syncCanvasSize(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || this.container.clientWidth || 80;
    const cssHeight = this.canvas.clientHeight || this.container.clientHeight || 20;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== width) {
      this.canvas.width = width;
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height;
    }
    return { width, height };
  }

  private clear(): void {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private strokeColor(): string {
    // The canvas inherits `color` from CSS (accent-tinted); use it so the
    // waveform follows the theme in both light and dark mode.
    const color = window.getComputedStyle(this.canvas).color;
    return color || "#888";
  }
}
