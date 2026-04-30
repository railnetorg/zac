# install foundry submodules and action dependencies
install:
    git submodule update --init --recursive
    cd action && uv sync --all-groups

# build solidity contracts
contracts-build:
    forge build --sizes

# apply solidity formatting
contracts-format:
    forge fmt

# check solidity formatting
contracts-format-check:
    forge fmt --check

# run solidity tests
contracts-test:
    forge test -vvv

# run action python tests
action-test:
    cd action && uv run --group test pytest -v

# lint action python code
action-lint:
    cd action && uv run --group dev ruff check .

# apply action python formatting
action-format:
    cd action && uv run --group dev ruff format .

# check action python formatting
action-format-check:
    cd action && uv run --group dev ruff format --check .

# type check action python code
action-typecheck:
    cd action && uv run --group dev ty check src/

# audit action python dependencies
action-audit:
    cd action && uv run --group dev pip-audit
