import type { RecorderState } from "./recording";

export interface RetryBlockData {
  audioPath: string;
  fileName: string;
  message: string;
}

export function recordingAction(state: RecorderState): { label: string; active: boolean; icon: string } {
  if (state === "paused" || state === "error") {
    return { label: "Resume transcription", active: false, icon: "play" };
  }
  if (state === "starting" || state === "recording" || state === "recovering") {
    return { label: "Stop transcription", active: true, icon: "square" };
  }
  return { label: "Start transcription", active: false, icon: "mic" };
}

export function createRetryBlock(data: RetryBlockData): string {
  return `\`\`\`flux-tts-retry\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseRetryBlock(source: string): RetryBlockData {
  const parsed = JSON.parse(source) as Partial<RetryBlockData>;
  if (typeof parsed.audioPath !== "string" || !parsed.audioPath) throw new Error("Missing audio path.");
  if (typeof parsed.fileName !== "string" || !parsed.fileName) throw new Error("Missing audio filename.");
  return {
    audioPath: parsed.audioPath,
    fileName: parsed.fileName,
    message: typeof parsed.message === "string" && parsed.message ? parsed.message : "Transcription failed."
  };
}

export interface FoundRetryBlock {
  block: string;
  source: string;
  data: RetryBlockData;
}

export function findRetryBlock(content: string): FoundRetryBlock | null {
  const match = /```flux-tts-retry\n([\s\S]*?)\n```/.exec(content);
  if (!match) return null;
  try {
    return { block: match[0], source: match[1], data: parseRetryBlock(match[1]) };
  } catch {
    return null;
  }
}
