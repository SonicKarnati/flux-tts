const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl
} = require("obsidian");

const PLUGIN_ID = "flux-tts";
const SECRET_KEY = `${PLUGIN_ID}-groq-api-key`;
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const GROQ_MODELS = [
  { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo (fast)" },
  { id: "whisper-large-v3", name: "Whisper Large v3 (accurate)" }
];

const DEFAULT_SETTINGS = {
  model: "whisper-large-v3-turbo",
  saveLocation: "audio-folder",
  audioFolder: "audio recordings",
  noteFolder: "",
  audioNameTemplate: "{{date}} {{time}}",
  noteNameTemplate: "Transcription_{{date}} {{time}}",
  useTemplate: false,
  noteTemplate: "{{transcript}}\n\n![[{{audioPath}}]]"
};

const MIME_CANDIDATES = [
  { mime: "audio/mp4", extension: "m4a" },
  { mime: "audio/aac", extension: "aac" },
  { mime: "audio/webm;codecs=opus", extension: "webm" },
  { mime: "audio/webm", extension: "webm" },
  { mime: "audio/ogg;codecs=opus", extension: "ogg" },
  { mime: "audio/ogg", extension: "ogg" }
];

module.exports = class FluxTtsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.chunks = [];
    this.selectedMime = null;

    this.ribbonIconEl = this.addRibbonIcon("mic", "Start transcription", () => {
      this.toggleRecording();
    });

    this.addCommand({
      id: "toggle-recording",
      name: "Toggle recording",
      callback: () => this.toggleRecording()
    });

    this.addSettingTab(new FluxTtsSettingTab(this.app, this));
    this.updateRibbonState(false);
  }

  onunload() {
    this.stopTracks();
    this.mediaRecorder = null;
    this.chunks = [];
  }

  async loadSettings() {
    const savedSettings = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.validateSettings();
  }

  async saveSettings() {
    this.validateSettings();
    await this.saveData(this.settings);
  }

  validateSettings() {
    if (!GROQ_MODELS.some((model) => model.id === this.settings.model)) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    if (!["audio-folder", "attachments", "root"].includes(this.settings.saveLocation)) {
      this.settings.saveLocation = DEFAULT_SETTINGS.saveLocation;
    }

    for (const key of ["audioFolder", "noteFolder", "audioNameTemplate", "noteNameTemplate", "noteTemplate"]) {
      if (typeof this.settings[key] !== "string") {
        this.settings[key] = DEFAULT_SETTINGS[key];
      }
    }

    this.settings.useTemplate = Boolean(this.settings.useTemplate);
  }

  async toggleRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.stopRecording();
      return;
    }

    await this.startRecording();
  }

  async startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      new Notice("Audio recording is not available in this Obsidian environment.");
      return;
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      new Notice("Add your Groq API key in Flux TTS settings first.");
      return;
    }

    try {
      this.selectedMime = this.pickMimeType();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = this.selectedMime ? { mimeType: this.selectedMime.mime } : undefined;
      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
      this.chunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.finishRecording().catch((error) => {
          console.error(error);
          new Notice(`Recording failed: ${error.message || error}`);
        });
      };

      this.mediaRecorder.start();
      this.updateRibbonState(true);
      new Notice("Recording started.");
    } catch (error) {
      this.stopTracks();
      this.mediaRecorder = null;
      this.updateRibbonState(false);
      console.error(error);
      new Notice(`Could not start recording: ${error.message || error}`);
    }
  }

  stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== "recording") {
      return;
    }

    this.mediaRecorder.stop();
    this.updateRibbonState(false);
    new Notice("Saving and transcribing...");
  }

  async finishRecording() {
    const chunks = this.chunks;
    const selectedMime = this.selectedMime;

    this.stopTracks();
    this.mediaRecorder = null;
    this.chunks = [];
    this.selectedMime = null;

    if (!chunks.length) {
      new Notice("No audio was captured.");
      return;
    }

    const context = createTemplateContext(new Date());
    const mimeType = selectedMime?.mime || chunks[0]?.type || "audio/webm";
    const extension = selectedMime?.extension || extensionFromMime(mimeType);
    const audioFileName = `${renderTemplate(this.settings.audioNameTemplate, context)}.${extension}`;
    const noteFileName = `${renderTemplate(this.settings.noteNameTemplate, context)}.md`;
    const audioPath = await this.resolveAudioPath(audioFileName);
    const notePath = this.resolveNotePath(noteFileName);
    const audioBlob = new Blob(chunks, { type: mimeType });
    const audioBuffer = await audioBlob.arrayBuffer();

    await this.ensureParentFolder(audioPath);
    const savedAudioPath = await this.writeBinaryUnique(audioPath, audioBuffer);

    let transcript;
    try {
      transcript = await this.transcribeAudio(audioBlob, audioFileName);
    } catch (error) {
      console.error(error);
      transcript = `Transcription failed: ${error.message || error}`;
      new Notice("Audio saved, but transcription failed.");
    }

    const noteBody = this.renderNote(transcript, savedAudioPath, context);
    const createdNote = await this.createNoteUnique(notePath, noteBody);
    const file = this.app.vault.getAbstractFileByPath(createdNote);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }

    new Notice("Transcription saved.");
  }

  async transcribeAudio(audioBlob, fileName) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Missing Groq API key.");
    }

    const boundary = `----flux-tts-${Date.now().toString(36)}`;
    const body = await buildMultipartBody(boundary, [
      { name: "model", value: this.settings.model },
      { name: "response_format", value: "text" },
      {
        name: "file",
        fileName,
        contentType: audioBlob.type || "application/octet-stream",
        value: await audioBlob.arrayBuffer()
      }
    ]);

    const response = await requestUrl({
      url: GROQ_TRANSCRIPTION_URL,
      method: "POST",
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Groq returned HTTP ${response.status}: ${response.text}`);
    }

    return response.text;
  }

  renderNote(transcript, audioPath, context) {
    const values = Object.assign({}, context, {
      transcript: transcript.trim(),
      audioPath,
      audioEmbed: `![[${audioPath}]]`
    });

    if (this.settings.useTemplate) {
      return renderTemplate(this.settings.noteTemplate, values).trim();
    }

    return `${values.transcript}\n\n${values.audioEmbed}`;
  }

  async resolveAudioPath(fileName) {
    const cleanFileName = sanitizeFileName(fileName);

    if (this.settings.saveLocation === "root") {
      return cleanFileName;
    }

    if (this.settings.saveLocation === "attachments") {
      const attachmentFolder = this.getAttachmentFolder();
      if (attachmentFolder) {
        return normalizePath(`${attachmentFolder}/${cleanFileName}`);
      }
      new Notice("No Obsidian attachment folder is configured; saving audio at vault root.");
      return cleanFileName;
    }

    const folder = sanitizeFolderPath(this.settings.audioFolder) || DEFAULT_SETTINGS.audioFolder;
    return normalizePath(`${folder}/${cleanFileName}`);
  }

  resolveNotePath(fileName) {
    const cleanFileName = sanitizeFileName(fileName);
    const folder = sanitizeFolderPath(this.settings.noteFolder);
    return folder ? normalizePath(`${folder}/${cleanFileName}`) : cleanFileName;
  }

  getAttachmentFolder() {
    const configured = this.app.vault.getConfig?.("attachmentFolderPath");
    if (typeof configured === "string" && configured.trim()) {
      return sanitizeFolderPath(configured);
    }
    return "";
  }

  pickMimeType() {
    for (const candidate of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(candidate.mime)) {
        return candidate;
      }
    }
    return null;
  }

  async ensureParentFolder(path) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder) {
      await this.ensureFolder(folder);
    }
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path);
    if (!normalized || this.app.vault.getAbstractFileByPath(normalized)) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async writeBinaryUnique(path, buffer) {
    const uniquePath = await this.uniquePath(path);
    await this.app.vault.adapter.writeBinary(uniquePath, buffer);
    return uniquePath;
  }

  async createNoteUnique(path, content) {
    await this.ensureParentFolder(path);
    const uniquePath = await this.uniquePath(path);
    await this.app.vault.create(uniquePath, content);
    return uniquePath;
  }

  async uniquePath(path) {
    const normalized = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      return normalized;
    }

    const dotIndex = normalized.lastIndexOf(".");
    const base = dotIndex === -1 ? normalized : normalized.slice(0, dotIndex);
    const extension = dotIndex === -1 ? "" : normalized.slice(dotIndex);

    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base} ${index}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }

    throw new Error(`Could not find an available filename for ${normalized}`);
  }

  stopTracks() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  updateRibbonState(isRecording) {
    if (!this.ribbonIconEl) {
      return;
    }

    this.ribbonIconEl.toggleClass("is-active", isRecording);
    this.ribbonIconEl.setAttr("aria-label", isRecording ? "Stop transcription" : "Start transcription");
    this.ribbonIconEl.setAttr("aria-pressed", String(isRecording));
  }

  getApiKey() {
    if (!this.app.secretStorage) {
      return "";
    }
    return this.app.secretStorage.getSecret(SECRET_KEY) || "";
  }

  setApiKey(value) {
    if (!this.app.secretStorage) {
      throw new Error("Obsidian secret storage is not available.");
    }

    this.app.secretStorage.setSecret(SECRET_KEY, value.trim());
  }
};

class FluxTtsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const hasApiKey = Boolean(this.plugin.getApiKey());
    containerEl.empty();

    new Setting(containerEl)
      .setName("Groq API key")
      .setDesc(hasApiKey ? "A key is saved in Obsidian secret storage." : "Stored in Obsidian secret storage.")
      .addText((text) => {
        text
          .setPlaceholder(hasApiKey ? "Saved" : "gsk_...")
          .setValue("")
          .onChange((value) => {
            this.plugin.setApiKey(value);
          });
        text.inputEl.type = "password";
      })
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .setDisabled(!hasApiKey)
          .onClick(() => {
            this.plugin.setApiKey("");
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Groq model")
      .setDesc("Turbo is the default for fastest transcription.")
      .addDropdown((dropdown) => {
        GROQ_MODELS.forEach((model) => dropdown.addOption(model.id, model.name));
        dropdown.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Audio save location")
      .setDesc("Choose where recorded audio files are written.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("audio-folder", "Separate audio folder")
          .addOption("attachments", "Obsidian attachments folder")
          .addOption("root", "Vault root")
          .setValue(this.plugin.settings.saveLocation)
          .onChange(async (value) => {
            this.plugin.settings.saveLocation = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.saveLocation === "audio-folder") {
      new Setting(containerEl)
        .setName("Audio folder")
        .setDesc("Used when save location is set to a separate audio folder.")
        .addText((text) => {
          text.setValue(this.plugin.settings.audioFolder).onChange(async (value) => {
            this.plugin.settings.audioFolder = value;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Audio filename")
      .setDesc("Use {{date}}, {{time}}, {{datetime}}, {{year}}, {{month}}, {{day}}, {{hour}}, {{minute}}, and {{second}}.")
      .addText((text) => {
        text.setValue(this.plugin.settings.audioNameTemplate).onChange(async (value) => {
          this.plugin.settings.audioNameTemplate = value || DEFAULT_SETTINGS.audioNameTemplate;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Transcription note folder")
      .setDesc("Leave empty to create transcription notes at the vault root.")
      .addText((text) => {
        text.setPlaceholder("Optional folder").setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
          this.plugin.settings.noteFolder = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Transcription note filename")
      .setDesc("Uses the same filename placeholders as audio files.")
      .addText((text) => {
        text.setValue(this.plugin.settings.noteNameTemplate).onChange(async (value) => {
          this.plugin.settings.noteNameTemplate = value || DEFAULT_SETTINGS.noteNameTemplate;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Use note template")
      .setDesc("When off, notes contain only transcript text and the embedded audio link.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.useTemplate).onChange(async (value) => {
          this.plugin.settings.useTemplate = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.useTemplate) {
      new Setting(containerEl)
        .setName("Note template")
        .setDesc("Available placeholders: {{transcript}}, {{audioPath}}, {{audioEmbed}}, date/time placeholders.")
        .addTextArea((text) => {
          text.inputEl.rows = 8;
          text.inputEl.cols = 40;
          text.setValue(this.plugin.settings.noteTemplate).onChange(async (value) => {
            this.plugin.settings.noteTemplate = value || DEFAULT_SETTINGS.noteTemplate;
            await this.plugin.saveSettings();
          });
        });
    }
  }
}

function createTemplateContext(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const dateValue = `${year}-${month}-${day}`;
  const timeValue = `${hour}-${minute}-${second}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: dateValue,
    time: timeValue,
    datetime: `${dateValue} ${timeValue}`
  };
}

