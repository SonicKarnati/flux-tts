import { Editor, MarkdownView, Notice, Platform, Plugin, TFile, normalizePath, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, FluxTtsSettingTab, FluxTtsSettings, GROQ_MODELS } from "./settings";
import { RecorderController, RecorderState, RecordingResult } from "./recording";
import { WaveformView } from "./waveform";
import {
  TranscriptionSegment,
  cleanupTranscript,
  renderSegmentedTranscript,
  transcribeAudio,
  transcriptLengthWarning
} from "./transcription";
import {
  createNoteUnique,
  resolveAudioPath,
  resolveNotePath,
  writeBinaryUnique
} from "./paths";
import {
  FILENAME_TEMPLATE_KEYS,
  TemplateContext,
  createTemplateContext,
  renderTemplate,
  validateTemplate
} from "./templates";
import { extractMediaUrl, fetchMediaTranscript } from "./media";
import { RetryBlockData, createRetryBlock, findRetryBlock, parseRetryBlock, recordingAction } from "./recording-ui-state";

const PLUGIN_ID = "flux-tts";
const SECRET_KEY = `${PLUGIN_ID}-groq-api-key`;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SecretStorage {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
}

// Shape of Obsidian's internal left-ribbon registry, narrowed to what we touch.
interface RibbonItem {
  title?: string;
  ariaLabel?: string;
  buttonEl?: HTMLElement;
}

interface RibbonHost {
  items?: RibbonItem[];
}

/**
 * An in-progress inline transcription: the transcript replaces `placeholder`
 * (dropped at the cursor when recording started) in `editor`, and a footnote
 * keyed by `id` links the inserted text back to the saved recording.
 */
interface InlineSession {
  editor: Editor;
  id: string;
  placeholder: string;
}

function mimeFromFileName(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "m4a" || extension === "mp4") return "audio/mp4";
  if (extension === "aac") return "audio/aac";
  if (extension === "ogg") return "audio/ogg";
  return "audio/webm";
}

export default class FluxTtsPlugin extends Plugin {
  settings: FluxTtsSettings = { ...DEFAULT_SETTINGS };
  recorder: RecorderController | null = null;
  ribbonIconEl: HTMLElement | null = null;
  waveform: WaveformView | null = null;
  private waveformFloatEl: HTMLElement | null = null;
  private inlineSession: InlineSession | null = null;
  private pausedForBackground = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.recorder = new RecorderController({
      onFinish: (result) => {
        this.handleRecordingFinished(result).catch((error: unknown) => {
          console.error(error);
          new Notice(`Recording failed: ${getErrorMessage(error)}`);
        });
      },
      onError: (error) => {
        console.error(error);
        new Notice(error.message);
      },
      onStateChange: (state, message) => this.handleRecorderState(state, message)
    });

    this.ribbonIconEl = this.addRibbonIcon("mic", "Start transcription", () => {
      void this.toggleRecording();
    });

    this.addCommand({
      id: "toggle-recording",
      name: "Toggle recording",
      callback: () => void this.toggleRecording()
    });

    this.addCommand({
      id: "start-recording",
      name: "Start recording",
      callback: () => {
        if (this.recorder?.isActive) {
          new Notice("Already recording.");
          return;
        }
        void this.startRecording();
      }
    });

    this.addCommand({
      id: "stop-recording",
      name: "Stop recording",
      callback: () => {
        if (!this.recorder?.isActive) {
          new Notice("Not recording.");
          return;
        }
        this.stopRecording();
      }
    });

    this.addCommand({
      id: "cycle-transcription-model",
      name: "Cycle transcription model",
      callback: async () => {
        const index = GROQ_MODELS.findIndex((model) => model.id === this.settings.model);
        const next = GROQ_MODELS[(index + 1) % GROQ_MODELS.length];
        this.settings.model = next.id;
        await this.saveSettings();
        new Notice(`Transcription model: ${next.name}`);
      }
    });

    this.addCommand({
      id: "toggle-inline-transcription",
      name: "Toggle inline transcription (at cursor)",
      callback: () => void this.toggleInlineRecording()
    });

    this.addCommand({
      id: "start-inline-transcription",
      name: "Start inline transcription (at cursor)",
      callback: () => {
        if (this.recorder?.isActive) {
          new Notice("Already recording.");
          return;
        }
        void this.startInlineRecording();
      }
    });

