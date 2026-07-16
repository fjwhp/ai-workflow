# Change-Aware Integration Tests Design

## Goal

Make `应用到本地工作区` automatically select verification commands from the files changed by the current requirement, without requiring users to edit a project-wide fixed module command.

## Current Problem

Projects currently store a fixed `allowedCommands` list. Soto Dine is configured to test `dine-product-service`, so a requirement that changes `dine-admin-service` applies successfully but runs an unrelated module test. Multi-module repositories cannot use one fixed module command for every requirement.

## Strategy

Use a deterministic hybrid selector:

1. Read the verified coding evidence file list.
2. Detect the repository build system from tracked root files.
3. Map changed paths to the nearest build module descriptor.
4. Generate safe module-scoped verification commands.
5. Include compatible successful verification commands recorded by the coding execution when available.
6. Deduplicate commands and execute them after applying changes.
7. Fall back to a safe repository-level command only when module detection cannot produce a command.

Project `allowedCommands` becomes a command policy and optional fallback, not a mandatory list executed for every requirement.

## Maven Selection

For a repository containing a root `pom.xml`, walk from each changed file toward the repository root and select the nearest directory containing a tracked `pom.xml`.

Generate one command per distinct changed module:

```text
mvn test -pl <root-relative-module-path> -am
```

If a root-level Maven file or an aggregator configuration changes, use the repository fallback command. Multiple files in the same module produce one command.

For the current REQ-0001 changes under `dine-service/dine-admin-service`, the selected command is:

```text
mvn test -pl dine-service/dine-admin-service -am
```

## Other Build Systems

- npm workspace: select the nearest package and run its declared `test` script through `npm test -w <workspace>`.
- Gradle multi-project: use the nearest project path when it can be derived from settings; otherwise use the configured fallback.
- Unknown build system: execute the configured safe fallback command and explain that automatic module detection was unavailable.

The first implementation prioritizes Maven because Soto Dine is Maven-based. npm and Gradle selection remain explicit extension points and must not be guessed when metadata is insufficient.

## Coding Command Reuse

Only reuse commands that:

- completed successfully during the latest matching coding execution;
- use an approved executable such as `mvn`, `npm`, or `gradle`;
- operate inside the linked repository or its requirement worktree;
- contain no shell operators or embedded command strings;
- still correspond to a changed module.

If coding execution command evidence is absent, module inference is sufficient.

## Safety

Commands are represented as executable plus argument arrays and executed without a shell. The selector never executes model-generated free-form shell text. Executables and argument shapes are validated against deterministic templates. Existing project fallback commands remain subject to the same command policy.

## User Interface

Before confirmation, the integration panel shows the detected changed modules and planned commands. After execution, it shows each command, exit code, and output. If tests fail, staged changes remain in the target worktree and the user can rerun tests or use the existing human override path.

## API

The integration preflight response adds:

- `changedModules`
- `plannedCommands`
- `commandSource`: `coding_evidence`, `module_inference`, or `project_fallback`

The integrate endpoint recalculates the plan immediately before applying changes rather than trusting browser-supplied commands.

## Failure Handling

- Module detection failure: use a configured safe fallback and show the reason.
- No safe command available: block application before changing the target worktree and show that the project needs a fallback command.
- Verification failure: keep staged local changes, mark `merge_test_failed`, and show the precise failing command.
- Retry: recompute the verification plan from the same coding evidence and current repository metadata.

## Tests

Cover:

- Maven files mapping to the nearest changed module;
- multiple files in one module producing one command;
- multiple modules producing deduplicated commands;
- root build changes selecting the fallback;
- unrelated fixed project module commands not overriding detected modules;
- unsafe or failed coding commands not being reused;
- preflight returning the command plan;
- integration executing the calculated commands;
- UI displaying planned modules and commands.
