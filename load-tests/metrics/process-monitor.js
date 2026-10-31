// Process, CPU, Memory & Event-Loop Lag Monitor (Day 15)
// Samples system metrics periodically during load testing runs

const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

class ProcessMonitor {
  constructor(sampleIntervalMs = 500, dbPath = null) {
    this.sampleIntervalMs = sampleIntervalMs;
    this.dbPath = dbPath;
    this.timer = null;
    this.samples = [];
    this.elHistogram = null;

    try {
      if (typeof monitorEventLoopDelay === 'function') {
        this.elHistogram = monitorEventLoopDelay({ resolution: 20 });
        this.elHistogram.enable();
      }
    } catch {}

    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }

  start() {
    this.samples = [];
    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = Date.now();

    this.timer = setInterval(() => {
      this.sample();
    }, this.sampleIntervalMs);
  }

  sample() {
    const mem = process.memoryUsage();
    const cpuDiff = process.cpuUsage(this.lastCpu);
    const timeDelta = Date.now() - this.lastCpuTime;

    const cpuPercent = timeDelta > 0
      ? Number(((cpuDiff.user + cpuDiff.system) / (timeDelta * 1000) * 100).toFixed(1))
      : 0;

    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = Date.now();

    let dbSizeKb = 0;
    let walSizeKb = 0;
    if (this.dbPath) {
      try {
        const stats = fs.statSync(this.dbPath);
        dbSizeKb = Math.round(stats.size / 1024);
      } catch {}
      try {
        const walStats = fs.statSync(this.dbPath + '-wal');
        walSizeKb = Math.round(walStats.size / 1024);
      } catch {}
    }

    const elLagMs = this.elHistogram
      ? Number((this.elHistogram.percentile(95) / 1e6).toFixed(2))
      : 0;

    this.samples.push({
      timestamp: Date.now(),
      cpuPercent,
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
      externalMb: Number((mem.external / 1024 / 1024).toFixed(1)),
      elLagMs,
      dbSizeKb,
      walSizeKb
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.samples.length) {
      return {
        peakCpu: 0,
        avgCpu: 0,
        peakRssMb: 0,
        avgRssMb: 0,
        peakHeapMb: 0,
        avgHeapMb: 0,
        peakElLagMs: 0,
        peakWalSizeKb: 0
      };
    }

    const cpus = this.samples.map(s => s.cpuPercent);
    const rsses = this.samples.map(s => s.rssMb);
    const heaps = this.samples.map(s => s.heapUsedMb);
    const lags = this.samples.map(s => s.elLagMs);
    const wals = this.samples.map(s => s.walSizeKb);

    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const max = (arr) => Math.max(...arr);
    const avg = (arr) => Number((sum(arr) / arr.length).toFixed(1));

    return {
      peakCpu: max(cpus),
      avgCpu: avg(cpus),
      peakRssMb: max(rsses),
      avgRssMb: avg(rsses),
      peakHeapMb: max(heaps),
      avgHeapMb: avg(heaps),
      peakElLagMs: max(lags),
      peakWalSizeKb: max(wals),
      sampleCount: this.samples.length
    };
  }
}

module.exports = ProcessMonitor;

