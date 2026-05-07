# install foundry submodules and action dependencies
install:
    git submodule update --init --recursive
    cd action && bun install

# build solidity contracts
contracts-build:
    cd foundry && forge build --sizes

# apply solidity formatting
contracts-format:
    cd foundry && forge fmt

# check solidity formatting
contracts-format-check:
    cd foundry && forge fmt --check

# run solidity tests
contracts-test:
    cd foundry && forge test -vvv

# run action ts tests
action-test:
    cd action && bun run test

# run action ts forked-chain integration tests (opt-in, requires RPC; spawns anvil)
action-test-fork:
    cd action && bun run test:fork

# lint action ts code
action-lint:
    cd action && bun run lint

# apply action ts formatting
action-format:
    cd action && bun run format

# check action ts formatting
action-format-check:
    cd action && bun run format-check

# type check action ts code
action-typecheck:
    cd action && bun run typecheck

# audit action ts dependencies
action-audit:
    cd action && bun audit
