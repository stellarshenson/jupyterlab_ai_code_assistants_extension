/**
 * Clear the scratch HOME, stores and stub binaries once the suite has ended.
 *
 * The matching sweep before the run lives in `webServer.command`: Playwright
 * starts the web server before `globalSetup`, so a setup-time sweep would
 * delete the fixtures the server had already seeded.
 *
 * The path is this run's alone, keyed by its port (DEF-49). `playwright.
 * config.js` puts the resolved value on the environment it shares with this
 * process; the fallback derives the same path, so a teardown can never sweep a
 * directory a concurrent run is using.
 */
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  const scratch =
    process.env.JLAB_TEST_SCRATCH ||
    path.join(__dirname, '.scratch', process.env.JLAB_TEST_PORT || '8888');
  fs.rmSync(scratch, {
    recursive: true,
    force: true
  });
};
