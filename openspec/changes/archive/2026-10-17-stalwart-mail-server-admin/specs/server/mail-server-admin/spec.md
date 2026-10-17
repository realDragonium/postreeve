# Spec Delta

## Purpose

Lets the owner run their Stalwart Mail Server from Postreeve: connect it, then manage domains, mailboxes, aliases, catch-all addresses, mailing lists, DKIM keys, the delivery queue, received reports and the main spam settings, and turn new mailboxes into Postreeve accounts.

## ADDED Requirements

### Requirement: Connect a Stalwart server
The system SHALL let the user connect a Stalwart server by name, admin base URL and either an API key or an admin username and password. Before saving, it SHALL fetch the JMAP session and run a domain query with that credential, and SHALL save nothing if either fails. The admin URL MUST use `https`, except for loopback, private-network (including single-label names such as a Docker service) or Tailscale (`100.64.0.0/10`, `*.ts.net`) hosts, which may use `http`.

#### Scenario: Valid API key
- **WHEN** the user connects `https://mail-admin.example.ts.net` with a working API key
- **THEN** the server is saved and listed with its domain count

#### Scenario: Wrong credential
- **WHEN** Stalwart answers 401 to the session request
- **THEN** the request fails with `Stalwart rejected the admin credential` and nothing is stored

#### Scenario: Plain HTTP to a public host
- **WHEN** the user enters `http://mail.example.com`
- **THEN** the request fails before any connection with a message that the admin URL must use HTTPS

#### Scenario: IP address as mail hostname
- **WHEN** the user enters `203.0.113.5` as the mail hostname
- **THEN** the request fails with a message to use the server's hostname, because IMAP and SMTP TLS need a name

#### Scenario: Server that is not Stalwart 0.16 or later
- **WHEN** the session lacks the `urn:stalwart:jmap` capability
- **THEN** the request fails with a message naming Stalwart v0.16 as the minimum version

### Requirement: Mail server credentials never leave the server
The system SHALL keep the admin credential only in the encrypted vault and MUST NOT return it in any API response, log line, error message or agent tool result. The user SHALL be able to replace the credential or disconnect the server; disconnecting SHALL remove the stored credential and pending proposals for that server and SHALL NOT change anything on Stalwart.

#### Scenario: Listing servers
- **WHEN** the UI lists connected servers
- **THEN** each entry shows name, URL, credential kind and mail hostname, and no secret

#### Scenario: Disconnect
- **WHEN** the user disconnects a server
- **THEN** its record and credential are deleted and Stalwart still has every domain and mailbox

### Requirement: Manage domains
The system SHALL list the server's domains with their enabled state, catch-all address and DKIM management mode, and SHALL let the user add a domain by name. A new domain SHALL use Stalwart's automatic DKIM management so Stalwart generates its signing keys.

#### Scenario: Add a domain
- **WHEN** the user adds `example.net`
- **THEN** Stalwart has the domain and its DKIM keys appear in the domain's DKIM list once Stalwart has generated them

#### Scenario: Duplicate domain
- **WHEN** the user adds a domain Stalwart already has as a name or alias
- **THEN** the request fails with Stalwart's reason and nothing changes

### Requirement: Deleting a domain needs typed confirmation
The system SHALL delete a domain only when the request carries the domain name typed again. It SHALL refuse while mailboxes or mailing lists still use the domain, naming how many, and otherwise SHALL remove the domain's DKIM keys and then the domain.

#### Scenario: Confirmation does not match
- **WHEN** the user confirms deletion of `example.net` by typing `example.ne`
- **THEN** the request fails and the domain still exists

#### Scenario: Domain still has mailboxes
- **WHEN** the user confirms deletion of a domain that has two mailboxes
- **THEN** the request fails with a message that 2 mailboxes still use the domain

#### Scenario: Empty domain
- **WHEN** the user confirms deletion of a domain with no mailboxes or lists
- **THEN** its DKIM keys and the domain are removed from Stalwart

### Requirement: Manage mailboxes
The system SHALL list a domain's mailboxes with address, display name, aliases, quota and used storage, and SHALL let the user create a mailbox (local part, display name, password, optional quota), change its display name and quota, and reset its password. The password SHALL be sent to Stalwart once and MUST NOT be stored by Postreeve.

#### Scenario: Create a mailbox
- **WHEN** the user creates `alice` on `example.org` with display name `Alice` and a 1 GiB quota
- **THEN** Stalwart has the user `alice@example.org` with that description and a `maxDiskQuota` of 1073741824

#### Scenario: Weak password
- **WHEN** Stalwart rejects the password as insecure
- **THEN** the request fails with Stalwart's reason and no mailbox is created

#### Scenario: Reset password
- **WHEN** the user resets the password of `alice@example.org`
- **THEN** Stalwart replaces the mailbox's password credential and its app passwords keep working

### Requirement: Deleting a mailbox needs typed confirmation
The system SHALL delete a mailbox only when the request carries its full address typed again. Deleting SHALL NOT remove a Postreeve account that uses the mailbox; the UI SHALL say that such an account will stop working.

#### Scenario: Confirmed deletion
- **WHEN** the user types `alice@example.org` to confirm deleting that mailbox
- **THEN** Stalwart removes the account and its mail

#### Scenario: Missing confirmation
- **WHEN** a delete request has no confirmation
- **THEN** the request fails and the mailbox still exists

