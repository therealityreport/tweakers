# Accounts

`co.tweakers.account-switcher` 0.10.1 revises the existing Accounts feature with
quota-based routing, automatic safe failover, native remote pairing, and pooled
or selected-account activity. The menu follows the upstream subscription-router
layout while retaining Tweakers setup and recovery controls.

## Routing and history

- Account lists use masked emails and show the actual subscription count.
- Empty native routing records do not produce missing-history or peer warnings.
  Peer activity requires another connected renderer with an active turn on that
  conversation. Confirmed earlier gaps remain visible after later successful work.

- Save, rename, enable, disable, or reconnect subscriptions through native sign-in.
  Credentials stay in each account's own home.
- New work uses fresh available quota. Weekly capacity comes first, followed by
  short-window capacity, reset timing, and assignment tie-breakers. Manual mode
  keeps the selected account. Disabled, signed-out, depleted, or unhealthy
  accounts do not receive new work.
- Old `balanced_tokens_v1` settings migrate to `quota_aware_v2`. Existing token
  ledger data remains available for recovery; equal-token balancing is retired.
- Failover defaults to **Automatic**. **Ask first** holds a safe continuation
  for a deliberate decision. Active or uncertain requests are never replayed.
- Native continuation resumes the same conversation ID only after the native
  writer lock and destination resume prove the transfer. Unsupported or ambiguous
  transfer cannot silently create a different conversation.
- An actual conflicting writer blocks the affected thread. Unrelated work can
  continue. One desktop at a time is sufficient; concurrent desktops are optional.

## Settings and capabilities

The signed native source account supplies shared defaults independently of the
routing primary. The manager completes a pending donor migration during a natural
idle launch. A busy target postpones it before scanning plugins or writing files;
interrupted migration must recover before launch. Existing account-specific settings
and capability files become explicit local overrides. Missing shared definitions
can inherit; edits made after a child closes are captured before its next start.
Unknown configuration and authentication remain local. Native home changes
require an absent account child and repeated clean writer observations.

The Accounts UI shows Apps, Plugins, MCP connections, Skills, plan and quota,
reset credits, profile activity, and account health. Profile activity can show
one account or the enabled pool, with partial and unavailable data labeled.
Provider-supported MCP sign-in stays local to the chosen account. Reset-credit
redemption requires an explicit request; routing never redeems a credit itself.
Verified desktop builds expose named native slots for the account menu, Profile,
Apps, Plugins, MCP, Usage, and task ownership. Each slot captures its own account
selection and generation, so a late response cannot render under another
subscription. An unavailable or changed compatibility receipt leaves the
original native surface in place.

## Remote access

Native remote controls support enable/disable, pairing codes, pairing status,
paired-device listing, and revocation. Account authentication and device IDs stay
out of the renderer. An optional unified catalog projects native history for
remote access using the same writer-lock and provenance checks. Remote mode must
settle before desktop writing resumes on that account.

## Desktop continuity and activation

The managed launch flow merges supported sidebar and presentation settings while
the outgoing app is idle. Native task references require proven unchanged IDs.
Conflicting changes are reported instead of resolved by timestamps. Running apps
postpone the merge without forcing a restart.

If **Account setup is incomplete** appears, use **View setup steps**. Preparing
source code does not publish the missing registration. Final activation prepares
both candidates, waits for an authorized maintenance window, registers the
existing homes, prepares native locks and settings, and verifies each desktop in
sequence. Bulk history adoption is not required for native in-place history.

Usage Limit Resets Tracker remains the owner of observed usage/reset history.
Upstream attribution is in [the retained MIT license](../../docs/accounts-upstream-LICENSE.txt).
