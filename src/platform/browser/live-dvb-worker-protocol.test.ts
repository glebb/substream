import { describe, expect, it, vi } from "vitest";
import { LIVE_DVB_MAX_FRAGMENT_BYTES, LIVE_DVB_MAX_QUEUED_FRAGMENTS, LiveDvbWorkerClient, type LiveDvbWorkerRequest, type LiveDvbWorkerResponse, type WorkerPort } from "./live-dvb-worker-protocol.ts";
import { LiveDvbTsScanner } from "./live-dvb-ts-scanner.ts";

const TS_PACKET = 188;
function ts(pid: number, payload: number[]): Uint8Array {
  const packet = new Uint8Array(TS_PACKET).fill(0xff);
  packet[0] = 0x47; packet[1] = ((pid >> 8) & 31) | 0x40; packet[2] = pid & 255; packet[3] = 0x10; packet.set(payload, 4);
  return packet;
}
function concat(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; }
function table(...bytes: number[]): number[] { return [...bytes, 0, 0, 0, 0]; }

describe("worker DVB boundary", () => {
  it("discovers descriptor tracks and emits only a selected page PES", () => {
    const scanner = new LiveDvbTsScanner();
    const pat = table(0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0);
    const pmt = table(2, 0xb0, 28, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
      6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1);
    const tables = concat(ts(0, [0, ...pat]), ts(0x100, [0, ...pmt]));
    scanner.scan(tables);
    expect(scanner.getTracks()).toEqual([{ id: "288:1", pid: 288, language: "fin", compositionPageId: 1, ancillaryPageId: 1 }]);
    scanner.select("288:1");
    const pes = [0, 0, 1, 0xbd, 0, 16, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 0x20, 0,
      0x0f, 0x14, 0, 1, 0, 0];
    expect(scanner.scan(ts(0x120, pes))).toHaveLength(1);
    expect(scanner.scan(ts(0x121, pes))).toHaveLength(0);
  });

  it("caps transferred fragments, applies backpressure, and validates returned frames", () => {
    const listeners = new Map<string, EventListener>();
    const posted: Array<{ message: LiveDvbWorkerRequest; transfer?: Transferable[] }> = [];
    const worker: WorkerPort = {
      postMessage: (message, transfer) => { posted.push({ message, ...(transfer ? { transfer } : {}) }); },
      addEventListener: (type, listener) => { listeners.set(type, listener); },
      removeEventListener: (type) => { listeners.delete(type); },
      terminate: vi.fn(),
    };
    const receive = vi.fn<(message: LiveDvbWorkerResponse) => void>();
    const client = new LiveDvbWorkerClient(worker, { onMessage: receive });
    const huge = new ArrayBuffer(LIVE_DVB_MAX_FRAGMENT_BYTES * 2);
    expect(client.pushFragment(huge, 5)).toBe(true);
    expect(client.pushFragment(huge, 6)).toBe(true);
    expect(client.pushFragment(huge, 7)).toBe(false);
    expect(posted[0]?.message.type).toBe("fragment");
    expect((posted[0]?.message as Extract<LiveDvbWorkerRequest, { type: "fragment" }>).buffer.byteLength).toBe(LIVE_DVB_MAX_FRAGMENT_BYTES);
    expect(posted[0]?.transfer).toHaveLength(1);
    listeners.get("message")?.(new MessageEvent("message", { data: { type: "frame", width: 2, height: 2, x: 0, y: 0, rgba: new ArrayBuffer(3) } }));
    expect(receive).not.toHaveBeenCalled();
    listeners.get("message")?.(new MessageEvent("message", { data: { type: "ack" } }));
    expect(client.pushFragment(huge, 8)).toBe(true);
    expect(LIVE_DVB_MAX_QUEUED_FRAGMENTS).toBe(2);
    client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("copies a bounded packet-aligned discovery window from a later offset", () => {
    const posted: LiveDvbWorkerRequest[] = [];
    const worker: WorkerPort = {
      postMessage: (message) => { posted.push(message); }, addEventListener: () => {}, removeEventListener: () => {}, terminate: () => {},
    };
    const client = new LiveDvbWorkerClient(worker, { onMessage: () => {} });
    const source = new Uint8Array(1_024);
    source.fill(0x7f, 376, 564);
    expect(client.pushFragment(source.buffer, 0, 188, 376)).toBe(true);
    const fragment = posted[0] as Extract<LiveDvbWorkerRequest, { type: "fragment" }>;
    expect(fragment.buffer.byteLength).toBe(188);
    expect(new Uint8Array(fragment.buffer)[0]).toBe(0x7f);
  });
});
