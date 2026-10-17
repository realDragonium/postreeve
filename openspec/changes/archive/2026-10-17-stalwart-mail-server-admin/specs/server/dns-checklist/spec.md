# Spec Delta

## Purpose

Shows, per mail-server domain, every DNS record the domain needs for receiving, signing and client setup, with values to copy and a live check of what the public DNS currently answers.

## ADDED Requirements

### Requirement: Required records come from the mail server
The system SHALL build a domain's checklist from the zone that Stalwart generates for it, grouping each record as MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, autoconfig, autodiscover, SRV, CAA or other. Each entry SHALL show the record name, type and full value, joined into one string when the zone splits a TXT value.

#### Scenario: Domain with two DKIM keys
- **WHEN** the user opens the checklist of `example.org`, which has RSA and Ed25519 keys
- **THEN** it lists one MX, an SPF record for the domain and one for the mail host, two DKIM TXT records, DMARC, MTA-STS, TLS-RPT, autoconfig, autodiscover and SRV records

#### Scenario: Long DKIM value
- **WHEN** the zone writes an RSA DKIM value as several quoted strings in parentheses
- **THEN** the checklist shows and copies it as one value without quotes or line breaks

### Requirement: Records are verified against live DNS
The system SHALL look up each record's name and type and report it as `ok`, `missing`, `different` (showing what was found) or `error`. TXT records SHALL match when the expected value is among the answers after whitespace normalization; SPF and DMARC SHALL be `different` when a record of that kind exists with another value. MX, CNAME and SRV SHALL compare hosts without a trailing dot and case-insensitively.

#### Scenario: SPF published differently
- **WHEN** DNS has `v=spf1 include:old.example -all` for the domain and Stalwart expects `v=spf1 mx -all`
- **THEN** the SPF entry is `different` and shows the found value

#### Scenario: Record missing
- **WHEN** DNS has no `_dmarc` TXT record
- **THEN** the DMARC entry is `missing`

#### Scenario: Resolver failure
- **WHEN** the lookup times out
- **THEN** the entry is `error` and the other entries are still checked

### Requirement: Resolver choice
The system SHALL resolve through DNS-over-HTTPS by default and SHALL use the system resolver when `POSTREEVE_DNS_RESOLVER=system`. It SHALL send only the record name and type to the resolver.

#### Scenario: System resolver configured
- **WHEN** the server runs with `POSTREEVE_DNS_RESOLVER=system`
- **THEN** checklist lookups use the operating system's resolver and make no DNS-over-HTTPS request

### Requirement: Values can be copied
The UI SHALL offer a copy button for each record's name and value and one for the whole zone in BIND format.

#### Scenario: Copy the zone
- **WHEN** the user clicks Copy zone file
- **THEN** the clipboard holds the zone exactly as Stalwart generated it
