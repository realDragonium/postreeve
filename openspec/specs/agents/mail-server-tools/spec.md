# agents/mail-server-tools Specification

## Purpose
Defines what an agent may read about a connected mail server through the shared agent tool layer, and how it proposes server changes that only the owner can approve and apply in the Postreeve UI.

## Requirements

### Requirement: Read-only mail server tools
The shared agent tool definitions SHALL include `list_mail_servers`, `list_mail_server_domains`, `check_mail_server_dns` and `inspect_mail_server_queue`, all with `readOnlyHint: true` and strict JSON Schema inputs. They SHALL return server names, URLs, domains, mailbox counts, DNS checklist statuses and queue summaries, and MUST NOT return credentials, app passwords, private keys or message contents.

#### Scenario: DNS health
- **WHEN** an agent calls `check_mail_server_dns` for `example.org`
- **THEN** it receives each required record with its status, and no secret

#### Scenario: Queue status
- **WHEN** an agent calls `inspect_mail_server_queue`
- **THEN** it receives each queued message's sender, recipient addresses, statuses, retry count and last error, without message bodies

### Requirement: Agents propose mail server changes
The shared agent tool definitions SHALL include `propose_mail_server_change`, which stores a proposal holding a title and a list of typed operations (add or remove a domain, mailbox, alias, catch-all, mailing list or DKIM key, change a quota, display name or spam setting, retry or cancel a queued message). It SHALL validate each operation's shape and SHALL NOT change anything on the mail server.

#### Scenario: Agent prepares a mailbox
- **WHEN** an agent proposes creating `carol@example.org`
- **THEN** the proposal is stored as `pending` and Stalwart has no new mailbox

#### Scenario: Agent supplies a password
- **WHEN** an agent's proposed mailbox operation includes a password
- **THEN** the tool rejects the input, because the owner sets passwords at approval time

### Requirement: Only the owner approves a mail server proposal
Pending mail server proposals SHALL be listed in the Mail server area. Only the human-facing UI SHALL approve one, which applies its operations in order and records each result; an operation that fails SHALL stop the remaining ones. No agent tool SHALL approve, apply or edit the status of a proposal. The owner SHALL be able to reject a proposal.

#### Scenario: Owner approves
- **WHEN** the owner approves a proposal to add domain `example.net` and mailbox `carol@example.net` and enters Carol's password
- **THEN** both are created on Stalwart and the proposal is `applied` with two `ok` results

#### Scenario: No agent path to approval
- **WHEN** an agent lists every mail server tool
- **THEN** none approves, applies or rejects a proposal

### Requirement: Destructive proposals need typed confirmation
Approving a proposal that removes a domain or mailbox SHALL require the owner to type each such domain name or address in the UI, as the direct delete does.

#### Scenario: Proposal deletes a mailbox
- **WHEN** the owner approves a proposal containing "delete mailbox `old@example.org`" without typing that address
- **THEN** approval fails and nothing on the proposal is applied
