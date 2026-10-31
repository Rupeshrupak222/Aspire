// Scenario E: Concurrent Submission Spike Load Test (Day 15)
// Endpoint: POST /api/attempt/:token/submit
// Simulates concurrent candidate submission spikes, measuring grading latency & atomic lock integrity

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const submissionLatency = new Trend('submission_latency_ms');
const submissionSuccessRate = new Rate('submission_success_rate');
const submissionConflictCount = new Counter('submission_conflict_409_total');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const attempts = [];
  const count = 50;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 666);
    const headers = getCandidateHeaders(i);
    const res = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.token) {
          attempts.push(body.token);
        }
      } catch {}
    }
  }
  return { attempts };
}

export default function (data) {
  const headers = getCandidateHeaders(__VU);
  const tokenList = data.attempts;
  const token = tokenList && tokenList.length > 0
    ? tokenList[__VU % tokenList.length]
    : 'fallback_token';

  const payload = JSON.stringify({
    answers: { '1': 0, '2': 1, '3': 2 },
    tabSwitches: 0
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/attempt/${token}/submit`, payload, { headers });
  const duration = Date.now() - start;

  submissionLatency.add(duration);

  if (res.status === 200) {
    submissionSuccessRate.add(1);
    check(res, {
      'submission returned 200': (r) => r.status === 200,
      'has score and certificate': (r) => {
        try {
          const body = JSON.parse(r.body);
          return typeof body.score === 'number' && !!body.certificate_id;
        } catch {
          return false;
        }
      }
    });
  } else if (res.status === 409) {
    submissionConflictCount.add(1);
    submissionSuccessRate.add(1); // 409 is expected when concurrent requests race on same attempt
  } else {
    submissionSuccessRate.add(0);
    check(res, {
      'no unexpected 500 error on submit': (r) => r.status < 500
    });
  }

  sleep(1.0);
}

