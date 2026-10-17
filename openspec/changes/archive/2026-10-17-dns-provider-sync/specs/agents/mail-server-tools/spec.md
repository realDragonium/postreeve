# Spec Delta

## MODIFIED Requirements

### Requirement: Agents propose mail server changes
The shared agent tool definitions SHALL include `propose_mail_server_change`, which stores a proposal holding a title and a list of typed operations (add or remove a domain, mailbox, alias, catch-all, mailing list or DKIM key, change a quota, display name or spam setting, retry or cancel a queued message, apply a domain's DNS changes). It SHALL validate each operation's shape and SHALL NOT change anything on the mail server or in DNS.

#### Scenario: Agent prepares a mailbox
- **WHEN** an agent proposes creating `carol@example.org`
- **THEN** the proposal is stored as `pending` and Stalwart has no new mailbox

#### Scenario: Agent supplies a password
- **WHEN** an agent's proposed mailbox operation includes a password
- **THEN** the tool rejects the input, because the owner sets passwords at approval time

#### Scenario: Agent proposes DNS changes
- **WHEN** an agent proposes applying the DNS changes of `example.org`
- **THEN** the proposal is stored as `pending`, no DNS record changes, and approving it applies only the changes that are selected by default in the diff
