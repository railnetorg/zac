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

# spawn anvil forking <upstream>, run forge tests against it under the fork profile, clean up
# usage: just forge-test-fork https://sepolia-rpc.example
forge-test-fork upstream:
    @bash -c '\
      anvil --fork-url {{upstream}} --port 8546 --quiet & \
      ANVIL_PID=$$!; \
      trap "kill $$ANVIL_PID 2>/dev/null" EXIT; \
      for i in 1 2 3 4 5 6 7 8 9 10; do \
        if curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
          --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}" \
          http://127.0.0.1:8546; then break; fi; \
        sleep 1; \
      done; \
      cd foundry && \
        FOUNDRY_PROFILE=fork RPC_URL=http://127.0.0.1:8546 forge test -vvv && \
        FOUNDRY_PROFILE=contracts-fork RPC_URL=http://127.0.0.1:8546 forge test -vvv \
    '

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
