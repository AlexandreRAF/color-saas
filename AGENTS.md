# Repository Instructions

These instructions apply throughout the repository. Read any additional
`AGENTS.md` files that apply to the area being changed before editing it.

## Protected Code

- Do not modify `src/agentic_researcher/` unless the user explicitly asks for
  changes to that component. This includes its code, tests, documentation,
  configuration, and data.
- Broad requests to clean up, refactor, format, or improve the repository do not
  authorize changes to this directory. Scope automated tools accordingly.
- If a task requires a change there without explicit authorization, explain the
  dependency and ask before editing it. Continue any independent, authorized work.

## Working Practices

- Inspect the relevant code, local instructions, and available scripts before
  choosing an implementation.
- Check the working tree before editing. Preserve existing user changes; do not
  revert, overwrite, or restore unrelated files.
- Keep changes focused on the requested outcome. Avoid unrelated refactors,
  dependency upgrades, formatting changes, and generated files.
- Follow established project conventions. Do not introduce a new framework,
  dependency, or abstraction when the existing approach is sufficient.

## Code Quality

- Write readable, maintainable code with clear names and focused functions.
- Use blank lines to separate logical steps. Add comments when they explain
  intent, constraints, or non-obvious behavior rather than restating the code.
- Handle expected failures explicitly and preserve useful error context.
- Keep secrets and credentials out of source code, logs, and committed files.

## Verification and Handoff

- Run the relevant checks provided by the affected component. Do not assume
  that repository-wide build, lint, or test commands exist.
- For behavior changes, add or update tests when they provide meaningful
  regression coverage. Documentation-only edits do not require new tests.
- Review the final diff for unintended changes and protected-directory edits.
- Report what changed, which checks ran, and any remaining limitations. If a
  check could not run, state that clearly rather than claiming it passed.
