import { App, PluginSettingTab, Setting, SettingDefinitionItem, normalizePath } from "obsidian";
import {
  FILENAME_TEMPLATE_KEYS,
  createTemplateContext,
  renderTemplate,
  sanitizeFileName,
  validateTemplate
} from "./templates";
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
  segmentedTranscript: false
};

const API_KEY_MASK = "••••••••••••";

/** Keys whose value change reveals or hides other definitions, so setControlValue must trigger a structural update(). */
const VISIBILITY_TRIGGER_KEYS = new Set(["saveLocation", "noteFolderMode", "useTemplate"]);

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

  getControlValue(key: string): unknown {
    switch (key) {
      case "model":
        return this.plugin.settings.model;
      case "saveLocation":
        return this.plugin.settings.saveLocation;
      case "audioFolder":
        return this.plugin.settings.audioFolder;
      case "noteFolderMode":
        return this.plugin.settings.noteFolderMode;
      case "noteFolder":
        return this.plugin.settings.noteFolder;
      case "useTemplate":
        return this.plugin.settings.useTemplate;
      case "noteTemplatePath":
        return this.plugin.settings.noteTemplatePath;
      case "startDelayMs":
        return this.plugin.settings.startDelayMs;
      case "cleanupTranscript":
        return this.plugin.settings.cleanupTranscript;
      case "segmentedTranscript":
        return this.plugin.settings.segmentedTranscript;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "model":
        settings.model = String(value);
        break;
      case "saveLocation":
        settings.saveLocation = value as AudioSaveLocation;
        break;
      case "audioFolder":
        settings.audioFolder = String(value);
        break;
      case "noteFolderMode":
        settings.noteFolderMode = value as NoteFolderMode;
        break;
      case "noteFolder":
        settings.noteFolder = String(value);
        break;
      case "useTemplate":
        settings.useTemplate = Boolean(value);
        break;
      case "noteTemplatePath": {
        const trimmed = String(value).trim();
        settings.noteTemplatePath = trimmed ? normalizePath(trimmed) : "";
        break;
      }
      case "startDelayMs":
        settings.startDelayMs = Number(value);
        break;
      case "cleanupTranscript":
        settings.cleanupTranscript = Boolean(value);
        break;
      case "segmentedTranscript":
        settings.segmentedTranscript = Boolean(value);
        break;
      default:
        return;
    }

    await this.plugin.saveSettings();
    if (VISIBILITY_TRIGGER_KEYS.has(key)) {
      this.update();
    }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Groq API key",
        desc: "Stored in Obsidian secret storage.",
        render: (setting) => this.renderApiKeySetting(setting)
      },
      {
        name: "Groq model",
        desc: "Turbo is the default for fastest transcription.",
        control: {
          type: "dropdown",
          key: "model",
          options: Object.fromEntries(GROQ_MODELS.map((model) => [model.id, model.name]))
        }
      },
      {
        type: "group",
        heading: "Recording",
        items: [
          {
            name: "Recording start delay",
            desc:
              "Milliseconds to wait after the microphone opens before capture begins. " +
              "Raise this if the first second of your recordings gets clipped on slower hardware.",
            control: {
              type: "slider",
              key: "startDelayMs",
              min: 0,
              max: 2000,
              step: 100
            }
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
            control: {
              type: "dropdown",
              key: "saveLocation",
              options: {
                "audio-folder": "Separate audio folder",
                attachments: "Obsidian attachments folder",
                root: "Vault root"
              }
            }
          },
          {
            name: "Audio folder",
            desc: "Used when save location is set to a separate audio folder.",
            visible: () => this.plugin.settings.saveLocation === "audio-folder",
            control: { type: "text", key: "audioFolder" }
          },
          {
            name: "Audio filename",
            desc: "Use {{date}}, {{time}}, {{datetime}}, {{year}}, {{month}}, {{day}}, {{hour}}, {{minute}}, and {{second}}.",
            render: (setting) =>
              this.renderTemplateSetting(setting, {
                name: "Audio filename",
                desc:
                  "Use {{date}}, {{time}}, {{datetime}}, {{year}}, {{month}}, {{day}}, {{hour}}, {{minute}}, and {{second}}.",
                exampleExtension: ".m4a",
                fallback: DEFAULT_SETTINGS.audioNameTemplate,
                getValue: () => this.plugin.settings.audioNameTemplate,
                setValue: (value) => {
                  this.plugin.settings.audioNameTemplate = value;
                }
              })
          }
        ]
      },
      {
        type: "group",
        heading: "Transcription notes",
        items: [
          {
            name: "Note save location",
            desc: "Choose where transcription notes are created.",
            control: {
              type: "dropdown",
              key: "noteFolderMode",
              options: {
                root: "Vault root",
                attachments: "Obsidian attachments folder",
                custom: "Separate folder"
              }
            }
          },
          {
            name: "Note folder",
            desc: "Used when note save location is set to a separate folder.",
            visible: () => this.plugin.settings.noteFolderMode === "custom",
            control: { type: "text", key: "noteFolder", placeholder: "transcriptions" }
          },
          {
            name: "Transcription note filename",
            desc: "Uses the same filename placeholders as audio files.",
            render: (setting) =>
              this.renderTemplateSetting(setting, {
                name: "Transcription note filename",
                desc: "Uses the same filename placeholders as audio files.",
                exampleExtension: ".md",
                fallback: DEFAULT_SETTINGS.noteNameTemplate,
                getValue: () => this.plugin.settings.noteNameTemplate,
                setValue: (value) => {
                  this.plugin.settings.noteNameTemplate = value;
                }
              })
          },
          {
            name: "Use note template",
            desc: "When off, notes contain only transcript text and the embedded audio link.",
            control: { type: "toggle", key: "useTemplate" }
          },
          {
            name: "Note template file",
            desc:
              "Vault path to a Markdown note used as the template, like Templates/Transcription.md. Supports " +
              "{{transcript}}, {{audioPath}}, {{audioEmbed}}, {{originalTranscript}}, and the date and time " +
              "placeholders.",
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
            name: "Clean up transcript with AI",
            desc:
              "Send the raw transcript to a Groq language model to fix punctuation, remove filler words, " +
              "and add paragraph breaks. The original transcript is kept too, under an \"Original transcript\" " +
              "heading in the note. Skipped when timestamped segments are enabled, so segment text stays " +
              "aligned with the audio.",
            control: { type: "toggle", key: "cleanupTranscript" }
          },
          {
            name: "Timestamped segments",
            desc: "Write the transcript as timestamped segments that link to their position in the audio file.",
            control: { type: "toggle", key: "segmentedTranscript" }
          }
        ]
      }
    ];
  }

  private renderApiKeySetting(setting: Setting): void {
    const hasApiKey = Boolean(this.plugin.getApiKey());
    setting
      .setName("Groq API key")
      .setDesc(hasApiKey ? "A key is saved in Obsidian secret storage." : "Stored in Obsidian secret storage.")
      .addText((text) => {
        text.setPlaceholder("gsk_...").setValue(hasApiKey ? API_KEY_MASK : "");
        text.inputEl.type = "password";
        text.inputEl.addEventListener("focus", () => {
          if (text.getValue() === API_KEY_MASK) {
            text.setValue("");
          }
        });
        text.inputEl.addEventListener("blur", () => {
          if (!text.getValue().trim() && this.plugin.getApiKey()) {
            text.setValue(API_KEY_MASK);
          }
        });
        text.onChange((value) => {
          const trimmed = value.trim();
          if (!trimmed || trimmed === API_KEY_MASK) {
            return;
          }
          this.plugin.setApiKey(trimmed);
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .setDisabled(!hasApiKey)
          .onClick(() => {
            this.plugin.setApiKey("");
            this.update();
          });
      });
  }

  private renderTemplateSetting(setting: Setting, options: TemplateSettingOptions): void {
    setting.setName(options.name).setDesc(options.desc);
    const previewEl = setting.descEl.createDiv({ cls: "flux-tts-template-preview" });

    const updatePreview = (template: string): boolean => {
      const validation = validateTemplate(template, FILENAME_TEMPLATE_KEYS);
      if (!validation.valid) {
        previewEl.setText(validation.error ?? "Invalid template.");
        previewEl.addClass("flux-tts-template-invalid");
        return false;
      }
      const rendered = sanitizeFileName(renderTemplate(template, createTemplateContext(new Date())));
      previewEl.setText(`Preview: ${rendered}${options.exampleExtension}`);
      previewEl.removeClass("flux-tts-template-invalid");
      return true;
    };

    setting.addText((text) => {
      text.setValue(options.getValue()).onChange(async (value) => {
        const template = value || options.fallback;
        if (!updatePreview(template)) {
          return;
        }
        options.setValue(template);
        await this.plugin.saveSettings();
      });
    });

    updatePreview(options.getValue());
  }
}
