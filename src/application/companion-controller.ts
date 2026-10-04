import type { VodCatalogItem } from "../core/catalog/index.ts";
import type { CompanionConnection, CompanionDeviceIdentity, CompanionEventsResult, CompanionLocalPlayback, CompanionSelection } from "../contracts/companion.ts";

export type CompanionCommand =
  | { kind: "play" | "select"; title: VodCatalogItem }
  | { kind: "play-local"; media: CompanionLocalPlayback; server: string; tvCredential: string }
  | { kind: "stop-local"; sessionId: string };

export type CompanionState = "disabled" | "connecting" | "available" | "unavailable";
export interface CompanionSnapshot {
  state: CompanionState;
  server: string;
  paired: boolean;
  pairingCode: string;
  status: string;
  error: string;
}

export interface CompanionDependencies {
  identity(): CompanionDeviceIdentity;
  connect(server: string, fingerprint: string, identity: CompanionDeviceIdentity, credential?: string): Promise<CompanionConnection>;
  events(server: string, credential: string, after: number, signal?: AbortSignal): Promise<CompanionEventsResult>;
  acknowledge(server: string, credential: string, sequence: number): Promise<void>;
  reset(server: string, credential: string): Promise<{ pairingCode: string; pairingExpiresAt: number }>;
  loadCredential(server: string): string;
  saveCredential(server: string, credential: string): void;
  resolveSelection(selection: CompanionSelection): VodCatalogItem | null;
  createAbortController(): AbortController | undefined;
  now(): number;
}

export function companionRetryDelay(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt), 30_000);
}

/** One application-owned input source. Screens never own registration or polling. */
export class CompanionController {
  private snapshot: CompanionSnapshot = { state: "disabled", server: "", paired: false, pairingCode: "", status: "", error: "" };
  private generation = 0;
  private enabled = false;
  private fingerprint = "";
  private connection: CompanionConnection | null = null;
  private sequence = 0;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private commandListeners = new Set<(command: CompanionCommand) => void>();

  constructor(private readonly dependencies: CompanionDependencies) {}

  getSnapshot = (): CompanionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  onCommand(listener: (command: CompanionCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => { this.commandListeners.delete(listener); };
  }

  configure(options: { enabled: boolean; server: string; sourceFingerprint: string }): void {
    const enabled = options.enabled && Boolean(options.server.trim());
    if (enabled === this.enabled && options.server === this.snapshot.server && options.sourceFingerprint === this.fingerprint) return;
    this.stop();
    this.enabled = enabled;
    this.fingerprint = options.sourceFingerprint;
    this.connection = null;
    this.sequence = 0;
    this.update({ state: enabled ? "connecting" : "disabled", server: options.server, paired: false, pairingCode: "", status: "", error: "" });
    if (enabled) {
      this.abort = this.dependencies.createAbortController();
      void this.run(this.generation);
    }
  }

  /** Explicit reconnect also works when the saved integration was disabled. */
  reconnect(server: string): void {
    this.stop();
    this.enabled = false;
    this.configure({ enabled: true, server, sourceFingerprint: this.fingerprint });
  }

  async resetPairing(): Promise<void> {
    const generation = this.generation;
    const connection = this.connection;
    if (!connection || !this.enabled) return;
    try {
      const result = await this.dependencies.reset(this.snapshot.server, connection.tvCredential);
      if (!this.active(generation) || connection !== this.connection) return;
      this.connection = { ...connection, ...result, paired: false };
      this.update({ paired: false, pairingCode: result.pairingCode, status: "Pair this TV again in the web app using the new code.", error: "" });
    } catch {
      if (this.active(generation)) this.update({ error: "Could not reset TV pairing." });
    }
  }

  dispose(): void {
    this.stop();
    this.enabled = false;
    this.connection = null;
    this.update({ state: "disabled", paired: false, pairingCode: "", status: "", error: "" });
  }

  private stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.wake?.();
    this.wake = undefined;
  }
  private active(generation: number): boolean { return this.enabled && generation === this.generation; }
  private update(change: Partial<CompanionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => { this.timer = undefined; this.wake = undefined; resolve(); }, ms);
    });
  }

  private async run(generation: number): Promise<void> {
    let failures = 0;
    while (this.active(generation)) {
      try {
        const server = this.snapshot.server;
        if (!this.connection || this.dependencies.now() >= this.connection.expiresAt - 120_000
          || !this.snapshot.paired && this.dependencies.now() >= this.connection.pairingExpiresAt) {
          const credential = this.connection?.tvCredential || this.dependencies.loadCredential(server);
          const connection = await this.dependencies.connect(server, this.fingerprint, this.dependencies.identity(), credential);
          if (!this.active(generation)) return;
          this.dependencies.saveCredential(server, connection.tvCredential);
          if (this.connection?.tvCredential !== connection.tvCredential) this.sequence = 0;
          this.connection = connection;
          this.update({ state: "available", paired: connection.paired, pairingCode: connection.pairingCode,
            status: connection.paired ? "This TV is paired and ready." : "Pair this TV in the web app using the code below.", error: "" });
        }
        const connection = this.connection!;
        const response = await this.dependencies.events(server, connection.tvCredential, this.sequence, this.abort?.signal);
        if (!this.active(generation)) return;
        failures = 0;
        this.update({ state: "available", paired: response.paired, error: "" });
        if (response.retentionGap) this.sequence = Math.max(this.sequence, response.retentionGap.throughSequence);
        for (const event of response.events) {
          if (event.sequence <= this.sequence) continue;
          let command: CompanionCommand | null = null;
          if (event.action === "stop-local") command = { kind: "stop-local", sessionId: event.sessionId };
          else if (event.action === "play-local") command = { kind: "play-local", media: event.localMedia, server, tvCredential: connection.tvCredential };
          else {
            const title = this.dependencies.resolveSelection(event.selection);
            if (title) command = { kind: event.action === "play" ? "play" : "select", title };
            else this.update({ error: "The selected title belongs to a different provider connection or is unavailable." });
          }
          // Advance before delivery: a throwing UI subscriber must not make an
          // already-observed event eligible for replay on the next poll.
          this.sequence = event.sequence;
          if (command) {
            for (const listener of Array.from(this.commandListeners)) {
              try { listener(command); } catch { /* One consumer cannot block other consumers or event acknowledgment. */ }
            }
          }
        }
        if (this.sequence > 0) {
          await this.dependencies.acknowledge(server, connection.tvCredential, this.sequence);
          if (!this.active(generation)) return;
        }
        // Long polling normally blocks; this also bounds busy loops on empty immediate responses.
        await this.wait(250);
      } catch (cause) {
        if (!this.active(generation)) return;
        if (cause instanceof Error && cause.message === "Companion connection expired.") this.connection = null;
        this.update({ state: "unavailable", error: "TV connection was interrupted. Reconnecting…" });
        await this.wait(companionRetryDelay(failures++));
      }
    }
  }
}
