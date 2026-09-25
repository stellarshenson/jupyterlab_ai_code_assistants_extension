# Contributing

## Development install

Note: You will need Node.js to build the extension package.
You may install it from [nodejs.org](https://nodejs.org/en/download). We
recommend using the latest LTS version of Node.js.

The project `Makefile` owns the build lifecycle: it cleans, builds the
wheel and installs it, and bumps the patch version on every `make install`. Do not run
`pip`, `jlpm build`, `jupyter-builder` or `npm` by hand.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlab_ai_code_assistants_extension directory

# Build and install the extension (run again after every change)
make install

# List every target
make help
```

## Development uninstall

```bash
make clean      # remove build artefacts
make mrproper   # remove build and venv artefacts
```

## Endpoint authentication

Every verb method of every handler must carry a `@tornado.web.authenticated`
decorator, or, if the endpoint is meant to be public, an explicit
`@allow_unauthenticated`/`@ws_authenticated` decorator from
`jupyter_server.auth.decorator`. The `build` workflow enforces this by running:

```sh
python .github/scripts/check_auth.py
```

## Testing the extension

### Server tests

This extension is using [Pytest](https://docs.pytest.org/) for Python code testing.

The Makefile does not install the `test` extra (`pytest`, `pytest-asyncio`, `pytest-cov`, `pytest-jupyter[server]`); install it once on the interpreter with `pip install -e ".[test]"`. Then run:

```sh
make test
```

or, for one runtime only, `pytest -vv -r ap --cov jupyterlab_ai_code_assistants_extension`.

#### Frontend tests

This extension is using [Jest](https://jestjs.io/) for JavaScript code testing.

To execute them, execute:

```sh
jlpm test
```

### Integration tests

This extension uses [Playwright](https://playwright.dev/docs/intro) for the integration tests (aka user level tests).
More precisely, the JupyterLab helper [Galata](https://github.com/jupyterlab/jupyterlab/tree/master/galata) is used to handle testing the extension in JupyterLab.

More information is provided within the [ui-tests](./ui-tests/README.md) README.

## Packaging the extension

See [RELEASE](RELEASE.md)
