/**
 * Configuration for Playwright using default from @jupyterlab/galata
 *
 * `JLAB_TEST_PORT` overrides the test server port (default 8888) so the suite
 * runs on machines where 8888 is already taken by a live JupyterLab or
 * JupyterHub. The same value reaches `jupyter_server_test_config.py` through
 * the spawned server's environment, so the config and the command line agree.
 *
 * The server is started from `./.venv`, a dedicated environment holding only
 * JupyterLab and this extension. That is what makes "one panel per provider"
 * an honest assertion: the standalone `jupyterlab_claude_code_extension`,
 * `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` are absent
 * from it, so a duplicate panel can only come from this package. It also keeps
 * the suite from ever installing into, or reading, the developer's live
 * environment. See `ui-tests/README.md` for how to create it.
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

const port = process.env.JLAB_TEST_PORT || '8888';

module.exports = {
  ...baseConfig,
  // The specs share one server and, through it, one set of per-provider
  // session stores; a second worker would toggle settings underneath a spec
  // that is asserting on them.
  workers: 1,
  fullyParallel: false,
  // `globalSetup` runs AFTER the web server, so it cannot prepare the scratch
  // stores - the sweep before start lives in `webServer.command` instead, and
  // this only clears them afterwards.
  globalTeardown: require.resolve('./global-teardown'),
  use: {
    ...baseConfig.use,
    baseURL: `http://localhost:${port}`
  },
  webServer: {
    // `.scratch` holds the fake HOME, the seeded stores and the stub binaries.
    // Swept here so a run never inherits the previous run's sessions.
    command:
      `rm -rf .scratch && ` +
      `PATH="$PWD/.venv/bin:$PATH" jupyter lab --config jupyter_server_test_config.py ` +
      `--port ${port} --ServerApp.port_retries=0`,
    url: `http://localhost:${port}/lab`,
    timeout: 120 * 1000,
    // Never adopt a running lab. The suite drives terminals and session
    // stores, and a developer's live server has neither the stub binaries nor
    // the scratch stores - it has their real assistant history.
    reuseExistingServer: false
  }
};
