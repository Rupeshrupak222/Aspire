// Scenario A: Candidate Registration Load Test (Day 15)
// Endpoint: POST /api/register
// Tests concurrent candidate registration bursts, unique identity persistence, and rate-limiting

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const registrationLatency = new Trend('registration_latency_ms');
const registrationSuccessRate = new Rate('registration_success_rate');
const rateLimitedCount = new Counter('registration_rate_limited_total');
const conflictCount = new Counter('registration_conflict_total');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export default function () {
  const candidate = generateCandidate(__VU, __ITER);
  const headers = getCandidateHeaders(__VU);

  const payload = JSON.stringify(candidate);
  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/register`, payload, { headers });
  const duration = Date.now() - start;

  registrationLatency.add(duration);

  if (res.status === 200) {
    registrationSuccessRate.add(1);
    check(res, {
      'registration returned 200': (r) => r.status === 200,
      'token issued': (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.token;
        } catch {
          return false;
        }
      }
    });
  } else if (res.status === 429) {
    rateLimitedCount.add(1);
    registrationSuccessRate.add(0);
  } else if (res.status === 409) {
    conflictCount.add(1);
    registrationSuccessRate.add(0);
  } else {
    registrationSuccessRate.add(0);
    check(res, {
      'unexpected status error': (r) => r.status < 500
    });
  }

  // Realistic user pacing between registration clicks
  sleep(0.5);
}

