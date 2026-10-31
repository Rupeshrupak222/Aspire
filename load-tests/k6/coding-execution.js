// Scenario F: Coding Execution & Asynchronous Queue Load Test (Day 15)
// Endpoints: POST /api/attempt/:token/code-submit & GET /api/attempt/:token/coding-submissions/:id
// Tests asynchronous coding job ingestion into BullMQ and SQLite Transactional Outbox

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const codeSubmitLatency = new Trend('code_submit_latency_ms');
const codeSubmitAcceptedRate = new Rate('code_submit_accepted_rate');
const codePollingLatency = new Trend('code_polling_latency_ms');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const attempts = [];
  const count = 30;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 555);
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
    question_id: 1,
    source_code: 'def solution(x): return x * 2',
    language: 'python'
  });

  // 1. Submit Code for Asynchronous Evaluation
  const submitStart = Date.now();
  const submitRes = http.post(`${BASE_URL}/api/attempt/${token}/code-submit`, payload, { headers });
  const submitDuration = Date.now() - submitStart;
  codeSubmitLatency.add(submitDuration);

  let submissionId = null;
  if (submitRes.status === 202 || submitRes.status === 200) {
    codeSubmitAcceptedRate.add(1);
    try {
      const body = JSON.parse(submitRes.body);
      submissionId = body.submissionId || body.id || (body.data && body.data.id);
    } catch {}
  } else {
    codeSubmitAcceptedRate.add(0);
  }

  // 2. Poll for Submission Status
  if (submissionId) {
    sleep(0.5);
    const pollStart = Date.now();
    const pollRes = http.get(`${BASE_URL}/api/attempt/${token}/coding-submissions/${submissionId}`, { headers });
    const pollDuration = Date.now() - pollStart;
    codePollingLatency.add(pollDuration);

    check(pollRes, {
      'polling returns status 200': (r) => r.status === 200,
      'has lifecycle status': (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.lifecycle_status || !!body.status;
        } catch {
          return false;
        }
      }
    });
  }

  sleep(1.0);
}

