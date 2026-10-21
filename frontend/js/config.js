// Frontend runtime configuration.
// This is the browser-readable equivalent of frontend/.env — edit the values
// here for your deployment. Loaded before all other scripts.
window.APP_CONFIG = {
  // Empty = same origin as the page (backend serves this frontend).
  // Set to a full URL (e.g. "https://aspire.adyapan.com") if the UI is hosted
  // separately from the API.
  API_BASE_URL: '',

  // Branding (UI only; the authoritative brand lives in the backend config too)
  BRAND_NAME: 'Adyapan',
  ACCENT_COLOR: '#F97316'
};
