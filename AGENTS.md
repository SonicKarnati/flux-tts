# Flux TTS — AGENTS.md

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

## Feature completion and review workflow

Use this end-to-end workflow for every feature. A feature is not complete until
its implementation, tests, release, and release-review submission are complete.

1. Read the request carefully, inspect the relevant code, and define the
   expected behavior and edge cases before editing.
2. Write or update tests that demonstrate completion of the requested feature.
   The tests must cover the intended behavior and relevant failure/edge cases.
3. Implement the feature using the project conventions and applicable best
   practices. Continue iterating until all feature tests and required project
   checks pass, including `npm run build`.
4. Review the final diff and test results. Commit the completed feature to the
   repository; do not require a pull request or self-approval for this workflow.
5. Create a release for each completed feature. Always increment only the patch
   version (for example, `0.3.3` → `0.3.4`), regardless of how many features are
   included. Follow the release process above, including the annotated tag,
   GitHub Actions provenance attestations, and publishing the draft release.
6. After the release is published, use browser control to open the Obsidian
   community plugin page URL supplied by the user (currently
   `https://community.obsidian.md/account/plugins/flux-tts`). Open the
   three-dot menu and choose **Check for new releases**.
7. Wait for the result. If it says the manifest version has already been
   scanned, the release is already covered. If it says a new release was found
   and a scan has started, click **Back to dashboard** and end the current turn;
   the review may take more than five minutes.
8. On the user's next prompt, they will provide the review outcome. Add every
   pass, warning, and recommendation to the review history and prevention rules
   below so future work retains that context.
9. Fix review findings that are serious enough to require a correction. Run the
   tests again; if the feature still works and all checks pass, publish a new
   patch release and repeat steps 5–8. For non-blocking recommendations that do
   not require a correction, record them in this file and end the workflow.

Never claim a feature is complete before its tests pass and the release-review
check has been initiated (or confirmed as already scanned).

## Obsidian community review history

Use this history as release-review context. Do not reintroduce findings that were
resolved in later releases.

| Date | Version | Commit | Result |
|---|---:|---|---|
| Jul 11, 2026 | 0.3.3 | `7b27556` | Completed |
| Jul 11, 2026 | 0.3.2 | `495ebf8` | Completed |
| Jul 6, 2026 | 0.3.1 | `69abfd7` | Completed |
| Jul 6, 2026 | 0.3.0 | `dc6a42c` | Completed |
| Jul 6, 2026 | 0.2.1 | `ed3c09b` | Completed |

### Passed in every listed review

- No suspicious network-request patterns were found.
- Vault access is limited to individual-file reads through the Obsidian API
  (`vault.read`, `vault.cachedRead`) and vault writes through the Obsidian API
  (`vault.modify`, `vault.create`, etc.).
- No vulnerable dependencies were found.
- No code obfuscation was detected.

### Release provenance

- Versions `0.3.3` and `0.3.2` passed verified GitHub artifact attestations for
  both `main.js` and `styles.css`.
- Versions `0.3.0` and `0.2.1` were flagged for missing attestations for those
  assets. Keep the GitHub Actions provenance-attestation step intact and verify
  attestations before publishing every release.

### Findings and prevention rules

- **`editor-paste` event handlers:** First check `evt.defaultPrevented` and
  return early when it is already handled (review finding in `0.3.3`,
  `src/main.ts:159`).
- **Popout-window compatibility:** Use `activeDocument`, not global `document`,
  for DOM operations (findings in `0.3.2`, `0.3.1`, and `0.3.0`,
  `src/main.ts:177`). Avoid unnecessary type assertions on the document value.
- **Regular expressions:** Do not escape characters unnecessarily; in
  particular, avoid `\\[` outside a context where it is required (finding in
  `0.3.3`, `src/main.ts:267`).
- **Settings UI:** Continue using `getSettingDefinitions()`; do not introduce
  the deprecated `display` API (findings in `0.3.3` at lines 116, 152, 181, 271;
  `0.3.2` at lines 115, 151, 180, 258). Do not use deprecated
  `setDynamicTooltip`; slider values are shown inline (finding in `0.3.2`,
  `src/settings.ts:95`).
- **Dependencies:** Do not add `builtin-modules`; use a maintained alternative
  if equivalent functionality is needed (findings in `0.3.0` and `0.2.1`,
  `package.json:22`).

Before a release, run `npm run build`, inspect changed event handlers, DOM
access, regexes, settings APIs, and dependencies against these rules, then
confirm that both release assets have GitHub artifact attestations.

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
