# install foundry submodules
install:
    git submodule update --init --recursive

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
