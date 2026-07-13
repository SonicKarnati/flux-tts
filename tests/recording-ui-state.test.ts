import assert from "node:assert/strict";
import test from "node:test";
import { createRetryBlock, parseRetryBlock, recordingAction } from "../src/recording-ui-state";

test("mobile ribbon action follows every recorder state", () => {
  assert.equal(recordingAction("idle").label, "Start transcription");
  assert.equal(recordingAction("starting").label, "Stop transcription");
  assert.equal(recordingAction("recording").label, "Stop transcription");
  assert.equal(recordingAction("recovering").label, "Stop transcription");
  assert.equal(recordingAction("paused").label, "Resume transcription");
  assert.equal(recordingAction("error").label, "Resume transcription");
});

test("retry blocks preserve the existing recording identity", () => {
  const data = { audioPath: "audio/recording.m4a", fileName: "recording.m4a", message: "Offline" };
  const block = createRetryBlock(data);
  const source = block.replace(/^```flux-tts-retry\n|\n```$/g, "");
  assert.deepEqual(parseRetryBlock(source), data);
  assert.match(block, /Retry|retry/);
});

test("invalid retry blocks cannot create a second recording", () => {
  assert.throws(() => parseRetryBlock('{"fileName":"new.m4a"}'), /audio path/i);
});
