import { App, Notice, normalizePath } from "obsidian";
import { sanitizeFileName, sanitizeFolderPath } from "./templates";
import { DEFAULT_SETTINGS, FluxTtsSettings } from "./settings";

export function getAttachmentFolder(app: App): string {
  const configured = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.(
    "attachmentFolderPath"
  );
  if (typeof configured === "string" && configured.trim()) {
    return sanitizeFolderPath(configured);
  }
  return "";
}

export function resolveAudioPath(app: App, settings: FluxTtsSettings, fileName: string): string {
  const cleanFileName = sanitizeFileName(fileName);

  if (settings.saveLocation === "root") {
    return cleanFileName;
  }

  if (settings.saveLocation === "attachments") {
    const attachmentFolder = getAttachmentFolder(app);
    if (attachmentFolder) {
      return normalizePath(`${attachmentFolder}/${cleanFileName}`);
    }
    new Notice("No Obsidian attachment folder is configured; saving audio at vault root.");
    return cleanFileName;
  }

  const folder = sanitizeFolderPath(settings.audioFolder) || DEFAULT_SETTINGS.audioFolder;
  return normalizePath(`${folder}/${cleanFileName}`);
}

export function resolveNotePath(app: App, settings: FluxTtsSettings, fileName: string): string {
  const cleanFileName = sanitizeFileName(fileName);

  if (settings.noteFolderMode === "attachments") {
    const attachmentFolder = getAttachmentFolder(app);
    if (attachmentFolder) {
      return normalizePath(`${attachmentFolder}/${cleanFileName}`);
    }
    new Notice("No Obsidian attachment folder is configured; creating the note at vault root.");
    return cleanFileName;
  }

  if (settings.noteFolderMode === "custom") {
    const folder = sanitizeFolderPath(settings.noteFolder);
    if (folder) {
      return normalizePath(`${folder}/${cleanFileName}`);
    }
  }

  return cleanFileName;
}

export function resolveRecordingNotePath(app: App, settings: FluxTtsSettings): string {
  const fileName = "Recording....md";
  if (settings.recordingNoteFolderMode === "attachments") {
    const folder = getAttachmentFolder(app);
    if (folder) return normalizePath(`${folder}/${fileName}`);
    new Notice("No Obsidian attachment folder is configured; creating Recording... at the vault root.");
  }
  if (settings.recordingNoteFolderMode === "custom") {
    const folder = sanitizeFolderPath(settings.recordingNoteFolder);
    if (folder) return normalizePath(`${folder}/${fileName}`);
  }
  return fileName;
}

export async function ensureParentFolder(app: App, path: string): Promise<void> {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder) {
    await ensureFolder(app, folder);
  }
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (!normalized || app.vault.getAbstractFileByPath(normalized)) {
    return;
  }

  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

/**
 * Returns `path` if free, otherwise `base 2.ext`, `base 3.ext`, ...
 * The extension (".m4a", ".md", including the dot) is passed explicitly so
 * the split never depends on guessing where the extension starts.
 */
export async function uniquePath(app: App, path: string, extension: string): Promise<string> {
  const normalized = normalizePath(path);
  if (!app.vault.getAbstractFileByPath(normalized)) {
    return normalized;
  }

  const base =
    extension && normalized.toLowerCase().endsWith(extension.toLowerCase())
      ? normalized.slice(0, -extension.length)
      : normalized;
  const suffix = extension && normalized.toLowerCase().endsWith(extension.toLowerCase()) ? extension : "";

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}${suffix}`;
    if (!app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available filename for ${normalized}`);
}

export async function writeBinaryUnique(
  app: App,
  path: string,
  extension: string,
  buffer: ArrayBuffer
): Promise<string> {
  await ensureParentFolder(app, path);
  const target = await uniquePath(app, path, extension);
  await app.vault.createBinary(target, buffer);
  return target;
}

export async function createNoteUnique(app: App, path: string, content: string): Promise<string> {
  await ensureParentFolder(app, path);
  const target = await uniquePath(app, path, ".md");
  await app.vault.create(target, content);
  return target;
}
