// Helper functions for k6 load scenarios (Day 15)
// Generates unique synthetic candidate identities and requests

/**
 * Generate a deterministic synthetic candidate identity per VU and iteration
 */
export function generateCandidate(vu, iter = 0) {
  // Use 10-digit number range starting with 98 dedicated for load testing: 98XXXXXXXX
  const phoneSuffix = String((vu * 1000 + iter) % 100000000).padStart(8, '0');
  const phone = `98${phoneSuffix}`;

  return {
    name: `Load Candidate VU${vu}`,
    email: `loadtest.vu${vu}.i${iter}.${Date.now()}@adyapan.test`,
    phone: phone,
    college: 'Adyapan Institute of Technology',
    city: 'Bengaluru',
    grad_year: '2027',
    track: 'Full Stack Engineering'
  };
}

/**
 * Generate standard request headers with simulated distributed candidate IP
 */
export function getCandidateHeaders(vu) {
  const ipOctet3 = vu % 250;
  const ipOctet4 = Math.floor(vu / 250) % 250;
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Forwarded-For': `198.51.${ipOctet3}.${ipOctet4}`,
    'X-Client-Type': 'k6-load-generator'
  };
}

/**
 * Generate admin authorization headers
 */
export function getAdminHeaders(adminToken) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${adminToken}`
  };
}

