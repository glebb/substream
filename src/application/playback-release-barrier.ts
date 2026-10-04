type ReleaseJob = {
  close: () => Promise<void>;
  retryClose?: () => Promise<void>;
  promise: Promise<void>;
  failure: unknown | null;
};

/** Coordinates exclusive native playback release across screen and route lifetimes. */
export class PlaybackReleaseBarrier {
  private readonly jobs = new Set<ReleaseJob>();
  private retryPromise: Promise<void> | null = null;

  /** Begins cleanup immediately and retains failures until an explicit retry succeeds. */
  release(close: () => Promise<void>, retryClose?: () => Promise<void>): Promise<void> {
    const job = {} as ReleaseJob;
    job.close = close;
    if (retryClose) job.retryClose = retryClose;
    job.failure = null;
    this.jobs.add(job);
    job.promise = this.run(job, close);
    return job.promise;
  }

  private async run(job: ReleaseJob, close: () => Promise<void>): Promise<void> {
    try {
      await close();
      job.failure = null;
      this.jobs.delete(job);
    } catch (error) {
      job.failure = error;
      throw error;
    }
  }

  /** New playback must await this before acquiring the platform's exclusive player. */
  async waitForRelease(): Promise<void> {
    while (this.jobs.size) {
      const jobs = [...this.jobs];
      await Promise.all(jobs.map((job) => job.promise));
      if (jobs.some((job) => job.failure !== null)) {
        throw jobs.find((job) => job.failure !== null)!.failure;
      }
    }
  }

  /** Retries every retained failure once at a time; concurrent calls share the same retry. */
  retryRelease(): Promise<void> {
    if (this.retryPromise) return this.retryPromise;
    this.retryPromise = (async () => {
      for (const job of [...this.jobs]) {
        if (job.failure === null) {
          await job.promise;
          continue;
        }
        const retry = job.retryClose ?? job.close;
        job.promise = this.run(job, retry);
        await job.promise;
      }
    })().finally(() => { this.retryPromise = null; });
    return this.retryPromise;
  }
}
