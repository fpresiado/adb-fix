// ADBPD — test bootstrap (auto-preloaded via bunfig.toml).
//
// Suppress logger output during tests so CI logs stay clean. Tests that need
// to inspect log output can re-enable by setting ADBPD_LOG_LEVEL.

if (process.env.ADBPD_LOG_LEVEL === undefined) {
  process.env.ADBPD_LOG_LEVEL = 'silent';
}
