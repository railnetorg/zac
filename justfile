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

# simulate the Lagoon deployment script against live state; broadcasts nothing
# usage: just forge-simulate-deploy "$ETH_RPC_URL"
# `@` suppresses the recipe echo: <upstream> is a credentialled endpoint.
#
# This covers what a test cannot. `DeployLagoonVaultFork` calls `run()` directly,
# which skips the phase where Foundry simulates the transactions the script would
# broadcast — and that phase is the only thing that catches a non-static call
# placed inside the broadcast block. Such a call becomes a queued transaction, so
# a probe that has to revert fails the entire run rather than checking anything.
# The script is therefore exercised AS A SCRIPT here, not only as a test.
#
# The parameters are placeholders and the salt is distinctive: nothing is
# broadcast, so no state accumulates across runs. `DEPLOYMENT_KEY` is deliberately
# unset, which is what stops the run writing a deployment artifact in CI.
forge-simulate-deploy upstream:
    @cd foundry && \
      DEPLOYER=0x1111111111111111111111111111111111111111 \
      SAFE_OWNERS=0x1111111111111111111111111111111111111111 \
      SAFE_THRESHOLD=1 \
      VAULT_UNDERLYING=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
      VAULT_NAME="ZAC CI simulation" \
      VAULT_SYMBOL=zacsim \
      VAULT_VALUATION_MANAGER=0x1111111111111111111111111111111111111111 \
      DEPLOY_SALT=0x7a61632d63692d73696d756c6174696f6e000000000000000000000000000000 \
      forge script script/DeployLagoonVault.s.sol:DeployLagoonVault --rpc-url "{{upstream}}"

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
