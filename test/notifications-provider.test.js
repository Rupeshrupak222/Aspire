// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS PROVIDER TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-prov-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { getEmailProvider, setEmailProvider, resetEmailProvider, sendEmail, getProviderStatus } = require('../backend/src/services/notifications/email.service');
const { MockEmailProvider } = require('../backend/src/services/notifications/providers/mock.provider');
const { ResendEmailProvider } = require('../backend/src/services/notifications/providers/resend.provider');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 23: NOTIFICATIONS EMAIL PROVIDER TEST SUITE');
  console.log('====================================================\n');

  try {
    console.log('--- 1. Provider Selection & Fallback ---');
    resetEmailProvider();
    const provider = getEmailProvider();
    ok('Default provider in test mode is MockEmailProvider', provider instanceof MockEmailProvider);
    ok('Mock provider isConfigured() is true', provider.isConfigured() === true);

    const status = getProviderStatus();
    ok('Safe provider status returned', status.provider === 'mock');
    ok('Provider status reports ready', status.isReady === true);
    ok('Provider status reports mock mode', status.isMock === true);
    ok('Sender name is present', Boolean(status.senderName));
    ok('Sender address is present', Boolean(status.senderAddress));

    console.log('\n--- 2. Mock Email Transmission ---');
    const mock = new MockEmailProvider();
    setEmailProvider(mock);

    const result = await sendEmail({
      to: 'candidate@example.com',
      subject: 'Test Notification Subject',
      html: '<h1>Welcome to Aspire</h1><p>Test body</p>',
      text: 'Welcome to Aspire\nTest body'
    });

    ok('Send email returns success', result.success === true);
    ok('Provider message ID returned', Boolean(result.providerMessageId));
    ok('Provider recorded message', mock.getSentMessages().length === 1);

    const lastMsg = mock.getLastMessage();
    ok('Recipient email recorded correctly', lastMsg.to === 'candidate@example.com');
    ok('Subject recorded correctly', lastMsg.subject === 'Test Notification Subject');
    ok('HTML body stored', lastMsg.html.includes('Welcome to Aspire'));
    ok('Text fallback stored', lastMsg.text.includes('Welcome to Aspire'));

    console.log('\n--- 3. Error Simulation & Classification ---');
    // Transient failure simulation
    mock.simulateFailure(new Error('Network connection timeout'), 'TRANSIENT');
    let transientCaught = false;
    try {
      await sendEmail({ to: 'student@example.com', subject: 'Ping', html: '<p>Ping</p>' });
    } catch (err) {
      transientCaught = true;
      ok('Transient error flagged as isTransient', err.isTransient === true);
    }
    ok('Transient error thrown', transientCaught);

    // Next call succeeds after one failure
    const recoveryResult = await sendEmail({ to: 'student@example.com', subject: 'Ping', html: '<p>Ping</p>' });
    ok('Provider recovers on subsequent call', recoveryResult.success === true);

    // Permanent failure simulation
    mock.simulateFailure(new Error('Invalid recipient address format'), 'PERMANENT');
    let permanentCaught = false;
    try {
      await sendEmail({ to: 'student@example.com', subject: 'Ping', html: '<p>Ping</p>' });
    } catch (err) {
      permanentCaught = true;
      ok('Permanent error flagged as isPermanent', err.isPermanent === true);
    }
    ok('Permanent error thrown', permanentCaught);

    console.log('\n--- 4. Resend Provider Abstraction Verification ---');
    const unconfiguredResend = new ResendEmailProvider({ apiKey: '' });
    ok('Unconfigured Resend provider isConfigured() is false', unconfiguredResend.isConfigured() === false);

    let resendNotConfiguredErr = false;
    try {
      await unconfiguredResend.sendEmail({ to: 'test@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    } catch (err) {
      resendNotConfiguredErr = true;
      ok('Unconfigured Resend error has code PROVIDER_NOT_CONFIGURED', err.code === 'PROVIDER_NOT_CONFIGURED');
      ok('Unconfigured error is marked permanent', err.isPermanent === true);
    }
    ok('Unconfigured Resend throws expected error', resendNotConfiguredErr);

    const configuredMockResend = new ResendEmailProvider({
      apiKey: 're_test_mock_key_12345',
      fromAddress: 'alerts@test.internal',
      fromName: 'Custom Sender'
    });
    ok('Configured Resend provider isConfigured() is true', configuredMockResend.isConfigured() === true);
    const resendStatus = configuredMockResend.getProviderStatus();
    ok('Resend status senderName matches', resendStatus.senderName === 'Custom Sender');
    ok('Resend status senderAddress matches', resendStatus.senderAddress === 'alerts@test.internal');

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    resetEmailProvider();
    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();

