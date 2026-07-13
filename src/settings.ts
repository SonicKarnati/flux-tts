import { App, PluginSettingTab, Setting, SettingDefinitionItem, normalizePath } from "obsidian";
import { FILENAME_TEMPLATE_KEYS, createTemplateContext, renderTemplate, sanitizeFileName, validateTemplate } from "./templates";
import type FluxTtsPlugin from "./main";

export const GROQ_MODELS = [
  { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo (fast)" },
  { id: "whisper-large-v3", name: "Whisper Large v3 (accurate)" }
];

export type AudioSaveLocation = "audio-folder" | "attachments" | "root";
export type NoteFolderMode = "root" | "attachments" | "custom";
export type RecordingNoteBehavior = "reuse" | "recreate";

export interface FluxTtsSettings {
  model: string;
  saveLocation: AudioSaveLocation;
  audioFolder: string;
  noteFolderMode: NoteFolderMode;
  noteFolder: string;
  audioNameTemplate: string;
  noteNameTemplate: string;
  useTemplate: boolean;
  noteTemplatePath: string;
  startDelayMs: number;
  cleanupTranscript: boolean;
  segmentedTranscript: boolean;
  autoMediaTranscripts: boolean;
  recordingNoteEnabled: boolean;
  recordingNoteFolderMode: NoteFolderMode;
  recordingNoteFolder: string;
  recordingNoteBehavior: RecordingNoteBehavior;
}

export const DEFAULT_SETTINGS: FluxTtsSettings = {
  model: "whisper-large-v3-turbo",
  saveLocation: "audio-folder",
  audioFolder: "audio recordings",
  noteFolderMode: "root",
  noteFolder: "",
  audioNameTemplate: "{{date}} {{time}}",
  noteNameTemplate: "Transcription_{{date}} {{time}}",
  useTemplate: false,
  noteTemplatePath: "",
  startDelayMs: 0,
  cleanupTranscript: false,
  segmentedTranscript: false,
  autoMediaTranscripts: false,
  recordingNoteEnabled: true,
  recordingNoteFolderMode: "root",
  recordingNoteFolder: "",
  recordingNoteBehavior: "reuse"
};

const API_KEY_MASK = "••••••••••••";

interface TemplateSettingOptions {
  name: string;
  desc: string;
  exampleExtension: string;
  fallback: string;
  getValue: () => string;
  setValue: (value: string) => void;
}

export class FluxTtsSettingTab extends PluginSettingTab {
  plugin: FluxTtsPlugin;

  constructor(app: App, plugin: FluxTtsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Transcription service",
        items: [
          { name: "Groq API key", render: (setting) => this.renderApiKeySetting(setting) },
          {
            name: "Groq model",
            desc: "Turbo is the default for fastest transcription.",
            control: { type: "dropdown", key: "model", options: Object.fromEntries(GROQ_MODELS.map((model) => [model.id, model.name])) }
          }
        ]
      },
      {
        type: "group",
        heading: "Recording",
        items: [
          {
            name: "Live recording note",
            desc: "Open a temporary Recording... note with a live waveform and Stop button while recording.",
            control: { type: "toggle", key: "recordingNoteEnabled" }
          },
          {
            name: "Recording note location",
            desc: "Choose where Recording....md is stored.",
            visible: () => this.plugin.settings.recordingNoteEnabled,
            control: {
              type: "dropdown",
              key: "recordingNoteFolderMode",
              options: { root: "Vault root", attachments: "Obsidian attachments folder", custom: "Custom folder" }
            }
          },
          {
            name: "Recording note folder",
            desc: "Vault-relative folder used for the temporary recording note.",
            visible: () => this.plugin.settings.recordingNoteEnabled && this.plugin.settings.recordingNoteFolderMode === "custom",
            control: { type: "text", key: "recordingNoteFolder", placeholder: "Recordings" }
          },
          {
            name: "Recording note behavior",
            desc: "Reuse preserves the note. Delete and recreate replaces it when the next recording starts.",
            visible: () => this.plugin.settings.recordingNoteEnabled,
            control: { type: "dropdown", key: "recordingNoteBehavior", options: { reuse: "Reuse existing note", recreate: "Delete and recreate" } }
          },
          {
            name: "Sync warning",
            desc: "Frequent file deletion and creation may cause unnecessary activity or conflicts with fast synchronization tools.",
            visible: () => this.plugin.settings.recordingNoteEnabled && this.plugin.settings.recordingNoteBehavior === "recreate"
          },
          {
            name: "Recording start delay",
            desc: "Milliseconds to wait after the microphone opens before capture begins.",
            control: { type: "slider", key: "startDelayMs", min: 0, max: 2000, step: 100 }
          }
        ]
      },
      {
        type: "group",
        heading: "Audio files",
        items: [
          {
            name: "Audio save location",
            desc: "Choose where recorded audio files are written.",
            control: { type: "dropdown", key: "saveLocation", options: { "audio-folder": "Separate audio folder", attachments: "Obsidian attachments folder", root: "Vault root" } }
          },
          {
            name: "Audio folder",
            desc: "Used when save location is set to a separate audio folder.",
            visible: () => this.plugin.settings.saveLocation === "audio-folder",
            control: { type: "text", key: "audioFolder" }
          },
          { name: "Audio filename", render: (setting) => this.renderTemplateSetting(setting, this.audioTemplateOptions()) }
        ]
      },
      {
        type: "group",
        heading: "Transcription notes",
        items: [
          {
            name: "Note save location",
            desc: "Choose where transcription notes are created.",
            control: { type: "dropdown", key: "noteFolderMode", options: { root: "Vault root", attachments: "Obsidian attachments folder", custom: "Separate folder" } }
          },
          {
            name: "Note folder",
            desc: "Used when note save location is set to a separate folder.",
            visible: () => this.plugin.settings.noteFolderMode === "custom",
            control: { type: "text", key: "noteFolder", placeholder: "transcriptions" }
          },
          { name: "Transcription note filename", render: (setting) => this.renderTemplateSetting(setting, this.noteTemplateOptions()) },
          {
            name: "Use note template",
            desc: "When off, notes contain only transcript text and the embedded audio link.",
            control: { type: "toggle", key: "useTemplate" }
          },
          {
            name: "Note template file",
            desc: "Vault path to a Markdown template. Supports transcript, audio, and date/time placeholders.",
            visible: () => this.plugin.settings.useTemplate,
            control: { type: "text", key: "noteTemplatePath", placeholder: "Templates/Transcription.md" }
          }
        ]
      },
      {
        type: "group",
        heading: "Transcript processing",
        items: [
          {
            name: "Automatically transcribe pasted media links",
            desc: "Add a citation-style transcript footnote when a supported media link is pasted.",
            control: { type: "toggle", key: "autoMediaTranscripts" }
          },
          {
            name: "Clean up transcript with AI",
            desc: "Fix punctuation, remove filler words, and add paragraph breaks while retaining the original.",
            control: { type: "toggle", key: "cleanupTranscript" }
          },
          {
            name: "Timestamped segments",
            desc: "Write timestamped segments linked to their position in the audio file.",
            control: { type: "toggle", key: "segmentedTranscript" }
          }
        ]
      }
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    if (!(key in settings)) return;
    settings[key] = key === "noteTemplatePath" && typeof value === "string" ? normalizePath(value.trim()) : value;
    await this.plugin.saveSettings();
    if (["recordingNoteEnabled", "recordingNoteFolderMode", "recordingNoteBehavior", "saveLocation", "noteFolderMode", "useTemplate"].includes(key)) {
      this.update();
    }
  }

  private renderApiKeySetting(setting: Setting): void {
    const hasApiKey = Boolean(this.plugin.getApiKey());
    setting.setDesc(hasApiKey ? "A key is saved in Obsidian secret storage." : "Stored in Obsidian secret storage.");
    setting.addText((text) => {
      text.setPlaceholder("gsk_...").setValue(hasApiKey ? API_KEY_MASK : "");
      text.inputEl.type = "password";
      text.inputEl.addEventListener("focus", () => { if (text.getValue() === API_KEY_MASK) text.setValue(""); });
      text.inputEl.addEventListener("blur", () => { if (!text.getValue().trim() && this.plugin.getApiKey()) text.setValue(API_KEY_MASK); });
      text.onChange((value) => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== API_KEY_MASK) this.plugin.setApiKey(trimmed);
      });
    }).addButton((button) => button.setButtonText("Clear").setDisabled(!hasApiKey).onClick(() => {
      this.plugin.setApiKey("");
      this.update();
    }));
  }

  private audioTemplateOptions(): TemplateSettingOptions {
    return {
      name: "Audio filename",
      desc: "Use date and time placeholders such as {{date}}, {{time}}, {{year}}, and {{second}}.",
      exampleExtension: ".m4a",
      fallback: DEFAULT_SETTINGS.audioNameTemplate,
      getValue: () => this.plugin.settings.audioNameTemplate,
      setValue: (value) => { this.plugin.settings.audioNameTemplate = value; }
    };
  }

  private noteTemplateOptions(): TemplateSettingOptions {
    return {
      name: "Transcription note filename",
      desc: "Uses the same filename placeholders as audio files.",
      exampleExtension: ".md",
      fallback: DEFAULT_SETTINGS.noteNameTemplate,
      getValue: () => this.plugin.settings.noteNameTemplate,
      setValue: (value) => { this.plugin.settings.noteNameTemplate = value; }
    };
  }

  private renderTemplateSetting(setting: Setting, options: TemplateSettingOptions): void {
    setting.setDesc(options.desc);
    const previewEl = setting.descEl.createDiv({ cls: "flux-tts-template-preview" });
    const updatePreview = (template: string): boolean => {
      const validation = validateTemplate(template, FILENAME_TEMPLATE_KEYS);
      previewEl.setText(validation.valid
        ? `Preview: ${sanitizeFileName(renderTemplate(template, createTemplateContext(new Date())))}${options.exampleExtension}`
        : validation.error ?? "Invalid template.");
      previewEl.toggleClass("flux-tts-template-invalid", !validation.valid);
      return validation.valid;
    };
    setting.addText((text) => text.setValue(options.getValue()).onChange(async (value) => {
      const template = value || options.fallback;
      if (!updatePreview(template)) return;
      options.setValue(template);
      await this.plugin.saveSettings();
    }));
    updatePreview(options.getValue());
  }
}
