# Flux TTS

Flux TTS is an Obsidian plugin that records audio from the ribbon, saves the recording to your vault, sends it to Groq for transcription, and creates a note with the transcript and audio embed.

## Features

- Ribbon button toggles between "Start transcription" and "Stop transcription".
- Works with Obsidian desktop and mobile environments that support `MediaRecorder`.
- Uses Groq speech-to-text models only.
- Stores the Groq API key in Obsidian secret storage.
- Lets you choose the Groq transcription model, filename templates, note templates, and audio save location.

## Settings

- **Groq API key**: Stored with Obsidian secret storage.
- **Groq model**: Choose `whisper-large-v3-turbo` for speed or `whisper-large-v3` for accuracy.
- **Audio save location**: Save to a dedicated folder, the Obsidian attachments folder, or the vault root.
- **Filename templates**: Use placeholders like `{{date}}`, `{{time}}`, and `{{datetime}}`.
- **Note template**: Optional template with `{{transcript}}`, `{{audioPath}}`, and `{{audioEmbed}}`.

## Privacy

Audio is saved locally in your vault. Transcription sends the recorded audio to Groq using your API key. No other services are used.

## Development

This plugin is intentionally dependency-free for fast local iteration. The distributable plugin files are:

- `manifest.json`
- `main.js`
- `versions.json`
