// Scenario B: Assessment Retrieval Load Test (Day 15)
// Endpoint: GET /api/attempt/:token
// Tests authenticated candidates retrieving active questions and timer synchronization

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const retrievalLatency = new Trend('assessment_retrieval_latency_ms');
const retrievalSuccessRate = new Rate('assessment_retrieval_success_rate');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

// Register candidate attempts in setup phase so every VU tests against active attempts
export function setup() {
  const tokens = [];
  const count = 50; // Seed pool of candidate attempts
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 999);
    const headers = getCandidateHeaders(i);
    const res = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.token) tokens.push(body.token);
      } catch {}
    }
  }
  return { tokens };
}

export default function (data) {
  const headers = getCandidateHeaders(__VU);
  const tokenList = data.tokens;
  const token = tokenList && tokenList.length > 0
    ? tokenList[__VU % tokenList.length]
    : 'test_token_fallback';

  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/attempt/${token}`, { headers });
  const duration = Date.now() - start;

  retrievalLatency.add(duration);

  if (res.status === 200) {
    retrievalSuccessRate.add(1);
    check(res, {
      'attempt retrieval returned 200': (r) => r.status === 200,
      'has questions': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.questions) && body.questions.length > 0;
        } catch {
          return false;
        }
      },
      'no answer leakage': (r) => {
        return !r.body.includes('"correct_index"') && !r.body.includes('"test_cases"');
      }
    });
  } else {
    retrievalSuccessRate.add(0);
    check(res, {
      'no 500 error on attempt retrieval': (r) => r.status !== 500
    });
  }

  // Realistic question viewing pause
  sleep(1.0);
}

