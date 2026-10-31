// k6 Test Harness & Isolated Server Launcher (Day 15)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const PORT = 3310;
const DB_PATH = path.join(os.tmpdir(), `aspire-day15-k6-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await wait(250);
  }
  return false;
}

async function main() {
  const scriptName = process.argv[2] || 'smoke';
  const profile = process.argv[3] || 'smoke';

  // Resolve target k6 script
  const k6Dir = path.join(__dirname, 'k6');
  let targetScript = path.join(k6Dir, `${scriptName}.js`);
  if (!fs.existsSync(targetScript)) {
    targetScript = path.join(k6Dir, 'full-journey.js');
  }

  // Locate k6 binary
  const localK6 = path.join(__dirname, '..', 'tools', 'k6', 'k6.exe');
  const k6Bin = fs.existsSync(localK6) ? localK6 : 'k6';

  console.log('========================================================================');
  console.log('ASPIRE DAY 15: k6 REALISTIC USER SIMULATION HARNESS');
  console.log('========================================================================\n');

  console.log(`[SAFETY CHECK] Target Base URL: ${BASE_URL}`);
  console.log(`[SAFETY CHECK] Environment: test`);
  console.log(`[SAFETY CHECK] Target Script: ${path.basename(targetScript)}`);
  console.log(`[SAFETY CHECK] Profile: ${profile}`);
  console.log(`[SAFETY CHECK] Isolated DB: ${DB_PATH}\n`);

  // Spawn isolated test server in dedicated child process (non-blocking)
  console.log(`Starting isolated test server on port ${PORT}...`);
  const serverProc = spawn('node', [path.join(__dirname, 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      AUTH_SECRET: 'day15_k6_load_testing_secret_key_32bytes!'
    },
    stdio: 'inherit'
  });

  const isUp = await waitForServer(BASE_URL);
  if (!isUp) {
    console.error('[Harness Error] Server failed to start within timeout.');
    try { serverProc.kill('SIGKILL'); } catch {}
    process.exit(1);
  }

  console.log(`Server healthy and ready at ${BASE_URL}\n`);

  try {
    const k6Args = [
      'run',
      '--env', `BASE_URL=${BASE_URL}`,
      '--env', `PROFILE=${profile}`,
      targetScript
    ];

    console.log(`Executing: ${k6Bin} ${k6Args.join(' ')}\n`);
    const proc = spawnSync(k6Bin, k6Args, {
      stdio: 'inherit',
      env: { ...process.env, BASE_URL, PROFILE: profile }
    });

    if (proc.error) {
      console.error('Failed to launch k6 process:', proc.error.message);
      process.exit(1);
    }

    if (proc.status !== 0) {
      console.error(`k6 test exited with non-zero status code: ${proc.status}`);
      process.exit(proc.status || 1);
    }

  } finally {
    console.log('\nStopping isolated test server...');
    try {
      serverProc.kill('SIGTERM');
      // On Windows kill tree if needed
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/f', '/t'], { stdio: 'ignore' });
    } catch {}

    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal harness error:', err);
    process.exit(1);
  });
}
