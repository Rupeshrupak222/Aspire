// ============================================================================
// ASPIRE DAY 27: MOCK ALERT PROVIDER (FOR TESTING & LOCAL OBSERVABILITY)
// ============================================================================

class MockAlertProvider {
  constructor() {
    this.sentAlerts = [];
  }

  async sendAlert(alert) {
    this.sentAlerts.push({
      ...alert,
      deliveredAt: new Date().toISOString()
    });
    return { sent: true, mock: true };
  }

  getSentAlerts() {
    return [...this.sentAlerts];
  }

  clearAlerts() {
    this.sentAlerts = [];
  }
}

module.exports = MockAlertProvider;

