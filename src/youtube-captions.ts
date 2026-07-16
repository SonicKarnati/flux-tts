import type { TranscriptionSegment } from "./transcription";

interface CaptionResponse {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
}

export function parseYouTubeCaptionResponse(text: string): TranscriptionSegment[] | null {
  if (!text.trim()) return null;
  let parsed: CaptionResponse;
  try {
    parsed = JSON.parse(text) as CaptionResponse;
  } catch {
    return null;
  }
  const segments = (parsed.events ?? [])
    .map((event) => ({
      start: (event.tStartMs ?? 0) / 1000,
      end: ((event.tStartMs ?? 0) + (event.dDurationMs ?? 0)) / 1000,
      text: (event.segs ?? []).map((segment) => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim()
    }))
    .filter((segment) => segment.text);
  return segments.length ? segments : null;
}
