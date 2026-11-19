// Copy to config.js and set the Google Sheet ID (the part between /d/ and /edit in the sheet URL).
// config.js is git-ignored; config.example.js is excluded from clasp push (.claspignore).
const SHEET_ID = 'YOUR_SHEET_ID';
// Goong REST API key (account.goong.io) for geocoding ward and order addresses. Keep it out of git.
const GOONG_API_KEY = '';
// Spreadsheet holding sheet export_raw_pending_pu (orders waiting for pick-up, per warehouse). Read only.
const PENDING_PU_SHEET_ID = 'YOUR_PENDING_PU_SHEET_ID';
