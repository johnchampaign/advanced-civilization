// App-unique category stamped on every Advanced Civilization problem report.
// The reports backend (the shared dbf_reports table) is used by several fan
// ports at once, so the daily triage filters on `?category=advciv` to see ONLY
// this game's reports. Keep this distinct from the framework's generic
// 'game'/'crash' defaults, which collide with the other ports.
export const REPORT_CATEGORY = 'advciv';
