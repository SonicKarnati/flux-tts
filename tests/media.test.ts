import assert from "node:assert/strict";
import test from "node:test";
import { parseYouTubeCaptionResponse } from "../src/youtube-captions";

test("empty YouTube caption responses fall back instead of throwing JSON errors", () => {
  assert.equal(parseYouTubeCaptionResponse(""), null);
  assert.equal(parseYouTubeCaptionResponse("   "), null);
});

test("non-JSON YouTube caption responses fall back instead of throwing", () => {
  assert.equal(parseYouTubeCaptionResponse("<html>temporarily unavailable</html>"), null);
});

test("valid YouTube json3 captions become transcript segments", () => {
  const parsed = parseYouTubeCaptionResponse(JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "again" }] }
    ]
  }));
  assert.deepEqual(parsed, [
    { start: 1, end: 3, text: "Hello world" },
    { start: 3, end: 4, text: "again" }
  ]);
});

test("valid json3 without usable text falls back", () => {
  assert.equal(parseYouTubeCaptionResponse('{"events":[]}'), null);
});
