# zac

Zodiac Roles V2 config generator (CLI) plus the Foundry contracts that back it.

The repo is being rewritten for ZAC v2: a Bun + TypeScript CLI named `zac` whose
sole command is `generate` (load -> render -> parse -> validate -> emit). See
the spec for full context: <https://www.notion.so/357c1910fb6e80a7b2b8f391ae421040>.

## Layout

- `foundry/` - Solidity contracts (Foundry project: `src/`, `test/`, `script/`, `lib/`).
- `action/` - ZAC CLI (Bun + TypeScript). Coming in Phase 1.

## Commands

```
Available recipes:
    contracts-build        # build solidity contracts
    contracts-format       # apply solidity formatting
    contracts-format-check # check solidity formatting
    contracts-test         # run solidity tests
    install                # install foundry submodules and action dependencies
```

## Usage (host repos)

Add ZAC as a git submodule, then add a script to your host repo's `package.json`:

```
"scripts": {
  "zac": "bun ./submodules/zac/action/cli.ts"
}
```

Then run:

```
bun run zac generate <path/to/deployment.yaml> [--out <output>] [--config <path>]
```

The `generate` command loads, renders, parses, validates and emits a Zodiac
Roles V2 config from a deployment YAML. Errors are reported fail-fast with a
`phase=<load|render|parse|validate|emit>` prefix and (when available) a source
location.
