# Logs

Output of every background or long-running command, teed here rather than left in a terminal. What is present:

- `batch2-*.log`, `batch3-*.log`, `batch4-*.log` - one batch of the implementation workflow per prefix, split by what was run: `build`, `isolated-build`, `jest`, `pytest`, `test`, `galata`
- `make-install-*.log`, `make-test-*.log` - `make install` and `make test` runs, suffixed with the round or defect they were taken for (`r1`, `def9`, `postreview`, `verify`)
- `publish-<version>.log` - the release run that published that version
- `galata-round<N>.log` - the Galata UI run attempted for one review round
- `ui-tests-*.log` - setup of the `ui-tests` environment: venv install and reinstall, the `jlpm` install, the Playwright browser download, and the `jupyterlab_colourful_tab_extension` install the coloured-tab tests need
- `icon-verify-jlab.log` - the JupyterLab server behind the provider-icon screenshots
- `readme-shot-jlab.log` - the JupyterLab server behind the README screenshots
- `waiter-race-sweep.log` - terminal-waiter race sweep: hit counts per waiter variant and per injected delay
- `adversarial/` - devils-advocate adversarial review: seeded prompts (`*-prompt.txt`), round results (`*-roundN.txt`) and mid-round addenda (`*-roundN-addendum.txt`), one series per adversary. A `colour-` or `wholerepo-` prefix names the campaign the series belongs to
- `make-install-launcher*.log`, `make-test-launcher*.log`, `galata-launcher*.log` - the Launcher-tiles builds and gates, one set per review round; `galata-launcher-only.log` is `tests/launcher-tiles.spec.ts` on its own
- `mutation-b1-*.log`, `mutation-b2-*.log` - the two mutated builds the Launcher-tiles Galata tests were severed against, `install` and `galata` per batch
- `repro-server.log`, `repro-galata.log` - the isolation runs that traced the click-through failure to Galata's mock of the terminals API
