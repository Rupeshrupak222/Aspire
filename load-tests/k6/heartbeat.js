// Scenario C: Heartbeat Load Test (Day 15)
// Endpoint: POST /api/attempt/:token/heartbeat
// Simulates concurrent candidates transmitting periodic heartbeats (15s interval)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const heartbeatLatency = new Trend('heartbeat_latency_ms');
const heartbeatSuccessRate = new Rate('heartbeat_success_rate');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const tokens = [];
  const count = 50;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 888);
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

  const payload = JSON.stringify({
    tabSwitches: 1,
    clientSessionId: `client_session_vu_${__VU}`,
    currentQuestionId: 1
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/attempt/${token}/heartbeat`, payload, { headers });
  const duration = Date.now() - start;

  heartbeatLatency.add(duration);

  if (res.status === 200) {
    heartbeatSuccessRate.add(1);
    check(res, {
      'heartbeat returned 200': (r) => r.status === 200,
      'heartbeat acknowledged': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.ok === true && body.acknowledged === true;
        } catch {
          return false;
        }
      }
    });
  } else {
    heartbeatSuccessRate.add(0);
    check(res, {
      'no server error on heartbeat': (r) => r.status < 500
    });
  }

  // Realistic heartbeat pacing interval (compressed for test duration if needed, e.g. 2-5s)
  sleep(__ENV.PACING ? Number(__ENV.PACING) : 2.0);
}
