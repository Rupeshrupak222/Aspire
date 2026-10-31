# Aspire Load Testing & Capacity Benchmarking Suite (Day 15)

Production-scale load testing, concurrency benchmarking, bottleneck profiling, and capacity planning harness for **Aspire by Adyapan**.

---

## 1. Architecture Audit & Testing Strategy

Aspire is a high-reliability assessment platform built with:
- **Node.js + Express**: Single-threaded event-driven HTTP application server.
- **SQLite with WAL mode (`better-sqlite3`)**: Single-file ACID persistence with concurrent readers and serialized writers (`busy_timeout: 10000`).
- **BullMQ + Redis**: Asynchronous job queue for background coding execution.
- **Transactional Outbox**: Guaranteed job delivery from SQLite to Redis.
- **LRU In-Memory Caches**: For questions, templates, and pre-rendered PDF certificates.

### Tooling Strategy
1. **k6 (`tools/k6/k6.exe`)**:
   - Used for **realistic, stateful candidate journey simulation** (Registration → Assessment Retrieval → Heartbeat Loop → Periodic Answer Sync → Final Atomic Submission → Certificate Retrieval).
   - Simulates human think times, realistic pacing, connection pooling, and client session lifecycles.
2. **Autocannon (`node load-tests/autocannon/benchmark-runner.js`)**:
   - Used for **isolated endpoint throughput benchmarking** and measuring raw saturated capacity across concurrency tiers (10, 100, 500, 1,000 VUs).
   - Accurately captures latency percentiles (p50, p90, p95, p97.5, p99, max) with linear percentile interpolation.

---

## 2. Directory Structure

```
load-tests/
├── README.md                           # This documentation guide
├── server.js                           # Dedicated isolated test server
├── run-k6.js                           # Automated non-blocking k6 runner harness
├── k6/                                 # k6 scenario scripts
│   ├── config.js                       # Staged Concurrency Tiers & Safety Validations
│   ├── helpers.js                      # Candidate generator & request helpers
│   ├── registration.js                 # Scenario A: Registration load
│   ├── assessment-retrieval.js         # Scenario B: Exam fetch load
│   ├── heartbeat.js                    # Scenario C: 15s candidate heartbeat load
│   ├── answer-sync.js                  # Scenario D: Delta answer sync load
│   ├── submission-spike.js             # Scenario E: Assessment finalization spike
│   ├── coding-execution.js             # Scenario F: Code submission queue load
│   ├── result-retrieval.js             # Scenario G: Candidate & admin results load
│   ├── certificate.js                  # Scenario H: PDF certificate streaming load
│   └── full-journey.js                 # Realistic multi-step candidate journey
├── autocannon/
│   └── benchmark-runner.js             # Staged Autocannon benchmark runner
├── metrics/
│   └── process-monitor.js              # CPU, RSS, Heap, Event Loop Lag & WAL monitor
└── reports/                            # Output directory for benchmark runs
```

---

## 3. Concurrency Tiers

| Profile | Concurrency | Target Scenario | Purpose |
|---|---|---|---|
| **Smoke** | 10 VUs | 30s | Quick sanity verification before test execution |
| **Baseline** | 100 VUs | 60s | Typical daytime concurrent candidate usage |
| **Medium** | 500 VUs | 90s | Standard scheduled institutional scholarship test |
| **High** | 1,000 VUs | 120s | Multi-college synchronized assessment exam |
| **Stress** | 5,000 VUs | 180s | Peak nationwide scholarship drive (Distributed load) |
| **Extreme** | 10,000 VUs | 300s | Saturated infrastructure breaking-point analysis |

---

## 4. How to Run

### k6 Scenarios
To run k6 load scenarios using the automated harness:

```bash
# Run full candidate journey at Smoke tier (10 VUs)
npm run load:k6:smoke

# Run full candidate journey at Baseline tier (100 VUs)
npm run load:k6:baseline

# Run full candidate journey at Medium tier (500 VUs)
npm run load:k6:medium

# Run full candidate journey at High tier (1,000 VUs)
npm run load:k6:high

# Run targeted scenario directly
node load-tests/run-k6.js registration baseline
node load-tests/run-k6.js submission-spike medium
```

### Autocannon Throughput Benchmarks
To run the automated, multi-stage Autocannon benchmark:

```bash
npm run load:autocannon
```
This tests `health`, `public config`, `attempt retrieval`, `heartbeat`, `answer sync`, `submit`, and `certificate delivery` across 10, 100, 500, and 1,000 VUs, tracking CPU, memory, event loop lag, and WAL file size.

### Run All Load Tests
```bash
npm run load:all
```

---

## 5. Distributed Execution Guide (5,000+ VUs)

When benchmarking beyond 1,000 concurrent VUs on Windows localhost, ephemeral port exhaustion (TIME_WAIT socket exhaustion) and single-NIC TCP limits will bottleneck the load generator rather than the application server.

To execute 5,000 to 10,000 VU stress tests safely:
1. **Deploy Target Server**:
   Run the Aspire application on a Linux instance (e.g., AWS c6i.2xlarge or GCP c2-standard-8) with increased file descriptors:
   ```bash
   ulimit -n 65535
   sysctl -w net.ipv4.ip_local_port_range="1024 65535"
   sysctl -w net.ipv4.tcp_tw_reuse=1
   ```
2. **Provision Distributed Load Generators**:
   Launch 5 to 10 agent VMs (e.g. AWS t3.xlarge).
3. **Execute Distributed k6**:
   Distribute the virtual users across instances:
   ```bash
   # Agent 1 (VUs 1-1000)
   k6 run --vus 1000 --duration 5m -e TARGET_URL=http://<TARGET_HOST>:3000 load-tests/k6/full-journey.js

   # Agent 2 (VUs 1001-2000)
   k6 run --vus 1000 --duration 5m -e TARGET_URL=http://<TARGET_HOST>:3000 load-tests/k6/full-journey.js
   # Repeat across remaining worker nodes
   ```

---

## 6. Safety Invariants & Protections

1. **Safety Assertions**:
   - `config.js` enforces that tests reject production hostnames (`adyapan.com`, `aspire.adyapan.internal`) unless explicitly permitted.
2. **Ephemeral Databases**:
   - The harness spins up an ephemeral database in `os.tmpdir()` (`aspire-day15-bench-*.db`) initialized with all migrations and test seeds. It never touches developer or production SQLite files.
3. **Mock Code Execution**:
   - `EXECUTION_PROVIDER_MODE=MOCK` is enforced during load testing. Zero calls are made to OnlineCompiler.io or Judge0 APIs during benchmarking.