    this.addCommand({
      id: "stop-inline-transcription",
      name: "Stop inline transcription",
      callback: () => {
        if (!this.recorder?.isActive) {
          new Notice("Not recording.");
          return;
        }
        this.stopRecording();
      }
    });

    this.addCommand({
      id: "retry-current-note-transcription",
      name: "Retry current note transcription",
      callback: () => void this.retryCurrentNoteTranscription()
    });

    this.addSettingTab(new FluxTtsSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor("flux-tts-retry", (source, element, context) => {
      this.renderRetryBlock(source, element, context.sourcePath);
    });
    this.registerEvent(
      this.app.workspace.on("editor-paste", (event, editor) => {
        if (event.defaultPrevented) return;
        if (!this.settings.autoMediaTranscripts) return;
        const pastedText = event.clipboardData?.getData("text/plain") ?? "";
        const mediaUrl = extractMediaUrl(pastedText);
        if (!mediaUrl) return;
        event.preventDefault();
        const footnoteId = `media-${Date.now().toString(36)}`;
        editor.replaceSelection(`${pastedText} [^${footnoteId}]`);
        void this.insertMediaTranscript(editor, footnoteId, mediaUrl);
      })
    );
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (!this.recorder?.isActive) return;
      if (activeDocument.hidden && this.recorder.isRecording) {
        this.pausedForBackground = true;
        this.recorder.pause("Transcription paused while Obsidian is in the background.");
      } else if (!activeDocument.hidden && this.pausedForBackground) {
        this.pausedForBackground = false;
        void this.recorder.resume().catch((error: unknown) => {
          console.error(error);
          new Notice(`Could not resume recording: ${getErrorMessage(error)}`);
        });
      }
    });
    this.setupWaveform();
    this.updateRibbonState(false);
  }

  onunload(): void {
    this.recorder?.dispose();
    this.recorder = null;
    this.waveform?.dispose();
    this.waveform = null;
    this.waveformFloatEl?.remove();
    this.waveformFloatEl = null;
  }

  /**
   * Create the live-waveform view. Desktop has a status bar to host it; mobile
   * doesn't, so we use a floating pill that CSS reveals only while recording.
   */
  private setupWaveform(): void {
    let container: HTMLElement;
    if (Platform.isMobile) {
      this.waveformFloatEl = activeDocument.body.createDiv({ cls: "flux-tts-waveform-float" });
      container = this.waveformFloatEl;
    } else {
      container = this.addStatusBarItem();
      container.addClass("flux-tts-waveform-status");
    }
    this.waveform = new WaveformView(container, () => this.recorder?.getAnalyser() ?? null);
  }

  async loadSettings(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<FluxTtsSettings> & { noteTemplate?: string };

    // Migration: the free-text note folder became a mode dropdown. A
    // previously configured folder means the user wants a separate folder.
    if (!saved.noteFolderMode) {
      saved.noteFolderMode = typeof saved.noteFolder === "string" && saved.noteFolder.trim() ? "custom" : "root";
    }
    delete saved.noteTemplate;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.validateSettings();
  }

  async saveSettings(): Promise<void> {
    this.validateSettings();
    await this.saveData(this.settings);
  }

  validateSettings(): void {
    if (!GROQ_MODELS.some((model) => model.id === this.settings.model)) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    if (!["audio-folder", "attachments", "root"].includes(this.settings.saveLocation)) {
      this.settings.saveLocation = DEFAULT_SETTINGS.saveLocation;
    }

    if (!["root", "attachments", "custom"].includes(this.settings.noteFolderMode)) {
      this.settings.noteFolderMode = DEFAULT_SETTINGS.noteFolderMode;
    }

    const stringKeys = [
      "audioFolder",
      "noteFolder",
      "audioNameTemplate",
      "noteNameTemplate",
      "noteTemplatePath"
    ] as const;
    for (const key of stringKeys) {
      if (typeof this.settings[key] !== "string") {
        this.settings[key] = DEFAULT_SETTINGS[key];
      }
    }

    for (const key of ["audioNameTemplate", "noteNameTemplate"] as const) {
      if (!validateTemplate(this.settings[key], FILENAME_TEMPLATE_KEYS).valid) {
        this.settings[key] = DEFAULT_SETTINGS[key];
      }
    }

    const delay = Number(this.settings.startDelayMs);
    this.settings.startDelayMs = Number.isFinite(delay) ? Math.min(2000, Math.max(0, Math.round(delay))) : 0;

    this.settings.useTemplate = Boolean(this.settings.useTemplate);
    this.settings.cleanupTranscript = Boolean(this.settings.cleanupTranscript);
    this.settings.segmentedTranscript = Boolean(this.settings.segmentedTranscript);
    this.settings.autoMediaTranscripts = Boolean(this.settings.autoMediaTranscripts);
  }

  private async insertMediaTranscript(editor: Editor, footnoteId: string, mediaUrl: string): Promise<void> {
    new Notice("Fetching media transcript…");
    try {
      const result = await fetchMediaTranscript({
        url: mediaUrl,
        apiKey: this.getApiKey(),
        model: this.settings.model,
        wantSegments: this.settings.segmentedTranscript
      });
      let transcript = result.text.trim();
      if (this.settings.cleanupTranscript && !this.settings.segmentedTranscript && this.getApiKey()) {
        transcript = await cleanupTranscript(this.getApiKey(), transcript);
      }
      const indented = transcript.replace(/\n+/g, "\n    ");
      const label = result.title.replace(/\[|\]/g, "");
      const footnote = `\n\n[^${footnoteId}]: **[${label}](${result.sourceUrl})** — transcript\n    ${indented}`;
      const lastLine = editor.lastLine();
      editor.replaceRange(footnote, { line: lastLine, ch: editor.getLine(lastLine).length });
      new Notice("Media transcript added.");
    } catch (error) {
      const message = getErrorMessage(error);
      const lastLine = editor.lastLine();
      const footnote = `\n\n[^${footnoteId}]: Transcript unavailable — ${message}`;
      editor.replaceRange(footnote, { line: lastLine, ch: editor.getLine(lastLine).length });
      new Notice(`Could not transcribe media link: ${message}`);
    }
  }

  async toggleRecording(): Promise<void> {
    if (this.recorder?.currentState === "paused" || this.recorder?.currentState === "error") {
      await this.recorder.resume();
      return;
    }
    if (this.recorder?.isActive) {
      this.stopRecording();
      return;
    }
    await this.startRecording();
  }

  async startRecording(): Promise<void> {
    if (!this.recorder || this.recorder.isActive) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      new Notice("Audio recording is not available in this Obsidian environment.");
      return;
    }

    if (!this.getApiKey()) {
      new Notice("Add your Groq API key in Flux TTS settings first.");
      return;
    }

    try {
      await this.recorder.start(this.settings.startDelayMs);
      if (this.recorder.isRecording) {
        new Notice("Recording started.");
      }
    } catch (error: unknown) {
      console.error(error);
      new Notice(`Could not start recording: ${getErrorMessage(error)}`);
    }
  }

  stopRecording(): void {
    if (!this.recorder?.isActive) {
      return;
    }
    const wasRecording = this.recorder.isRecording;
    this.recorder.stop();
    if (wasRecording) {
      new Notice("Saving and transcribing...");
    }
  }

  private handleRecorderState(state: RecorderState, message?: string): void {
    const action = recordingAction(state);
    this.updateRibbonState(action.active, action.label, action.icon);
    if (message && state === "error") new Notice(message);
  }

  async toggleInlineRecording(): Promise<void> {
    if (this.recorder?.isActive) {
      this.stopRecording();
      return;
    }
    await this.startInlineRecording();
  }

  /**
   * Start a recording that will be inserted at the cursor of the active note
   * (rather than creating a new note). A placeholder is dropped in immediately
   * so the insertion point survives any editing done while recording.
   */
  async startInlineRecording(): Promise<void> {
    if (!this.recorder || this.recorder.isActive) {
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note and place the cursor where the transcription should go.");
      return;
    }

    const editor = view.editor;
    const id = `flux-${Date.now().toString(36)}`;
    const placeholder = `⟨transcribing… ${id}⟩`;
    editor.replaceSelection(placeholder);
    this.inlineSession = { editor, id, placeholder };

    await this.startRecording();

    // startRecording is a no-op-with-Notice when the mic or API key is missing;
    // if it didn't actually start, roll the placeholder back out.
    if (!this.recorder.isActive) {
      this.removeInlinePlaceholder(this.inlineSession);
      this.inlineSession = null;
    }
  }

  private removeInlinePlaceholder(session: InlineSession): void {
    const { editor, placeholder } = session;
    const content = editor.getValue();
    const index = content.indexOf(placeholder);
    if (index >= 0) {
      editor.replaceRange("", editor.offsetToPos(index), editor.offsetToPos(index + placeholder.length));
    }
  }

  async handleRecordingFinished(result: RecordingResult): Promise<void> {
    // Inline mode inserts at the cursor instead of creating a note. Claim the
    // session up front so a second recording can't reuse a stale placeholder.
    const inline = this.inlineSession;
    this.inlineSession = null;
    if (inline) {
      await this.handleInlineFinished(result, inline);
      return;
    }

    const context = createTemplateContext(new Date());
    const audioFileName = `${renderTemplate(this.settings.audioNameTemplate, context)}.${result.extension}`;
    const noteFileName = `${renderTemplate(this.settings.noteNameTemplate, context)}.md`;
    const audioPath = resolveAudioPath(this.app, this.settings, audioFileName);
    const notePath = resolveNotePath(this.app, this.settings, noteFileName);

    const audioBuffer = await result.blob.arrayBuffer();
    const savedAudioPath = await writeBinaryUnique(this.app, audioPath, `.${result.extension}`, audioBuffer);

    let rawTranscript = "";
    let segments: TranscriptionSegment[] = [];
    let transcriptionFailed = false;
    let transcriptionError = "Unknown transcription error.";
    const apiKey = this.getApiKey();

    try {
      if (!apiKey) {
        throw new Error("Missing Groq API key.");
      }
      const transcription = await transcribeAudio({
        apiKey,
        model: this.settings.model,
        blob: result.blob,
        fileName: audioFileName,
        wantSegments: this.settings.segmentedTranscript
      });
      rawTranscript = transcription.text.trim();
      segments = transcription.segments;
    } catch (error: unknown) {
      console.error(error);
      transcriptionFailed = true;
      transcriptionError = getErrorMessage(error);
      rawTranscript = `Transcription failed: ${transcriptionError}`;
      new Notice("Audio saved, but transcription failed.");
    }

    const useSegments = !transcriptionFailed && this.settings.segmentedTranscript && segments.length > 0;

    // originalTranscript stays empty unless cleanup actually ran, so the note
    // only gets an "Original transcript" section when there's a real raw
    // version to show alongside the cleaned-up one.
    let displayTranscript = rawTranscript;
    let originalTranscript = "";

    if (!transcriptionFailed && this.settings.cleanupTranscript && !useSegments && rawTranscript) {
      try {
        displayTranscript = await cleanupTranscript(apiKey, rawTranscript);
        originalTranscript = rawTranscript;
      } catch (error) {
        console.error(error);
        new Notice("Transcript cleanup failed; using the raw transcript.");
      }
    }

    const retryBlock = createRetryBlock({
      audioPath: savedAudioPath,
      fileName: audioFileName,
      message: transcriptionError
    });
    const transcriptForNote = transcriptionFailed
      ? retryBlock
      : useSegments
        ? renderSegmentedTranscript(segments, savedAudioPath)
        : displayTranscript;

    let noteBody = await this.renderNote(transcriptForNote, savedAudioPath, context, originalTranscript);
    if (!transcriptionFailed) {
      const warning = transcriptLengthWarning(rawTranscript, result.durationSeconds);
      if (warning) {
        noteBody += warning;
      }
    }

    const createdNotePath = await createNoteUnique(this.app, notePath, noteBody);
    const file = this.app.vault.getAbstractFileByPath(createdNotePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }

    new Notice("Transcription saved.");
  }

  private async handleInlineFinished(result: RecordingResult, session: InlineSession): Promise<void> {
    const context = createTemplateContext(new Date());
    const audioFileName = `${renderTemplate(this.settings.audioNameTemplate, context)}.${result.extension}`;
    const audioPath = resolveAudioPath(this.app, this.settings, audioFileName);
    const audioBuffer = await result.blob.arrayBuffer();
    const savedAudioPath = await writeBinaryUnique(this.app, audioPath, `.${result.extension}`, audioBuffer);

    const { text, failed } = await this.runInlineTranscription(result, audioFileName);

    try {
      this.insertInlineTranscript(session, text, savedAudioPath);
      new Notice(failed ? "Audio saved; transcription failed — see the note." : "Transcription inserted.");
    } catch (error) {
      console.error(error);
      // The editor may have been closed mid-recording. Don't lose the audio.
      this.removeInlinePlaceholder(session);
      new Notice(`Could not insert inline. Recording saved at ${savedAudioPath}.`);
    }
  }

  /** Save-path-free transcription for inline mode: no segments, cleanup if enabled. */
  private async runInlineTranscription(
    result: RecordingResult,
    audioFileName: string
  ): Promise<{ text: string; failed: boolean }> {
    const apiKey = this.getApiKey();
    try {
      if (!apiKey) {
        throw new Error("Missing Groq API key.");
      }
      const transcription = await transcribeAudio({
        apiKey,
        model: this.settings.model,
        blob: result.blob,
        fileName: audioFileName,
        wantSegments: false
      });
      let text = transcription.text.trim();
      if (this.settings.cleanupTranscript && text) {
        try {
          text = await cleanupTranscript(apiKey, text);
        } catch (error) {
          console.error(error);
          new Notice("Transcript cleanup failed; using the raw transcript.");
        }
      }
      return { text, failed: false };
    } catch (error: unknown) {
      console.error(error);
      new Notice("Audio saved, but transcription failed.");
      return { text: `Transcription failed: ${getErrorMessage(error)}`, failed: true };
    }
  }

  /**
   * Replace the placeholder with the transcript plus a footnote reference, and
   * append the footnote definition (a link back to the recording) at the end of
   * the note. Obsidian renders `[^id]` as a Wikipedia-style superscript link.
   */
  private insertInlineTranscript(session: InlineSession, text: string, audioPath: string): void {
    const { editor, id, placeholder } = session;
    const replacement = `${text.trim()}[^${id}]`;

    const content = editor.getValue();
    const index = content.indexOf(placeholder);
    if (index >= 0) {
      editor.replaceRange(replacement, editor.offsetToPos(index), editor.offsetToPos(index + placeholder.length));
    } else {
      // Placeholder was edited away; fall back to the current cursor.
      editor.replaceSelection(replacement);
    }

    const definition = `[^${id}]: [[${audioPath}]]`;
    const current = editor.getValue();
    const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const lastLine = editor.lastLine();
    const endPos = { line: lastLine, ch: editor.getLine(lastLine).length };
    editor.replaceRange(`${separator}${definition}\n`, endPos);
  }

  async renderNote(
    transcript: string,
    audioPath: string,
    context: TemplateContext,
    originalTranscript: string
  ): Promise<string> {
    const values = Object.assign({}, context, {
      transcript: transcript.trim(),
      audioPath,
      audioEmbed: `![[${audioPath}]]`,
      originalTranscript: originalTranscript.trim()
    });

    if (this.settings.useTemplate && this.settings.noteTemplatePath) {
      const template = await this.readNoteTemplate(this.settings.noteTemplatePath);
      if (template !== null) {
        return renderTemplate(template, values).trim();
      }
      new Notice(`Note template file not found: ${this.settings.noteTemplatePath}. Using the default layout.`);
    }

    let body = `${values.transcript}\n\n${values.audioEmbed}`;
    if (values.originalTranscript) {
      body += `\n\n## Original transcript\n\n${values.originalTranscript}`;
    }
    return body;
  }

  private renderRetryBlock(source: string, element: HTMLElement, notePath: string): void {
    let data: RetryBlockData;
    try {
      data = parseRetryBlock(source);
    } catch (error) {
      console.error(error);
      element.setText("This transcription retry block is invalid.");
      return;
    }

    element.addClass("flux-tts-retry");
    element.createDiv({ cls: "flux-tts-retry-error", text: data.message });
    const button = element.createEl("button", { text: "Retry transcription", cls: "mod-cta" });
    button.addEventListener("click", () => {
      button.disabled = true;
      button.setText("Retrying…");
      void this.retryTranscription(notePath, source, data).catch((error: unknown) => {
        console.error(error);
        button.disabled = false;
        button.setText("Retry transcription");
        new Notice(`Retry failed: ${getErrorMessage(error)}`);
      });
    });
  }

  private async retryCurrentNoteTranscription(): Promise<void> {
    const note = this.app.workspace.getActiveFile();
    if (!(note instanceof TFile) || note.extension !== "md") {
      new Notice("Open a transcript note with a failed transcription first.");
      return;
    }

    const content = await this.app.vault.read(note);
    const retry = findRetryBlock(content);
    if (!retry) {
      new Notice("This note has no failed transcription to retry.");
      return;
    }

    try {
      await this.retryTranscription(note.path, retry.source, retry.data);
    } catch (error: unknown) {
      console.error(error);
      new Notice(`Retry failed: ${getErrorMessage(error)}`);
    }
  }

  private async retryTranscription(notePath: string, blockSource: string, data: RetryBlockData): Promise<void> {
    const note = this.app.vault.getAbstractFileByPath(notePath);
    const audio = this.app.vault.getAbstractFileByPath(data.audioPath);
    if (!(note instanceof TFile) || !(audio instanceof TFile)) {
      throw new Error("The recording note or audio file is missing.");
    }
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("Add your Groq API key in Flux TTS settings first.");

    const buffer = await this.app.vault.readBinary(audio);
    const blob = new Blob([buffer], { type: mimeFromFileName(data.fileName) });
    const result = await transcribeAudio({
      apiKey,
      model: this.settings.model,
      blob,
      fileName: data.fileName,
      wantSegments: this.settings.segmentedTranscript
    });
    let transcript = this.settings.segmentedTranscript && result.segments.length
      ? renderSegmentedTranscript(result.segments, data.audioPath)
      : result.text.trim();
    if (this.settings.cleanupTranscript && !this.settings.segmentedTranscript && transcript) {
      transcript = await cleanupTranscript(apiKey, transcript);
    }

    const content = await this.app.vault.read(note);
    const block = `\`\`\`flux-tts-retry\n${blockSource}\n\`\`\``;
    if (!content.includes(block)) throw new Error("The retry block has changed or was removed.");
    await this.app.vault.modify(note, content.replace(block, transcript));
    new Notice("Transcription completed.");
  }

  private async readNoteTemplate(path: string): Promise<string | null> {
    const normalized = normalizePath(path);
    for (const candidate of [normalized, `${normalized}.md`]) {
      const file = this.app.vault.getAbstractFileByPath(candidate);
      if (file instanceof TFile) {
        return this.app.vault.cachedRead(file);
      }
    }
    return null;
  }

  updateRibbonState(isRecording: boolean, overrideLabel?: string, overrideIcon?: string): void {
    if (isRecording) {
      this.waveform?.start();
    } else {
      this.waveform?.stop();
    }

    if (!this.ribbonIconEl) {
      return;
    }

    const label = overrideLabel ?? (isRecording ? "Stop transcription" : "Start transcription");
    this.ribbonIconEl.toggleClass("is-active", isRecording);
    this.ribbonIconEl.setAttr("aria-label", label);
    this.ribbonIconEl.setAttr("aria-pressed", String(isRecording));
    // Swap the glyph so state reads even where the text label is stale.
    setIcon(this.ribbonIconEl, overrideIcon ?? (isRecording ? "square" : "mic"));
    this.updateRibbonMenuLabel(label);
  }

  /**
   * The desktop `aria-label` above is enough on desktop, but Obsidian mobile
   * rebuilds its slide-up ribbon menu from each item's internal `title` — which
   * the DOM mutation never touches, so the menu kept showing "Start
   * transcription" after recording began. Update that title too so the next
   * menu rebuild reflects the real state. Internal API, guarded defensively so
   * it degrades to the desktop-only behavior if the shape ever changes.
   */
  private updateRibbonMenuLabel(label: string): void {
    const leftRibbon = (this.app.workspace as unknown as { leftRibbon?: RibbonHost }).leftRibbon;
    const item = leftRibbon?.items?.find((entry) => entry.buttonEl === this.ribbonIconEl);
    if (item) {
      item.title = label;
      if (typeof item.ariaLabel === "string") {
        item.ariaLabel = label;
      }
    }
  }

  getApiKey(): string {
    const secretStorage = (this.app as unknown as { secretStorage?: SecretStorage }).secretStorage;
    if (!secretStorage) {
      return "";
    }
    return secretStorage.getSecret(SECRET_KEY) || "";
  }

  setApiKey(value: string): void {
    const secretStorage = (this.app as unknown as { secretStorage?: SecretStorage }).secretStorage;
    if (!secretStorage) {
      throw new Error("Obsidian secret storage is not available.");
    }
    secretStorage.setSecret(SECRET_KEY, value.trim());
  }
}
