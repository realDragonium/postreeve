# Spec Delta

## MODIFIED Requirements

### Requirement: Compose From follows the receiving identity
For reply, reply-all and forward forms, From SHALL default to the first of the source's Delivered-To, To and Cc addresses that belongs to the account (compose/identities), using that exact address, or else the primary address. Reply and reply-all SHALL NOT address any address that belongs to the account. The compose form SHALL disable sending while its From address does not belong to the account.

#### Scenario: Reply to mail delivered to an alias
- **WHEN** a user replies to a message delivered to their identity `sales@example.test` through a catch-all
- **THEN** From is preselected as `sales@example.test` and `sales@example.test` is not a recipient

#### Scenario: Reply to mail delivered through a wildcard
- **WHEN** a user with identity `*@example.com` replies to a message delivered to `newsletter-x@example.com`
- **THEN** From is preselected as `newsletter-x@example.com`, not the primary address

#### Scenario: Saved draft from a removed identity
- **WHEN** a user opens a draft whose identity was removed from the account
- **THEN** the From selector shows that address and Send is disabled until another identity is chosen
