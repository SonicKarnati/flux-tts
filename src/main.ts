import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, FluxTtsSettingTab, FluxTtsSettings, GROQ_MODELS } from "./settings";
import { RecorderController, RecordingResult } from "./recording";
import {
  TranscriptionSegment,
  cleanupTranscript,
  renderSegmentedTranscript,
  transcribeAudio,
  transcriptLengthWarning
} from "./transcription";
import {
  createNoteUnique,
  ensureParentFolder,
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

const PLUGIN_ID = "flux-tts";
const SECRET_KEY = `${PLUGIN_ID}-groq-api-key`;

interface SecretStorage {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
}

export default class FluxTtsPlugin extends Plugin {
  settings: FluxTtsSettings = { ...DEFAULT_SETTINGS };
  recorder: RecorderController | null = null;
  ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.recorder = new RecorderController({
      onFinish: (result) => {
        this.handleRecordingFinished(result).catch((error) => {
          console.error(error);
          new Notice(`Recording failed: ${error.message || error}`);
        });
      },
      onError: (error) => {
        console.error(error);
        new Notice(error.message);
      },
      onStateChange: (isRecording) => this.updateRibbonState(isRecording)
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

    this.addSettingTab(new FluxTtsSettingTab(this.app, this));
    this.updateRibbonState(false);
  }

  onunload(): void {
    this.recorder?.dispose();
    this.recorder = null;
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

    const stringKeys = ["audioFolder", "noteFolder", "audioNameTemplate", "noteNameTemplate", "noteTemplatePath"] as const;
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
  }

  async toggleRecording(): Promise<void> {
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
    } catch (error: any) {
      console.error(error);
      new Notice(`Could not start recording: ${error.message || error}`);
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

  async handleRecordingFinished(result: RecordingResult): Promise<void> {
    const context = createTemplateContext(new Date());
    const audioFileName = `${renderTemplate(this.settings.audioNameTemplate, context)}.${result.extension}`;
    const noteFileName = `${renderTemplate(this.settings.noteNameTemplate, context)}.md`;
    const audioPath = resolveAudioPath(this.app, this.settings, audioFileName);
    const notePath = resolveNotePath(this.app, this.settings, noteFileName);

    const audioBuffer = await result.blob.arrayBuffer();
    const savedAudioPath = await writeBinaryUnique(this.app, audioPath, `.${result.extension}`, audioBuffer);

    let transcriptText = "";
    let segments: TranscriptionSegment[] = [];
    let transcriptionFailed = false;
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
      transcriptText = transcription.text.trim();
      segments = transcription.segments;
    } catch (error: any) {
      console.error(error);
      transcriptionFailed = true;
      transcriptText = `Transcription failed: ${error.message || error}`;
      new Notice("Audio saved, but transcription failed.");
    }

    const useSegments = !transcriptionFailed && this.settings.segmentedTranscript && segments.length > 0;

    if (!transcriptionFailed && this.settings.cleanupTranscript && !useSegments && transcriptText) {
      try {
        transcriptText = await cleanupTranscript(apiKey, transcriptText);
      } catch (error) {
        console.error(error);
        new Notice("Transcript cleanup failed; using the raw transcript.");
      }
    }

    const transcriptForNote = useSegments ? renderSegmentedTranscript(segments, savedAudioPath) : transcriptText;

    let noteBody = await this.renderNote(transcriptForNote, savedAudioPath, context);
    if (!transcriptionFailed) {
      const warning = transcriptLengthWarning(transcriptText, result.durationSeconds);
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

  async renderNote(transcript: string, audioPath: string, context: TemplateContext): Promise<string> {
    const values = Object.assign({}, context, {
      transcript: transcript.trim(),
      audioPath,
      audioEmbed: `![[${audioPath}]]`
    });

    if (this.settings.useTemplate && this.settings.noteTemplatePath) {
      const template = await this.readNoteTemplate(this.settings.noteTemplatePath);
      if (template !== null) {
        return renderTemplate(template, values).trim();
      }
      new Notice(`Note template file not found: ${this.settings.noteTemplatePath}. Using the default layout.`);
    }

    return `${values.transcript}\n\n${values.audioEmbed}`;
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

  updateRibbonState(isRecording: boolean): void {
    if (!this.ribbonIconEl) {
      return;
    }

    this.ribbonIconEl.toggleClass("is-active", isRecording);
    this.ribbonIconEl.setAttr("aria-label", isRecording ? "Stop transcription" : "Start transcription");
    this.ribbonIconEl.setAttr("aria-pressed", String(isRecording));
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
