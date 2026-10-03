import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayFixture } from "./create-relay-fixture.ts";
import { LiveSubtitleSegmentProcessor } from "../services/live-subtitle-relay/subtitles.ts";
import { relayFfmpegArgs } from "../services/live-subtitle-relay/ingest.ts";

/** Real FFmpeg packaging and decoding, entirely offline and synthetic. */
async function smoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "substream-relay-smoke-"));
  try {
    const fixture = join(directory, "fixture.ts");
    await createRelayFixture(fixture);
    const result = spawnSync("ffmpeg", relayFfmpegArgs(directory), { input: await readFile(fixture), stdio: ["pipe", "ignore", "ignore"] });
    assert.equal(result.status, 0, "Synthetic FFmpeg packaging failed");
    const processor = new LiveSubtitleSegmentProcessor();
    const cues = [];
    let imageCount = 0;
    for (let sequence = 0; sequence < 3; sequence++) {
      const segment = await readFile(join(directory, "segment-" + String(sequence).padStart(8, "0") + ".ts"));
      const decoded = processor.processSegment(segment, { sequence });
      assert.equal(decoded.tracks[0]?.language, "fin", "DVB language lost during packaging");
      cues.push(...decoded.cues);
      for (const image of decoded.images) {
        assert.deepEqual([...image.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        imageCount++;
      }
    }
    assert.deepEqual(cues.map((cue) => [cue.startMs, cue.clear]), [[2000, false], [4000, true], [6000, false], [8000, true]]);
    assert.ok(imageCount >= 1, "No PNG assets decoded");
    processor.dispose();
    process.stdout.write("Synthetic relay smoke passed: copied video/audio/DVB, subtitle PNGs, 4 correctly timed display/clear cues.\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

smoke().catch(() => {
  process.stderr.write("Synthetic relay smoke failed. Check FFmpeg/libx264 availability and run relay unit tests.\n");
  process.exitCode = 1;
});
