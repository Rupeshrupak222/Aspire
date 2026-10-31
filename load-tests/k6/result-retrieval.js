// Scenario G: Result Retrieval Load Test (Day 15)
// Endpoint: GET /api/attempt/:token (for submitted attempts)
// Tests retrieval of final graded assessment results, scholarship slabs, and certificate claim codes

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const resultLatency = new Trend('result_retrieval_latency_ms');
const resultSuccessRate = new Rate('result_retrieval_success_rate');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const submittedTokens = [];
  const count = 30;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 444);
    const headers = getCandidateHeaders(i);
    const regRes = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    if (regRes.status === 200) {
      try {
        const body = JSON.parse(regRes.body);
        if (body.token) {
          // Submit the attempt immediately so it transitions to submitted
          http.post(`${BASE_URL}/api/attempt/${body.token}/submit`, JSON.stringify({ answers: { '1': 0 } }), { headers });
          submittedTokens.push(body.token);
        }
      } catch {}
    }
  }
  return { submittedTokens };
}

export default function (data) {
  const headers = getCandidateHeaders(__VU);
  const tokenList = data.submittedTokens;
  const token = tokenList && tokenList.length > 0
    ? tokenList[__VU % tokenList.length]
    : 'fallback_token';

  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/attempt/${token}`, { headers });
  const duration = Date.now() - start;

  resultLatency.add(duration);

  if (res.status === 200) {
    resultSuccessRate.add(1);
    check(res, {
      'result retrieval returned 200': (r) => r.status === 200,
      'status is submitted': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.status === 'submitted';
        } catch {
          return false;
        }
      },
      'has certificate id': (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.certificate_id;
        } catch {
          return false;
        }
      }
    });
  } else {
    resultSuccessRate.add(0);
    check(res, {
      'no 500 error on result retrieval': (r) => r.status < 500
    });
  }

  sleep(1.0);
}

