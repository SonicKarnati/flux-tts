# Roadmap

Where Flux TTS is headed. This is a living document — items may move, merge, or
change shape. Feedback and issues are welcome.

## In progress

### Live recording waveform

Today there's no visual confirmation that audio is actually being captured while
you record — just the ribbon icon's active state. The goal is a live waveform /
input-level display so you can see, at a glance, that your voice is coming
through (and spot a dead or muted mic before you've spoken for ten minutes).

- **Desktop:** render it in the status bar.
- **Mobile:** Obsidian mobile has no status bar, so presentation is still being
  worked out — the current direction is a small floating indicator shown only
  while recording. Open to better ideas here.

The plumbing is already favorable: an audio `AnalyserNode` runs for the whole
recording (it powers silence detection), so the waveform reads from existing
signal rather than opening a second capture path.

### Inline transcription at the cursor

Instead of always creating a new note, let you transcribe **into the note you're
already writing**. Place the cursor where you want the text, start transcription,
speak, stop — and the transcript drops in at the cursor.

At the end of the inserted passage, a Wikipedia-style superscript reference links
back to the source recording (rendered via a Markdown footnote, e.g. the audio
file the text was transcribed from), so you can always jump back to the original
audio for anything you dictated inline.

## Later / ideas

- Smarter mobile presentation for the waveform / recording indicator.
- Optional per-segment inline references (link chunks of dictated text to their
  moment in the audio, the way timestamped notes already do).
- Configurable footnote/reference style for inline transcription.

---

*See the [README](README.md) for current features and setup.*
