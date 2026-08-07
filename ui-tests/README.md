# Integration Testing

This folder contains the integration tests of the extension.

They are defined using [Playwright](https://playwright.dev/docs/intro) test runner
and [Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata) helper.

The Playwright configuration is defined in [playwright.config.js](./playwright.config.js).

The JupyterLab server configuration to use for the integration test is defined
in [jupyter_server_test_config.py](./jupyter_server_test_config.py).

The default configuration will produce video for failing tests and an HTML report.

> There is a UI mode that you may like; see [that video](https://www.youtube.com/watch?v=jF0yA-JLQW0).

## Dedicated server environment

The suite starts its server from `ui-tests/.venv`, never from the environment you develop in. The venv holds JupyterLab and this extension and nothing else, so the retired standalone extensions cannot dock a second panel and skew the "one panel per provider" assertions, and no test can touch a live JupyterLab.

Create it once, from the repository root, after `make install` has built the labextension assets:

```sh
python3 -m venv ui-tests/.venv
ui-tests/.venv/bin/pip install "jupyterlab>=4,<5" . jupyterlab-colourful-tab-extension
```

`jupyterlab-colourful-tab-extension` is not optional here despite the `IColourfulTabs` token being optional in the plugin: `package.json` declares it a non-bundled singleton shared package, so its module must be supplied by an installed extension or this extension's plugin fails to load and docks no panels at all.

Verify the isolation:

```sh
ui-tests/.venv/bin/jupyter labextension list
```

`jupyterlab_ai_code_assistants_extension` must be listed `OK`, and `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` must be absent. Never uninstall anything from your own environment to achieve that - a fresh venv gives it for free.

Everything the running server reads or writes is redirected into `ui-tests/.scratch`: the HOME each provider resolves its store from, this extension's state directory, Jupyter's config, data and runtime directories, and a directory of stub assistant binaries at the front of `PATH`. The scratch tree is swept before the server starts (in `webServer.command`) and again in `global-teardown.js`.

## Run the tests

> All commands are assumed to be executed from the root directory

To run the tests, you need to:

1. Compile the extension:

```sh
jlpm install
jlpm build:prod
```

> Check the extension is installed in JupyterLab.

2. Install test dependencies (needed only once):

```sh
cd ./ui-tests
jlpm install
jlpm playwright install
cd ..
```

3. Execute the [Playwright](https://playwright.dev/docs/intro) tests:

```sh
cd ./ui-tests
JLAB_TEST_PORT=8899 jlpm playwright test > run.log 2>&1; echo exit:$?
```

`JLAB_TEST_PORT` moves the test server off 8888, which a live JupyterLab or JupyterHub usually holds; it reaches the `baseURL`, the server command and `jupyter_server_test_config.py` alike. Redirect the output rather than piping through `tee` - a pipe reports the exit status of `tee`, so a suite whose server never started would read as a pass.

Test results will be shown in the terminal. In case of any test failures, the test report
will be opened in your browser at the end of the tests execution; see
[Playwright documentation](https://playwright.dev/docs/test-reporters#html-reporter)
for configuring that behavior.

## Update the tests snapshots

> All commands are assumed to be executed from the root directory

If you are comparing snapshots to validate your tests, you may need to update
the reference snapshots stored in the repository. To do that, you need to:

1. Compile the extension:

```sh
jlpm install
jlpm build:prod
```

> Check the extension is installed in JupyterLab.

2. Install test dependencies (needed only once):

```sh
cd ./ui-tests
jlpm install
jlpm playwright install
cd ..
```

3. Execute the [Playwright](https://playwright.dev/docs/intro) command:

```sh
cd ./ui-tests
jlpm playwright test -u
```

> Some discrepancy may occurs between the snapshots generated on your computer and
> the one generated on the CI. To ease updating the snapshots on a PR, you can
> type `please update playwright snapshots` to trigger the update by a bot on the CI.
> Once the bot has computed new snapshots, it will commit them to the PR branch.

## Create tests

> All commands are assumed to be executed from the root directory

To create tests, the easiest way is to use the code generator tool of playwright:

1. Compile the extension:

```sh
jlpm install
jlpm build:prod
```

> Check the extension is installed in JupyterLab.

2. Install test dependencies (needed only once):

```sh
cd ./ui-tests
jlpm install
jlpm playwright install
cd ..
```

3. Start the server:

```sh
cd ./ui-tests
jlpm start
```

4. Execute the [Playwright code generator](https://playwright.dev/docs/codegen) in **another terminal**:

```sh
cd ./ui-tests
jlpm playwright codegen localhost:8888
```

## Debug tests

> All commands are assumed to be executed from the root directory

To debug tests, a good way is to use the inspector tool of playwright:

1. Compile the extension:

```sh
jlpm install
jlpm build:prod
```

> Check the extension is installed in JupyterLab.

2. Install test dependencies (needed only once):

```sh
cd ./ui-tests
jlpm install
jlpm playwright install
cd ..
```

3. Execute the Playwright tests in [debug mode](https://playwright.dev/docs/debug):

```sh
cd ./ui-tests
jlpm playwright test --debug
```

## Upgrade Playwright and the browsers

To update the web browser versions, you must update the package `@playwright/test`:

```sh
cd ./ui-tests
jlpm up "@playwright/test"
jlpm playwright install
```
