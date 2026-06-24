// App-unique category stamped on every Advanced Civilization problem report.
// The reports backend (the shared dbf_reports table) is used by several fan
// ports at once, so the daily triage filters on `?category=advciv` to see ONLY
// this game's reports. Keep this distinct from the framework's generic
// 'game'/'crash' defaults, which collide with the other ports.
export const REPORT_CATEGORY = 'advciv';

// This deployment's app identifier, stamped server-side onto every report
// (BugReportRow.appId) via GameServerOpts.appId and the standalone-report path.
// It's the framework-level, non-spoofable key for isolating this game's reports
// on the shared backend — triage filters on `?app_id=advanced-civilization`.
// (REPORT_CATEGORY above remains as a secondary, client-set tag.)
export const APP_ID = 'advanced-civilization';
