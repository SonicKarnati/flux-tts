import { requestUrl } from "obsidian";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const CLEANUP_MODEL = "llama-3.3-70b-versatile";

const CLEANUP_SYSTEM_PROMPT =
  "You clean up raw speech-to-text transcripts. Fix punctuation and capitalization, remove filler words " +
  "(um, uh, you know, like when used as filler), and break the text into readable paragraphs. Do not " +
  "summarize, rephrase, add, or remove any substantive content. Return only the cleaned transcript with " +
  "no preamble or commentary.";

/** Words per minute used to estimate how long a transcript "should" take to speak. */
const SPEECH_WORDS_PER_MINUTE = 150;
/** Recordings shorter than this are never flagged for a short transcript. */
const LENGTH_CHECK_MIN_SECONDS = 15;
/** Flag when the transcript covers less than this fraction of the recording time. */
const LENGTH_CHECK_MIN_RATIO = 0.3;

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
}

export async function transcribeAudio(options: {
  apiKey: string;
  model: string;
  blob: Blob;
  fileName: string;
  wantSegments: boolean;
}): Promise<TranscriptionResult> {
  const boundary = `----flux-tts-${Date.now().toString(36)}`;
  const body = await buildMultipartBody(boundary, [
    { name: "model", value: options.model },
    { name: "response_format", value: options.wantSegments ? "verbose_json" : "text" },
    {
      name: "file",
      fileName: options.fileName,
      contentType: options.blob.type || "application/octet-stream",
      value: await options.blob.arrayBuffer()
    }
  ]);

  const response = await requestUrl({
    url: GROQ_TRANSCRIPTION_URL,
    method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    headers: {
      Authorization: `Bearer ${options.apiKey}`
    },
    body,
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Groq returned HTTP ${response.status}: ${response.text}`);
  }

  if (!options.wantSegments) {
    return { text: response.text, segments: [] };
  }

  const parsed = JSON.parse(response.text) as {
    text?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };

  return {
    text: String(parsed.text ?? ""),
    segments: (parsed.segments ?? []).map((segment) => ({
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
      text: String(segment.text ?? "")
    }))
  };
}

export async function cleanupTranscript(apiKey: string, transcript: string): Promise<string> {
  const response = await requestUrl({
    url: GROQ_CHAT_URL,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: CLEANUP_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: CLEANUP_SYSTEM_PROMPT },
        { role: "user", content: transcript }
      ]
    }),
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Groq returned HTTP ${response.status}: ${response.text}`);
  }

  const parsed = response.json as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Transcript cleanup returned no content.");
  }

  return content.trim();
}

export function renderSegmentedTranscript(segments: TranscriptionSegment[], audioPath: string): string {
  return segments
    .map((segment) => {
      const seconds = Math.max(0, Math.floor(segment.start));
      const label = formatTimestamp(segment.start);
      return `[[${audioPath}#t=${seconds}|${label}]] ${segment.text.trim()}`;
    })
    .join("\n\n");
}

/**
 * Returns a callout to append to the note when the transcript looks
 * implausibly short for the recording length, or null when it looks fine.
 */
export function transcriptLengthWarning(transcript: string, durationSeconds: number): string | null {
  if (durationSeconds < LENGTH_CHECK_MIN_SECONDS) {
    return null;
  }

  const wordCount = transcript.split(/\s+/).filter(Boolean).length;
  const expectedSeconds = (wordCount / SPEECH_WORDS_PER_MINUTE) * 60;
  if (expectedSeconds >= durationSeconds * LENGTH_CHECK_MIN_RATIO) {
    return null;
  }

  const duration = formatTimestamp(durationSeconds);
  return `\n\n> [!warning] This transcript seems short for a ${duration} recording — worth checking the audio.`;
}

export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

interface MultipartPart {
  name: string;
  value: string | ArrayBuffer;
  fileName?: string;
  contentType?: string;
}

async function buildMultipartBody(boundary: string, parts: MultipartPart[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const buffers: ArrayBuffer[] = [];

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

    buffers.push(encoder.encode(header).buffer as ArrayBuffer);
    buffers.push(
      part.value instanceof ArrayBuffer ? part.value : (encoder.encode(String(part.value)).buffer as ArrayBuffer)
    );
    buffers.push(encoder.encode("\r\n").buffer as ArrayBuffer);
  }

  buffers.push(encoder.encode(`--${boundary}--\r\n`).buffer as ArrayBuffer);
  return concatArrayBuffers(buffers);
}

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return output.buffer;
}
