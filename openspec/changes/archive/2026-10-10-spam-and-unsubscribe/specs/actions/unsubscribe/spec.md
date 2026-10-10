# Spec Delta

## Purpose

Lets a person leave a mailing list from the reader using the sender's `List-Unsubscribe` options, always after an explicit human confirmation because unsubscribing is an external side effect.

## ADDED Requirements

### Requirement: Unsubscribe from the reader after confirmation
The reader SHALL show an Unsubscribe control for an expanded message whose detail has `unsubscribe`. Choosing it SHALL open a confirmation dialog that names the method and target: one-click to the HTTPS host when `oneClick` is true, otherwise an email to the `mailto` address with its exact subject and body, otherwise opening the `https` link. Nothing SHALL happen until the person confirms, and cancelling SHALL do nothing.

#### Scenario: Cancel
- **WHEN** a person chooses Unsubscribe and cancels the dialog
- **THEN** no request is made and no mail is sent

#### Scenario: Link only
- **WHEN** a message offers only an `https` link without one-click and the person confirms
- **THEN** the link opens in a new browser tab and the server is not contacted

### Requirement: Unsubscribe request
The system SHALL accept `POST /api/messages/unsubscribe` with `{ message, method }`, where `method` is `one_click` or `mailto`. It SHALL re-read the message from the provider and use only that message's own `List-Unsubscribe` options. When the message lacks the requested method, the system SHALL answer 400 and contact nothing. On success it SHALL answer 200 with `{ method, target }` plus the send `receipt` for `mailto`.

#### Scenario: Method not offered
- **WHEN** a client requests `one_click` for a message whose `oneClick` is false
- **THEN** the response is 400 and no HTTP request or mail is sent

### Requirement: One-click unsubscribe is a guarded HTTPS POST
For `one_click` the server SHALL send `POST` with body `List-Unsubscribe=One-Click` (`application/x-www-form-urlencoded`) to the `https` URI. It SHALL send no cookies or credentials, follow no redirects and time out after 10 seconds. It SHALL refuse a URI without a public-looking DNS hostname: no IP literal, single-label or `.localhost` name, user info or non-default port. Only a 2xx response SHALL count as success; anything else SHALL answer 400 with the status.

#### Scenario: Private target refused
- **WHEN** the one-click URI is `https://127.0.0.1/unsubscribe`
- **THEN** the response is 400 and no request is sent

#### Scenario: Redirect is not followed
- **WHEN** the one-click endpoint answers `302`
- **THEN** the response is 400 and the redirect target is not contacted

### Requirement: Mailto unsubscribe sends from the delivered identity
For `mailto` the system SHALL send a new plain-text message through the normal send path to the URI's single address. The subject SHALL be the URI's `subject` or `unsubscribe`, and the body SHALL be its `body` or `unsubscribe`. The message SHALL be sent from the account's identity the message was delivered to (Delivered-To, then To, then Cc), or else the primary address. A URI with no valid single address, or with a subject or body over 500 characters, SHALL be refused with 400.

#### Scenario: Oversized body
- **WHEN** a list's `mailto` URI carries a 2,000-character `body`
- **THEN** the unsubscribe is refused with 400 and nothing is sent

#### Scenario: Alias subscription
- **WHEN** a person confirms a mailto unsubscribe for a list message delivered to their stored identity `lists@example.test`
- **THEN** the unsubscribe message is sent from `lists@example.test` to the mailto address
