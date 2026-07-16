import { App, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { FILENAME_TEMPLATE_KEYS, createTemplateContext, renderTemplate, sanitizeFileName, validateTemplate } from "./templates";
import type FluxTtsPlugin from "./main";

export const GROQ_MODELS = [
  { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo (fast)" },
  { id: "whisper-large-v3", name: "Whisper Large v3 (accurate)" }
];

export type AudioSaveLocation = "audio-folder" | "attachments" | "root";
export type NoteFolderMode = "root" | "attachments" | "custom";

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
  autoMediaTranscripts: false
};

const API_KEY_MASK = "••••••••••••";

interface TemplateSettingOptions {
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Transcription service").setHeading();
    this.renderApiKeySetting(new Setting(containerEl).setName("Groq API key"));
    new Setting(containerEl)
      .setName("Groq model")
      .setDesc("Turbo is the default for fastest transcription.")
      .addDropdown((dropdown) => {
        for (const model of GROQ_MODELS) dropdown.addOption(model.id, model.name);
        dropdown.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Recording").setHeading();
    new Setting(containerEl)
      .setName("Recording start delay")
      .setDesc("Milliseconds to wait after the microphone opens before capture begins.")
      .addSlider((slider) => slider.setLimits(0, 2000, 100).setValue(this.plugin.settings.startDelayMs).onChange(async (value) => {
        this.plugin.settings.startDelayMs = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Audio files").setHeading();
    new Setting(containerEl)
      .setName("Audio save location")
      .setDesc("Choose where recorded audio files are written.")
      .addDropdown((dropdown) => dropdown
        .addOption("audio-folder", "Separate audio folder")
        .addOption("attachments", "Obsidian attachments folder")
        .addOption("root", "Vault root")
        .setValue(this.plugin.settings.saveLocation)
        .onChange(async (value) => {
          this.plugin.settings.saveLocation = value as AudioSaveLocation;
          await this.plugin.saveSettings();
          this.display();
        }));
    if (this.plugin.settings.saveLocation === "audio-folder") {
      new Setting(containerEl).setName("Audio folder").setDesc("Used for recorded audio files.").addText((text) =>
        text.setValue(this.plugin.settings.audioFolder).onChange(async (value) => {
          this.plugin.settings.audioFolder = value;
          await this.plugin.saveSettings();
        }));
    }
    this.renderTemplateSetting(new Setting(containerEl).setName("Audio filename"), {
      desc: "Use date and time placeholders such as {{date}}, {{time}}, {{year}}, and {{second}}.",
      exampleExtension: ".m4a",
      fallback: DEFAULT_SETTINGS.audioNameTemplate,
      getValue: () => this.plugin.settings.audioNameTemplate,
      setValue: (value) => { this.plugin.settings.audioNameTemplate = value; }
    });

    new Setting(containerEl).setName("Transcription notes").setHeading();
    new Setting(containerEl)
      .setName("Note save location")
      .setDesc("Choose where transcription notes are created.")
      .addDropdown((dropdown) => dropdown
        .addOption("root", "Vault root")
        .addOption("attachments", "Obsidian attachments folder")
        .addOption("custom", "Separate folder")
        .setValue(this.plugin.settings.noteFolderMode)
        .onChange(async (value) => {
          this.plugin.settings.noteFolderMode = value as NoteFolderMode;
          await this.plugin.saveSettings();
          this.display();
        }));
    if (this.plugin.settings.noteFolderMode === "custom") {
      new Setting(containerEl).setName("Note folder").setDesc("Used for transcription notes.").addText((text) =>
        text.setPlaceholder("transcriptions").setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
          this.plugin.settings.noteFolder = value;
          await this.plugin.saveSettings();
        }));
    }
    this.renderTemplateSetting(new Setting(containerEl).setName("Transcription note filename"), {
      desc: "Uses the same filename placeholders as audio files.",
      exampleExtension: ".md",
      fallback: DEFAULT_SETTINGS.noteNameTemplate,
      getValue: () => this.plugin.settings.noteNameTemplate,
      setValue: (value) => { this.plugin.settings.noteNameTemplate = value; }
    });
    new Setting(containerEl)
      .setName("Use note template")
      .setDesc("When off, notes contain only transcript text and the embedded audio link.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useTemplate).onChange(async (value) => {
        this.plugin.settings.useTemplate = value;
        await this.plugin.saveSettings();
        this.display();
      }));
    if (this.plugin.settings.useTemplate) {
      new Setting(containerEl)
        .setName("Note template file")
        .setDesc("Vault path to a Markdown template. Supports transcript, audio, and date/time placeholders.")
        .addText((text) => text.setPlaceholder("Templates/Transcription.md").setValue(this.plugin.settings.noteTemplatePath).onChange(async (value) => {
          this.plugin.settings.noteTemplatePath = value.trim() ? normalizePath(value.trim()) : "";
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl).setName("Transcript processing").setHeading();
    this.renderToggle("Automatically transcribe pasted media links", "Add a citation-style transcript footnote when a supported media link is pasted.", "autoMediaTranscripts");
    this.renderToggle("Clean up transcript with AI", "Fix punctuation, remove filler words, and add paragraph breaks while retaining the original.", "cleanupTranscript");
    this.renderToggle("Timestamped segments", "Write timestamped segments linked to their position in the audio file.", "segmentedTranscript");
  }

  private renderToggle(name: string, desc: string, key: "autoMediaTranscripts" | "cleanupTranscript" | "segmentedTranscript"): void {
    new Setting(this.containerEl).setName(name).setDesc(desc).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveSettings();
      }));
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
      this.display();
    }));
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
