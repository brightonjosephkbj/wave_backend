'use strict';

// ── Simple in-memory download queue ──────────────────────────────────────────
// Limits concurrent yt-dlp processes to avoid OOM on Fly.io free tier

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_DL || '3');

class DownloadQueue {
  constructor() {
    this.running = 0;
    this.queue   = [];
    this.jobs    = new Map(); // jobId → { status, result, error, createdAt }
  }

  // Add a job and return a jobId immediately
  enqueue(fn) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.jobs.set(jobId, { status: 'queued', result: null, error: null, createdAt: Date.now() });
    this.queue.push({ jobId, fn });
    this._tick();
    return jobId;
  }

  // Get job status
  status(jobId) {
    return this.jobs.get(jobId) || null;
  }

  // Internal: run next in queue if slot available
  _tick() {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const { jobId, fn } = this.queue.shift();
      this.running++;
      const job = this.jobs.get(jobId);
      job.status = 'running';
      job.startedAt = Date.now();

      Promise.resolve()
        .then(() => fn())
        .then(result => {
          job.status   = 'done';
          job.result   = result;
          job.finishedAt = Date.now();
        })
        .catch(err => {
          job.status   = 'error';
          job.error    = err.message || String(err);
          job.finishedAt = Date.now();
        })
        .finally(() => {
          this.running--;
          this._tick();
          // Auto-cleanup old jobs after 1 hour
          setTimeout(() => this.jobs.delete(jobId), 60 * 60 * 1000);
        });
    }
  }

  // Queue depth
  get depth() { return this.queue.length; }
  get active() { return this.running; }
}

module.exports = new DownloadQueue();
