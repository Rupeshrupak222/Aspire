// Scenario D: Answer Synchronization Load Test (Day 15)
// Endpoint: POST /api/attempt/:token/progress/sync
// Tests concurrent batch answer synchronization and revision conflict handling

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const syncLatency = new Trend('answer_sync_latency_ms');
const syncSuccessRate = new Rate('answer_sync_success_rate');
const syncConflictCount = new Counter('answer_sync_conflict_total');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const attempts = [];
  const count = 50;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 777);
    const headers = getCandidateHeaders(i);
    const res = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.token) {
          // Fetch questions to know question IDs
          const qRes = http.get(`${BASE_URL}/api/attempt/${body.token}`, { headers });
          let firstQId = 1;
          if (qRes.status === 200) {
            const qBody = JSON.parse(qRes.body);
            if (qBody.questions && qBody.questions.length > 0) {
              firstQId = qBody.questions[0].id;
            }
          }
          attempts.push({ token: body.token, qId: firstQId });
        }
      } catch {}
    }
  }
  return { attempts };
}

export default function (data) {
  const headers = getCandidateHeaders(__VU);
  const attList = data.attempts;
  const item = attList && attList.length > 0
    ? attList[__VU % attList.length]
    : { token: 'fallback_token', qId: 1 };

  const payload = JSON.stringify({
    clientSessionId: `client_session_sync_vu_${__VU}`,
    localRevision: __ITER,
    changes: [
      {
        changeId: `change_${__VU}_${__ITER}_${Date.now()}`,
        type: 'MCQ_ANSWER',
        questionId: item.qId,
        answer: __ITER % 4,
        revision: 1,
        timestamp: new Date().toISOString()
      }
    ],
    currentQuestionId: item.qId,
    draftCode: {}
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/attempt/${item.token}/progress/sync`, payload, { headers });
  const duration = Date.now() - start;

  syncLatency.add(duration);

  if (res.status === 200) {
    syncSuccessRate.add(1);
    check(res, {
      'sync returned 200': (r) => r.status === 200,
      'sync acknowledged': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.ok === true && Array.isArray(body.acknowledged);
        } catch {
          return false;
        }
      }
    });
  } else if (res.status === 409) {
    syncConflictCount.add(1);
    syncSuccessRate.add(1); // 409 is an expected operational conflict result
  } else {
    syncSuccessRate.add(0);
    check(res, {
      'no server error on progress sync': (r) => r.status < 500
    });
  }

  // Realistic candidate answer selection pause
  sleep(1.0);
}
