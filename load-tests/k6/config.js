// k6 Load Testing Configuration & Staged Profiles (Day 15)
// Aspire by Adyapan — Production-Scale Load Testing

export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3310';
export const ENVIRONMENT = __ENV.NODE_ENV || 'loadtest';

// Verify target safety: never execute load tests against production
if (BASE_URL.includes('adyapan.com') || BASE_URL.includes('prod')) {
  throw new Error(`[SAFETY ABORT] Refusing to run load test against production host: ${BASE_URL}`);
}

export const PROFILES = {
  smoke: {
    stages: [
      { duration: '2s', target: 5 },
      { duration: '6s', target: 10 },
      { duration: '2s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<500'],
      http_req_failed: ['rate<0.01']
    }
  },
  baseline: {
    stages: [
      { duration: '5s', target: 50 },
      { duration: '10s', target: 100 },
      { duration: '5s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<750'],
      http_req_failed: ['rate<0.02']
    }
  },
  medium: {
    stages: [
      { duration: '5s', target: 100 },
      { duration: '10s', target: 500 },
      { duration: '10s', target: 500 },
      { duration: '5s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000'],
      http_req_failed: ['rate<0.05']
    }
  },
  high: {
    stages: [
      { duration: '5s', target: 200 },
      { duration: '10s', target: 500 },
      { duration: '10s', target: 1000 },
      { duration: '10s', target: 1000 },
      { duration: '5s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500'],
      http_req_failed: ['rate<0.05']
    }
  },
  stress: {
    stages: [
      { duration: '10s', target: 1000 },
      { duration: '15s', target: 2500 },
      { duration: '15s', target: 5000 },
      { duration: '10s', target: 5000 },
      { duration: '10s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<2500'],
      http_req_failed: ['rate<0.10']
    }
  },
  extreme: {
    stages: [
      { duration: '10s', target: 1000 },
      { duration: '15s', target: 5000 },
      { duration: '20s', target: 10000 },
      { duration: '20s', target: 10000 },
      { duration: '15s', target: 0 }
    ],
    thresholds: {
      http_req_duration: ['p(95)<4000'],
      http_req_failed: ['rate<0.15']
    }
  }
};

export function getProfileOptions(profileName = 'smoke') {
  const profile = PROFILES[profileName] || PROFILES.smoke;
  return {
    stages: profile.stages,
    thresholds: profile.thresholds
  };
}

