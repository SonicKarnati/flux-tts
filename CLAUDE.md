# Flux TTS — CLAUDE.md

## Build & dev

```sh
npm install
npm run dev    # esbuild watch mode
npm run build  # tsc type-check + production build
```

## Release process

1. Bump version in `package.json`
2. Run `npm run version` — updates `manifest.json` & `versions.json`
3. Commit: `git add -A && git commit -m "Bump version to x.y.z"`
4. Annotated tag with release notes: `git tag -a x.y.z -m "summary of changes"`
5. Push: `git push origin main --follow-tags`
6. GitHub Actions builds, attests provenance, and creates a **draft** release
7. Publish the draft on GitHub

`manifest.json` version must match the tag — the workflow validates this.

## Project structure

| Path | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point. Extends `Plugin`, registers ribbon/commands/settings. Orchestrates record → transcribe → save flow. |
| `src/settings.ts` | Types, defaults, declarative settings tab UI with switch-based getter/setter. |
| `src/recording.ts` | `RecorderController` — `MediaRecorder` lifecycle, MIME negotiation, silence detection, device-change monitor. |
| `src/transcription.ts` | Groq API client (Whisper + Llama cleanup). Multipart form-data builder, segmented transcript rendering. |
| `src/templates.ts` | `{{placeholder}}` template engine, validation, filename/folder sanitization. |
| `src/paths.ts` | Audio/note path resolution, folder creation, deduplication. |
| `src/waveform.ts` | Canvas-based live waveform via `AnalyserNode` + `requestAnimationFrame`. |

## Code conventions

- **Obsidian imports**: granular named imports only (`Plugin`, `Notice`, `requestUrl`, etc.)
- **Error handling**: `try/catch` → `console.error(error)` + `new Notice(userMsg)`; `getErrorMessage()` helper for unknown error shapes
- **Async**: `async/await`. Fire-and-forget with `void` prefix in sync callbacks. `.catch()` for top-level handlers
- **Internal API**: cast through `(app as unknown as { ... })` with narrow guard interfaces; degrade gracefully if shape changes
- **Platform**: `Platform.isMobile` for waveform placement (status bar vs floating pill)
- **Settings API key**: stored in Obsidian's secret storage (`app.secretStorage`), not in `data.json`
- **No barrel/index re-exports**; one class or function group per file
- **Settings UI**: declarative `SettingDefinitionItem[]` with switch-based getter/setter that auto-re-renders on visibility-trigger keys
- **Templates**: custom `{{placeholder}}` regex engine; `validateTemplate` checks unknown keys and unbalanced braces
- **No third-party runtime deps** — only devDeps (`esbuild`, `typescript`, `obsidian`, `@types/node`)
- **Files**: `kebab-case.ts`, PascalCase classes/interfaces, camelCase functions/variables

## Key patterns

- **Plugin lifecycle**: `onload()` is async, sets up everything; `onunload()` tears down recorder, waveform, floating DOM
- **Inline transcription**: `InlineSession` tracks editor + unique placeholder `<transcribing... flux-XXXX>` + footnote id
- **Declarative settings**: `getSettingDefinitions()` returns array of typed controls with `visible` predicates for conditional rendering
