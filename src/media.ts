import { requestUrl } from "obsidian";
import { TranscriptionResult, transcribeAudio } from "./transcription";
import { parseYouTubeCaptionResponse } from "./youtube-captions";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface CaptionTrack {
  baseUrl?: string;
  name?: { simpleText?: string };
}

export interface MediaTranscriptResult extends TranscriptionResult {
  title: string;
  sourceUrl: string;
}

export function extractMediaUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>]+/g) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.;!?]+$/, "");
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol)) return url.href;
    } catch {
      // Ignore malformed pasted URLs.
    }
  }
  return null;
}

export async function fetchMediaTranscript(options: {
  url: string;
  apiKey: string;
  model: string;
  wantSegments: boolean;
}): Promise<MediaTranscriptResult> {
  const youtubeId = getYouTubeId(options.url);
  if (youtubeId) {
    const captions = await fetchYouTubeCaptions(options.url);
    if (captions) return captions;
  }

  const media = await resolveMediaAsset(options.url);
  if (!options.apiKey) {
    throw new Error("This link has no accessible captions. Add a Groq API key to transcribe its media.");
  }
  if (media.data.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("The linked media is larger than the 25 MB transcription limit.");
  }

  const transcription = await transcribeAudio({
    apiKey: options.apiKey,
    model: options.model,
    blob: new Blob([media.data], { type: media.contentType }),
    fileName: media.fileName,
    wantSegments: options.wantSegments
  });
  return { ...transcription, title: media.title, sourceUrl: options.url };
}

async function fetchYouTubeCaptions(url: string): Promise<MediaTranscriptResult | null> {
  const page = await requestUrl({ url, throw: false });
  if (page.status < 200 || page.status >= 300) throw new Error(`YouTube returned HTTP ${page.status}.`);

  const tracksMatch = page.text.match(/"captionTracks":(\[.*?\]),"audioTracks"/s);
  if (!tracksMatch) return null;
  let tracks: CaptionTrack[];
  try {
    tracks = JSON.parse(tracksMatch[1]) as CaptionTrack[];
  } catch {
    return null;
  }
  const track = tracks.find((item) => item.baseUrl);
  if (!track?.baseUrl) return null;

  const captionResponse = await requestUrl({ url: `${track.baseUrl}&fmt=json3`, throw: false });
  if (captionResponse.status < 200 || captionResponse.status >= 300) return null;
  const segments = parseYouTubeCaptionResponse(captionResponse.text);
  if (!segments) return null;

  const titleMatch = page.text.match(/<title>(.*?)<\/title>/is);
  const title = decodeHtml(titleMatch?.[1]?.replace(/\s*-\s*YouTube\s*$/, "").trim() || "YouTube video");
  return { title, sourceUrl: url, text: segments.map((segment) => segment.text).join(" "), segments };
}

async function resolveMediaAsset(url: string): Promise<{
  data: ArrayBuffer;
  contentType: string;
  fileName: string;
  title: string;
}> {
  const first = await requestUrl({ url, throw: false });
  if (first.status < 200 || first.status >= 300) throw new Error(`Media link returned HTTP ${first.status}.`);
  const contentType = first.headers["content-type"]?.split(";")[0] ?? "";
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
    return mediaResponse(url, first.arrayBuffer, contentType, "Linked media");
  }

  const mediaUrl = findMetaContent(first.text, "og:video") || findMetaContent(first.text, "og:audio");
  if (!mediaUrl) throw new Error("No public captions or downloadable audio/video were found at this link.");
  const second = await requestUrl({ url: new URL(mediaUrl, url).href, throw: false });
  if (second.status < 200 || second.status >= 300) throw new Error(`Linked media returned HTTP ${second.status}.`);
  const mediaType = second.headers["content-type"]?.split(";")[0] || "application/octet-stream";
  return mediaResponse(mediaUrl, second.arrayBuffer, mediaType, decodeHtml(findMetaContent(first.text, "og:title") || "Linked media"));
}

function mediaResponse(url: string, data: ArrayBuffer, contentType: string, title: string) {
  const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "media";
  let fileName = `media.${extension}`;
  try {
    fileName = new URL(url).pathname.split("/").pop() || fileName;
  } catch {
    // Keep the generated filename.
  }
  return { data, contentType, fileName, title };
}

function getYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (parsed.hostname.endsWith("youtube.com")) {
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
      const match = parsed.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/);
      return match?.[1] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function findMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"));
  const reverse = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
  return decodeHtml(forward?.[1] || reverse?.[1] || "") || null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
