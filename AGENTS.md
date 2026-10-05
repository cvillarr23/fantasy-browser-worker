# Repository guidance

## README content

Keep README.md focused on repository structure, installation and setup, features,
FAQs, and how-to instructions. Do not include issue numbers, ticket identifiers
(such as WORKER-12 or CORE-14), implementation-history notes, or project-tracking
sections. Describe current behavior directly. Put issue references and change
history in commit messages, PR descriptions, or GitHub issues instead.

## Named numeric constants

Use descriptive named constants for integer values in application logic so their
purpose is clear. This includes validation bounds, calendar indexes and offsets,
timeouts, durations, resource limits, CLI argument indexes/counts, and exit codes.
Include units in names where relevant (for example, NFL_STATE_TIMEOUT_MS), and
explain non-obvious conventions such as zero-based month indexes. Reuse a constant
only when the values have the same meaning, not merely the same numeric value.
SQL parameter placeholders and numeric values in test fixtures are not application
policy constants.

Before submitting changes, check README edits for ticket references and changed
application code for unexplained numeric literals. Run relevant existing tests and
lint for code changes; documentation-only guidance changes do not need new tests.
