import { normalizePath } from "obsidian";

export const FILENAME_TEMPLATE_KEYS = [
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "date",
  "time",
  "datetime"
];

export const NOTE_TEMPLATE_KEYS = [
  ...FILENAME_TEMPLATE_KEYS,
  "transcript",
  "audioPath",
  "audioEmbed",
  "originalTranscript"
];

export type TemplateContext = Record<string, string>;

export interface TemplateValidation {
  valid: boolean;
  error?: string;
}

export function createTemplateContext(date: Date): TemplateContext {
  const pad = (value: number) => String(value).padStart(2, "0");
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

export function renderTemplate(template: string, values: TemplateContext): string {
  return String(template).replace(/\{\{(.*?)\}\}/g, (_match, key) => {
    const normalizedKey = String(key).trim();
    return values[normalizedKey] ?? "";
  });
}

export function validateTemplate(template: string, allowedKeys: string[]): TemplateValidation {
  const unknownKeys: string[] = [];
  const withoutPlaceholders = String(template).replace(/\{\{(.*?)\}\}/g, (_match, key) => {
    const normalizedKey = String(key).trim();
    if (!allowedKeys.includes(normalizedKey)) {
      unknownKeys.push(normalizedKey);
    }
    return "";
  });

  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
    return { valid: false, error: "Unbalanced braces — every placeholder needs matching {{ and }}." };
  }

  if (unknownKeys.length) {
    const listed = unknownKeys.map((key) => `{{${key}}}`).join(", ");
    return { valid: false, error: `Unknown placeholder: ${listed}` };
  }

  return { valid: true };
}

export function sanitizeFileName(fileName: string): string {
  const cleaned = String(fileName)
    .replace(/[\\/:*?"<>|#^[\]{}]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Recording";
}

export function sanitizeFolderPath(folderPath: string): string {
  return normalizePath(
    String(folderPath || "")
      .split("/")
      .map((part) => sanitizeFileName(part))
      .filter(Boolean)
      .join("/")
  );
}