function renderTemplate(template, values) {
  return String(template).replace(/\{\{(.*?)\}\}/g, (_match, key) => {
    const normalizedKey = String(key).trim();
    return values[normalizedKey] ?? "";
  });
}

function sanitizeFileName(fileName) {
  const cleaned = String(fileName)
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || DEFAULT_SETTINGS.audioNameTemplate;
}

function sanitizeFolderPath(folderPath) {
  return normalizePath(
    String(folderPath || "")
      .split("/")
      .map((part) => sanitizeFileName(part))
      .filter(Boolean)
      .join("/")
  );
}

function extensionFromMime(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  return "audio";
}

async function buildMultipartBody(boundary, parts) {
  const encoder = new TextEncoder();
  const buffers = [];

  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.fileName) {
      header += `; filename="${part.fileName}"`;
    }
    header += "\r\n";
    if (part.contentType) {
      header += `Content-Type: ${part.contentType}\r\n`;
    }
    header += "\r\n";

    buffers.push(encoder.encode(header).buffer);
    buffers.push(part.value instanceof ArrayBuffer ? part.value : encoder.encode(String(part.value)).buffer);
    buffers.push(encoder.encode("\r\n").buffer);
  }

  buffers.push(encoder.encode(`--${boundary}--\r\n`).buffer);
  return concatArrayBuffers(buffers);
}

function concatArrayBuffers(buffers) {
  const totalLength = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return output.buffer;
}