### Requirement: Manage aliases and catch-all
The system SHALL let the user add and remove alias addresses on a mailbox, on any of the server's domains, and set or clear a domain's catch-all address. A catch-all address MUST be an existing mailbox or mailing list on that server.

#### Scenario: Add an alias
- **WHEN** the user adds `info@example.org` to `alice@example.org`
- **THEN** Stalwart delivers `info@example.org` to Alice's mailbox

#### Scenario: Catch-all to unknown address
- **WHEN** the user sets the catch-all of `example.org` to `nobody@example.org`, which does not exist
- **THEN** the request fails and the catch-all is unchanged

### Requirement: Aliases and catch-all register Postreeve identities
When an alias is added to, or a catch-all is pointed at, a mailbox whose address is a Postreeve account, the system SHALL add the matching send-as identity to that account, using the mailbox display name. A catch-all identity SHALL use the `*@domain` form only when Postreeve's identity model accepts it; otherwise the response SHALL say the identity was skipped.

#### Scenario: Alias on a connected mailbox
- **WHEN** `alice@example.org` is a Postreeve account and the user adds alias `info@example.org`
- **THEN** the account gains identity `info@example.org` and the response lists it as registered

#### Scenario: Mailbox not in Postreeve
- **WHEN** the mailbox has no Postreeve account
- **THEN** the alias is added on Stalwart and no identity is created

### Requirement: Create a mailbox as a Postreeve account in one step
The system SHALL offer, when creating a mailbox, to also add it as a Postreeve IMAP/SMTP account. It SHALL create a Stalwart app password named for Postreeve on that mailbox and use it with the server's mail hostname, IMAP on port 993 and SMTP on port 465 with implicit TLS. Only the app password SHALL be stored, in the vault.

#### Scenario: One-step account
- **WHEN** the user creates `bob@example.org` with "Add to Postreeve" checked
- **THEN** Stalwart has the mailbox and an app password named `Postreeve`, and Postreeve has an IMAP account for `bob@example.org` whose stored credential is that app password

#### Scenario: Account connection fails
- **WHEN** the mailbox is created but Postreeve cannot log in with the app password
- **THEN** the mailbox stays on Stalwart, the app password is revoked, and the response reports the mailbox created and the account not added with the reason

### Requirement: Manage mailing lists
The system SHALL list a domain's mailing lists with address and recipients, and SHALL let the user create a list, change its recipients and delete it.

#### Scenario: Create a list
- **WHEN** the user creates `team@example.org` with recipients Alice and Bob
- **THEN** Stalwart delivers mail for `team@example.org` to both

### Requirement: Manage DKIM keys
The system SHALL list a domain's DKIM keys with algorithm, selector, rotation stage and public key, and SHALL let the user generate an RSA-2048 or Ed25519 key with a selector and remove a key. Postreeve SHALL generate the private key, send it to Stalwart once and MUST NOT store or return it.

#### Scenario: Generate an RSA key
- **WHEN** the user generates an RSA key with selector `pr2026`
- **THEN** Stalwart has a `Dkim1RsaSha256` signature `pr2026` for the domain, and the DNS checklist shows its record

### Requirement: Delivery queue
The system SHALL list queued messages with sender, recipients, per-recipient status, retry count, next retry and last error, and SHALL let the user retry a message now or cancel its delivery. Cancelling SHALL require confirmation in the UI.

#### Scenario: Retry a deferred message
- **WHEN** the user clicks Retry on a message whose recipient failed temporarily
- **THEN** Stalwart schedules the next delivery attempt immediately

#### Scenario: Cancel a message
- **WHEN** the user confirms Cancel on a queued message
- **THEN** Stalwart removes it from the queue

### Requirement: Received DMARC and TLS reports
The system SHALL list the DMARC aggregate and TLS reports Stalwart received, newest first, with sender, subject, received date and a pass/fail summary of the records they contain.

#### Scenario: DMARC report with failures
- **WHEN** a report covers 10 messages of which 2 failed DKIM and SPF alignment
- **THEN** the list shows the reporter, the date range and `8 pass · 2 fail`

### Requirement: Spam basics
The system SHALL show and let the user change Stalwart's spam filter switch and the spam, reject and discard score thresholds, and SHALL let the user add and remove trusted and blocked sender domains, asking Stalwart to reload after each change so it takes effect. A threshold of 0 SHALL mean that action is off. Lists SHALL be returned complete however long they are.

#### Scenario: Raise the spam threshold
- **WHEN** the user sets the spam threshold to 6
- **THEN** Stalwart's spam settings have `scoreSpam` 6 and the other settings are unchanged

#### Scenario: Stalwart cannot apply the change
- **WHEN** Stalwart stores the new threshold but refuses to reload its settings
- **THEN** the request fails with a message that the change is saved but not yet applied, naming Stalwart's reason

#### Scenario: Block a domain
- **WHEN** the user adds `spam.example` to blocked domains
- **THEN** Stalwart's blocked-domains list contains it

### Requirement: Stalwart errors are reported plainly
The system SHALL turn a Stalwart method or set error into a 4xx response that keeps Stalwart's description and names the object that failed. A network failure or timeout (15 seconds) SHALL report that the mail server is unreachable.

#### Scenario: Unreachable server
- **WHEN** the admin URL does not answer within 15 seconds
- **THEN** the request fails with `Mail server is unreachable` and the server name
