# User Questions

User Questions adds the canonical `mcp__co_tweakers_user_questions__ask` tool.
It collects a bounded round of task-scoped preferences without turning those
choices into permanent rules.

## What a round supports

- One to six questions; callers should normally group four to six independent,
  currently answerable decisions.
- Two to five listed options per question, with an explicit boolean
  `recommended` marker. Text such as `(Recommended)` is not interpreted as the
  marker.
- A short always-visible `description`, optional longer `details`, and bounded
  `pros`, `cons`, and `gives_up` lists.
- Single- or multi-select answers, optional Other text, and an explicit Skip
  action for every question. Skip is a real answer state, not a missing result.
- Multi-select `max_selections` is enforced by validation, the owned card, and
  the standard form schema; callers can omit it to allow every available choice.
- Back and Edit without losing choices or expanded details, followed by a
  review step before Submit.

Submitted choices guide only the current task. If a later constraint conflicts
with a choice, the agent should explain the conflict, the pros and cons, and
what must be given up, then ask before materially changing direction.

## Drafts and recovery

Cancel or Escape may save a private, task-bound draft. A later call can present
the opaque `resume_token` to offer Resume or Start over. The token is valid only
for the same task route, round ID, and normalized input; it cannot read another
task's draft. Submitted and explicitly discarded drafts are cleared only for
that round. Cancelled drafts expire after 30 days and retention is bounded.

If the enhanced card cannot attach safely, the standard MCP fallback remains
usable one real question at a time. The fallback includes the same explanations
and tradeoffs and produces the same submitted result without ever combining a
whole round into one host form. A task-routing nonce is carried only in an
internal field key; its visible label, description, and choices are always the
first real question, never a marker or checkbox for the user to manage.

If neither path is visibly acknowledged, or the host returns an empty response,
the tool returns `status: "display_failed"`, `retryable: true`, and
`cancel_reason: "question_ui_not_shown"`. The consuming agent should say that
delivery failed and offer a same-task retry. It must not apply recommended
defaults, claim that the user skipped, or silently switch to another prompt
tool. Generic correction is limited to one follow-up form.

A successful result always has `status: "submitted"` and one validated answer
state for every question. Empty submitted results are rejected. User or policy
cancellation returns `status: "cancelled"`; a missing, hidden, or empty host
form returns `status: "display_failed"`. Neither terminal state owns a user
decision.

## Policy controls

The Settings page offers two explicit Full Access-compatible profiles:

- **Maximum access** permits every granular approval category, including MCP
  question forms. This is the default selection.
- **Questions only** permits MCP question forms and rejects sandbox, rules,
  skill, and permission-request approval categories.

Both profiles preserve `dangerFullAccess`; they replace the task-level
`approvalPolicy: "never"` override with an explicit granular policy. The page
then offers Preview, Apply, and Restore commands:

- **Maximum access** permits every granular approval category, including MCP
  question forms. This is the default selection.
- **Questions only** permits MCP question forms and rejects sandbox, rules,
  skill, and permission-request approval categories.

Both profiles preserve `dangerFullAccess`; they replace the task-level
`approvalPolicy: "never"` override with an explicit granular policy. The page
then offers Preview, Apply, and Restore commands:

- A profile row is a proposed Preview choice, not an active-state indicator.
- The page marks a profile as saved only while every transaction target still
  matches the applied policy.
- If the running Codex process rewrites its cached task settings, the page
  reports the transaction as overwritten instead of claiming the profile is
  active.
- Preview is read-only and returns redacted counts and fingerprints.
- Apply requires the matching Preview token and a separate click.
- Restore is a separate explicit action and preserves unrelated later edits.
- Apply and Restore never restart Codex automatically. A required restart is a
  later, separately confirmed action.

Ordinary startup and ordinary question rounds never apply or restore policy.

## Privacy

Question text, option details, answers, Other text, raw task IDs, resume tokens,
and draft contents are excluded from diagnostic logs. Broker and delivery logs
contain only allowlisted status codes and `contentRedacted: true`; unknown host
errors collapse to `request_failed`. The MCP process rejects an unterminated
input line before it can grow beyond its byte budget. Draft, broker,
policy-transaction, and metadata files are private to the current user and use
bounded, fail-closed formats.

See [examples](./examples/README.md) for a rich protocol fixture and source-only
harness. Visual, keyboard, focus, fallback, and host-integration acceptance must
run in a disposable candidate before any separately approved live restart.
