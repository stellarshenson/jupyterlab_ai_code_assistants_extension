/**
 * Configuration for Playwright using default from @jupyterlab/galata
 *
 * `JLAB_TEST_PORT` overrides the test server port (default 8888) so the suite
 * runs on machines where 8888 is already taken by a live JupyterLab or
 * JupyterHub. The same value reaches `jupyter_server_test_config.py` through
 * the spawned server's environment, so the config and the command line agree.
 *
 * The port is also the run's IDENTITY. Every directory a run owns is a
 * subdirectory named after it - `.scratch/<port>`, `test-results/<port>`,
 * `playwright-report/<port>` - because two suites on one machine must already
 * hold different ports to both start (`port_retries=0`), so a port-keyed path
 * cannot alias. Against the previous literal `.scratch`, a second run's
 * pre-start sweep deleted a live run's fixtures out from under it and cost
 * this campaign three runs (DEF-49); Playwright empties `outputDir` at the
 * start of a run for the same reason. The three parents are the ones
 * `.gitignore` already covers, so nothing new escapes into the tree.
 *
 * The server is started from `./.venv`, a dedicated environment holding only
 * JupyterLab and this extension. That is what makes "one panel per provider"
 * an honest assertion: the standalone `jupyterlab_claude_code_extension`,
 * `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` are absent
 * from it, so a duplicate panel can only come from this package. It also keeps
 * the suite from ever installing into, or reading, the developer's live
 * environment. See `ui-tests/README.md` for how to create it.
 *
 * Isolation from the developer's live Jupyter is set HERE, in the environment
 * the server is spawned with, and not by `jupyter_server_test_config.py`. That
 * file's own `HOME` assignment lands too late: by the time it executes, the
 * app has already built its config search path from the HOME the process
 * started with, so it loads `~/.jupyter/jupyter_lab_config.py` alongside the
 * test config. That is how an unrelated extension's `ModuleNotFoundError`
 * reached this suite's server log - and had that file not raised, its
 * `ServerApp.root_dir` and `terminado_settings` would have quietly replaced
 * the served root and the terminal shell the launch tests exercise, and
 * `~/.jupyter/labconfig/page_config.json` can disable a frontend extension
 * outright.
 */
const path = require('path');
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

const port = process.env.JLAB_TEST_PORT || '8888';

// The run's own scratch tree: the fake HOME, the seeded stores, the stub
// binaries. `global-teardown.js` sweeps this exact path - hand it the resolved
// value rather than have it re-derive one that could differ.
const scratch = path.join(__dirname, '.scratch', port);
process.env.JLAB_TEST_SCRATCH = scratch;

// Galata's default reporter list writes the HTML report to `playwright-report`.
// Rewrite that one entry rather than restating the list, so a change on
// Galata's side still reaches us.
const reporter = baseConfig.reporter.map(entry =>
  Array.isArray(entry) && entry[0] === 'html'
    ? [
        'html',
        {
          ...entry[1],
          outputFolder: path.join(__dirname, 'playwright-report', port)
        }
      ]
    : entry
);

module.exports = {
  ...baseConfig,
  reporter,
  outputDir: path.join(__dirname, 'test-results', port),
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
    // Swept here so a run never inherits the previous run's sessions. The path
    // is this run's alone, so the sweep cannot reach a concurrent run.
    command:
      `rm -rf .scratch/${port} && ` +
      `PATH="$PWD/.venv/bin:$PATH" jupyter lab --config jupyter_server_test_config.py ` +
      `--port ${port} --ServerApp.port_retries=0`,
    url: `http://localhost:${port}/lab`,
    timeout: 120 * 1000,
    env: {
      // HOME is the root every Jupyter search path derives from - config dir,
      // data dir, runtime dir, `labconfig` - and each is resolved before the
      // test config file runs. Set it here and the developer's `~/.jupyter` is
      // out of the search path entirely; set it there and it is already too
      // late. See the header.
      HOME: path.join(scratch, 'home'),
      JLAB_TEST_SCRATCH: scratch
    },
    // Never adopt a running lab. The suite drives terminals and session
    // stores, and a developer's live server has neither the stub binaries nor
    // the scratch stores - it has their real assistant history.
    reuseExistingServer: false
  }
};
