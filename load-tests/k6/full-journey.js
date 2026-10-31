// End-to-End Candidate Workflow Load Test (Day 15)
// Simulates the complete candidate assessment journey under concurrent load:
// 1. Register -> 2. Fetch Questions -> 3. Heartbeat -> 4. Sync Answers -> 5. Submit -> 6. Certificate

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const journeyLatency = new Trend('full_journey_total_duration_ms');
const journeySuccessRate = new Rate('full_journey_success_rate');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export default function () {
  const headers = getCandidateHeaders(__VU);
  const candidate = generateCandidate(__VU, __ITER);
  const journeyStart = Date.now();

  let token = null;
  let certId = null;
  let firstQId = 1;

  // Step 1: Register
  group('1. Candidate Registration', function () {
    const res = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    const ok = check(res, { 'registered successfully (200)': (r) => r.status === 200 });
    if (ok) {
      try {
        const body = JSON.parse(res.body);
        token = body.token;
      } catch {}
    }
  });

  if (!token) {
    journeySuccessRate.add(0);
    return;
  }

  sleep(0.5);

  // Step 2: Retrieve Assessment Questions
  group('2. Assessment Retrieval', function () {
    const res = http.get(`${BASE_URL}/api/attempt/${token}`, { headers });
    const ok = check(res, { 'attempt fetched (200)': (r) => r.status === 200 });
    if (ok) {
      try {
        const body = JSON.parse(res.body);
        if (body.questions && body.questions.length > 0) {
          firstQId = body.questions[0].id;
        }
      } catch {}
    }
  });

  sleep(0.5);

  // Step 3: Candidate Heartbeat
  group('3. Heartbeat Pulse', function () {
    const payload = JSON.stringify({ tabSwitches: 0, clientSessionId: `client_session_vu_${__VU}` });
    const res = http.post(`${BASE_URL}/api/attempt/${token}/heartbeat`, payload, { headers });
    check(res, { 'heartbeat ok (200)': (r) => r.status === 200 });
  });

  sleep(0.5);

  // Step 4: Progress / Answer Synchronization
  group('4. Progress Synchronization', function () {
    const payload = JSON.stringify({
      clientSessionId: `client_session_vu_${__VU}`,
      localRevision: 0,
      changes: [
        {
          changeId: `change_${__VU}_${__ITER}_${Date.now()}`,
          type: 'MCQ_ANSWER',
          questionId: firstQId,
          answer: 0,
          revision: 1,
          timestamp: new Date().toISOString()
        }
      ]
    });
    const res = http.post(`${BASE_URL}/api/attempt/${token}/progress/sync`, payload, { headers });
    check(res, { 'progress synced (200)': (r) => r.status === 200 });
  });

  sleep(0.5);

  // Step 5: Final Submission & Grading
  group('5. Final Assessment Submission', function () {
    const payload = JSON.stringify({
      answers: { [String(firstQId)]: 0 },
      tabSwitches: 0
    });
    const res = http.post(`${BASE_URL}/api/attempt/${token}/submit`, payload, { headers });
    const ok = check(res, { 'submitted successfully (200)': (r) => r.status === 200 });
    if (ok) {
      try {
        const body = JSON.parse(res.body);
        certId = body.certificate_id;
      } catch {}
    }
  });

  sleep(0.5);

  // Step 6: Certificate Download (if eligible)
  if (certId) {
    group('6. Certificate Download', function () {
      const res = http.get(`${BASE_URL}/api/certificate/${certId}`, { headers });
      check(res, { 'certificate downloaded (200)': (r) => r.status === 200 });
    });
  }

  const journeyDuration = Date.now() - journeyStart;
  journeyLatency.add(journeyDuration);
  journeySuccessRate.add(token && certId ? 1 : 0);

  sleep(1.0);
}
