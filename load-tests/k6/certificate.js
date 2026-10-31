// Scenario H: Certificate Delivery Load Test (Day 15)
// Endpoint: GET /api/certificate/:certId
// Simulates concurrent PDF certificate downloads, measuring streaming throughput and server latency

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, getProfileOptions } from './config.js';
import { generateCandidate, getCandidateHeaders } from './helpers.js';

const certLatency = new Trend('certificate_download_latency_ms');
const certSuccessRate = new Rate('certificate_download_success_rate');

export const options = getProfileOptions(__ENV.PROFILE || 'smoke');

export function setup() {
  const certificateIds = [];
  const count = 25;
  for (let i = 1; i <= count; i++) {
    const candidate = generateCandidate(i, 333);
    const headers = getCandidateHeaders(i);
    const regRes = http.post(`${BASE_URL}/api/register`, JSON.stringify(candidate), { headers });
    if (regRes.status === 200) {
      try {
        const regBody = JSON.parse(regRes.body);
        if (regBody.token) {
          const subRes = http.post(`${BASE_URL}/api/attempt/${regBody.token}/submit`, JSON.stringify({ answers: { '1': 0 } }), { headers });
          if (subRes.status === 200) {
            const subBody = JSON.parse(subRes.body);
            if (subBody.certificate_id) {
              certificateIds.push(subBody.certificate_id);
            }
          }
        }
      } catch {}
    }
  }
  return { certificateIds };
}

export default function (data) {
  const headers = getCandidateHeaders(__VU);
  const certList = data.certificateIds;
  const certId = certList && certList.length > 0
    ? certList[__VU % certList.length]
    : 'ASP26-TEST';

  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/certificate/${certId}`, { headers });
  const duration = Date.now() - start;

  certLatency.add(duration);

  if (res.status === 200) {
    certSuccessRate.add(1);
    check(res, {
      'certificate returned 200': (r) => r.status === 200,
      'content type is pdf': (r) => {
        const ct = r.headers['Content-Type'] || r.headers['content-type'] || '';
        return ct.includes('application/pdf');
      },
      'body is valid pdf binary': (r) => {
        return r.body && r.body.length > 1000;
      }
    });
  } else {
    certSuccessRate.add(0);
    check(res, {
      'no 500 error on certificate download': (r) => r.status < 500
    });
  }

  sleep(1.0);
}

