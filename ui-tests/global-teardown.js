/**
 * Clear the scratch HOME, stores and stub binaries once the suite has ended.
 *
 * The matching sweep before the run lives in `webServer.command`: Playwright
 * starts the web server before `globalSetup`, so a setup-time sweep would
 * delete the fixtures the server had already seeded.
 */
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  fs.rmSync(path.join(__dirname, '.scratch'), {
    recursive: true,
    force: true
  });
};
