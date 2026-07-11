# Flux TTS

An Obsidian plugin that records audio from the ribbon, saves it to your vault, transcribes it with [Groq](https://groq.com) Whisper, and creates a note with the transcript and an audio embed.

## Features

- One-click recording from the ribbon, or command-palette commands (toggle/start/stop).
- Groq Whisper transcription — `whisper-large-v3-turbo` (fast) or `whisper-large-v3` (accurate), switchable in settings.
- **Inline transcription** — transcribe straight into the note at your cursor, with a footnote linking back to the recording.
- **Timestamped segments** (optional) — each line links to its moment in the audio.
- **AI cleanup** (optional) — a Groq LLM fixes punctuation and removes filler words; the original transcript is kept, never discarded.
- **Live waveform** while recording, so you can see your mic is working.
- **Media-link transcripts** (opt in) — paste a YouTube or public media link to add its transcript as a citation-style footnote.
- Note templates from a vault file, live filename previews, and validation that catches malformed `{{placeholders}}`.
- Warns and auto-stops on a silent or disconnected mic. Works on desktop and mobile.

## Setup

1. Create a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open **Settings → Flux TTS** and paste the key (stored in Obsidian's secret storage, not plain text).
3. Click the microphone ribbon icon to start; click again to stop. The note opens automatically.

The Settings tab covers the model, recording start delay, audio/note save locations, filename and note templates, AI cleanup, and timestamped segments — each with inline help.

## Compatibility

Requires **Obsidian 1.12.0+**. The settings screen uses the stable imperative settings API available in Obsidian 1.12.

## Privacy

Audio is saved locally. Transcription (and AI cleanup, if enabled) sends data to Groq using your API key. When media-link transcripts are enabled, pasted links are fetched to locate captions or public media; media without captions is sent to Groq for transcription. Nothing is sent until you record or enable and use media-link transcripts.

## Roadmap & development

See [ROADMAP.md](ROADMAP.md) for what's next. Source is TypeScript in `src/`, bundled to `main.js` with esbuild:

```bash
npm install
npm run dev    # watch mode
npm run build  # type-check + production build
```

Releases are built by GitHub Actions: pushing a tag matching the `manifest.json` version attaches `main.js`, `manifest.json`, and `styles.css` to a release.

## License

MIT
