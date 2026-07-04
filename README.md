# Flux TTS

Flux TTS is an Obsidian plugin that records audio from the ribbon, saves the recording to your vault, sends it to [Groq](https://groq.com) for speech-to-text transcription, and creates a note with the transcript and an audio embed.

## Features

- One-click recording from the ribbon, or via command palette commands (`Toggle recording`, `Start recording`, `Stop recording`).
- Groq Whisper transcription (`whisper-large-v3-turbo` for speed, `whisper-large-v3` for accuracy), switchable from settings or the `Cycle transcription model` command.
- **Timestamped segments** (optional): the transcript is written as segments, each linked to its position in the audio (`[[recording.m4a#t=72|1:12]]`), so you can jump straight to any part of the recording.
- **AI transcript cleanup** (optional): a Groq language model fixes punctuation, removes filler words, and adds paragraph breaks without changing the content. The original transcript is never discarded — it's kept in the note under an "Original transcript" heading.
- Note templates from a file in your vault, the same mental model as Obsidian's core Templates plugin.
- Live filename previews in settings, with validation that catches malformed `{{placeholders}}` before they ever reach a filename.
- Warns if your microphone goes silent or disconnects mid-recording, and automatically stops (with a Notice) after a full minute of continuous silence, so a muted or disconnected mic doesn't record dead air indefinitely. Also flags transcripts that look implausibly short for the recording length.
- Works on desktop and mobile (any Obsidian environment that supports `MediaRecorder`).

## Setup

1. Create an API key at [console.groq.com](https://console.groq.com/keys).
2. Open **Settings → Flux TTS** and paste the key. It is stored in Obsidian's secret storage, not in plain-text plugin data.
3. Click the microphone ribbon icon to start recording; click again to stop, and the transcription note opens automatically.

## Settings

- **Groq API key** — stored in Obsidian secret storage.
- **Groq model** — `whisper-large-v3-turbo` (fast, default) or `whisper-large-v3` (accurate).
- **Recording start delay** — wait 0–2000 ms after the microphone opens before capture begins. Raise this if the first second of recordings is clipped on slower hardware.
- **Audio save location** — a dedicated folder, the Obsidian attachments folder, or the vault root.
- **Audio filename / Transcription note filename** — templates using `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}`, `{{hour}}`, `{{minute}}`, `{{second}}`. Each field shows a live preview and warns on unbalanced or unknown placeholders.
- **Note save location** — vault root, the attachments folder, or a separate folder.
- **Use note template / Note template file** — point at a Markdown note in your vault (for example `Templates/Transcription.md`) containing `{{transcript}}`, `{{audioPath}}`, `{{audioEmbed}}`, `{{originalTranscript}}`, and any date/time placeholders.
- **Clean up transcript with AI** — post-process the transcript with `llama-3.3-70b-versatile` via the same Groq key. Falls back to the raw transcript if the call fails. Skipped when timestamped segments are enabled so segment text stays aligned with the audio. When it runs, the note shows the cleaned-up transcript up top and the untouched original underneath an `## Original transcript` heading — cleanup never destroys the source text.
- **Timestamped segments** — request per-segment timestamps from Groq and write the transcript as linked segments.

## Privacy

Audio is saved locally in your vault. Transcription sends the recorded audio to Groq using your API key; if AI cleanup is enabled, the transcript text is also sent to Groq. No other services are used, and nothing is sent anywhere until you record something.

**This plugin requires a free [Groq](https://console.groq.com/keys) account and API key.** Groq's speech-to-text API is the only way this plugin performs transcription, so the plugin has no functionality without one.

## Development

Source lives in `src/` (TypeScript) and is bundled to `main.js` with esbuild.

```bash
npm install
npm run dev    # watch mode, rebuilds main.js on change
npm run build  # type-check + production build
```

To test locally, copy (or symlink) this folder into `<vault>/.obsidian/plugins/flux-tts/` and enable it in **Settings → Community plugins**. The distributable files are `manifest.json`, `main.js`, `styles.css`, and `versions.json`.

Releases are built by GitHub Actions: pushing a tag that matches the `version` in `manifest.json` creates a draft GitHub release with the distributable files attached.

## License

MIT
