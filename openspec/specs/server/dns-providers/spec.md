# server/dns-providers Specification

## Purpose
Lets the owner publish a mail server domain's required DNS records at Cloudflare or GoDaddy from Postreeve: connect a provider, review a per-record diff against the DNS checklist, and apply only the changes they confirm, without touching records Postreeve did not create unless asked.

## Requirements

### Requirement: Connect a DNS provider
The system SHALL let the user connect Cloudflare with an API token, or GoDaddy with an API key and secret, by name. Before saving, it SHALL list the provider's zones with the credential and SHALL save nothing if that fails. Credentials SHALL be stored only in the vault and MUST NOT be returned by any API, log line or agent tool.

#### Scenario: Cloudflare token
- **WHEN** the user connects Cloudflare with a token that can read two zones
- **THEN** the provider is saved and listed with those two zones and without the token

#### Scenario: Rejected token
- **WHEN** Cloudflare answers that the token is invalid
- **THEN** the request fails with Cloudflare's reason and nothing is stored

### Requirement: GoDaddy access restrictions fall back to the checklist
When GoDaddy answers 403 to a DNS request, the system SHALL report the provider as unavailable for that domain with a message that GoDaddy limits its production DNS API to some accounts, and the DNS tab SHALL keep offering the copyable checklist.

#### Scenario: Account without API access
- **WHEN** GoDaddy answers 403 `ACCESS_DENIED` while Postreeve reads `example.net`'s records
- **THEN** the plan for `example.net` is `unavailable` with that reason and no change is offered

### Requirement: Plan DNS changes per domain
For a mail server domain, the system SHALL find the connected provider zone that contains it (longest matching zone name) and SHALL list, per required MX, TXT, CNAME and SRV record, whether it is in sync or needs a create or an update, and SHALL list records to delete. Each change SHALL show the record name, type, current value and new value. The plan SHALL carry a fingerprint of the records it was computed from.

#### Scenario: Missing DKIM and different SPF
- **WHEN** the zone lacks the Stalwart DKIM record and has SPF `v=spf1 include:old.example -all`
- **THEN** the plan has a create for the DKIM TXT record and an update of the SPF record to `v=spf1 mx -all`

#### Scenario: No provider holds the domain
- **WHEN** no connected provider has a zone for `example.com`
- **THEN** the plan says so and offers no changes

### Requirement: Postreeve changes only what it created unless the owner ticks a record
The system SHALL record each DNS record it creates. A create, and an update or delete of a record Postreeve created, SHALL be selected by default. An update or delete of a record Postreeve did not create SHALL be offered only unselected and SHALL be applied only when the owner selects it individually. Deletes of records Postreeve did not create SHALL be offered only for records that conflict with a required one, such as an MX pointing at another host or a second SPF record.

#### Scenario: Foreign MX record
- **WHEN** the zone has an MX record to `old-mx.example.net` that Postreeve did not create
- **THEN** the plan offers deleting it unselected, and applying the default selection leaves it in place

#### Scenario: Stale record Postreeve created
- **WHEN** a DKIM record Postreeve created is no longer in the checklist
- **THEN** the plan offers deleting it, selected by default

### Requirement: Apply only confirmed changes from an unchanged plan
The system SHALL apply DNS changes only from the human-facing UI, after the owner confirms the selected changes, and only when the request's fingerprint still matches the provider's current records. It SHALL apply creates and updates before deletes and SHALL report each change's result.

#### Scenario: Records changed since review
- **WHEN** a record in the zone changes between showing the plan and applying it
- **THEN** applying fails with a message to review the plan again and nothing is written

#### Scenario: Apply the default selection
- **WHEN** the owner confirms a plan with two creates and one unselected foreign delete
- **THEN** the two records are created at the provider, recorded as created by Postreeve, and the foreign record stays
