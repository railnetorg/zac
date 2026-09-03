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

# lint solidity contracts
contracts-lint:
    cd foundry && forge lint

# run solidity tests
contracts-test:
    cd foundry && forge test -vvv

# run the forge fork suite (contract + ZAC policy template tests) against an <upstream> RPC
# usage: just forge-test-fork "$ETH_RPC_URL" [threads]
# `@` suppresses the recipe echo: <upstream> is a credentialled endpoint and would
# otherwise be printed verbatim to the terminal and to CI logs.
#
# `threads` maps to `forge test -j`. The default 0 means "one per logical core",
# which is forge's own default — so a plain invocation is unchanged. Pass 1 to
# serialize the test contracts; see the CI workflow for why it does.
forge-test-fork upstream threads="0":
    @cd foundry && \
      FOUNDRY_PROFILE=contracts-fork MAINNET_RPC_URL="{{upstream}}" forge test -vvv -j {{threads}}

# run action ts tests
action-test:
    cd action && bun run test

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
