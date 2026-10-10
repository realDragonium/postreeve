## ADDED Requirements

### Requirement: Sent copies use bounded IMAP timeouts
Saving a Sent copy SHALL give up when no usable IMAP connection is established within 30 seconds or when the server sends nothing for 60 seconds, and SHALL report that as a Sent copy failure.

#### Scenario: Stalled IMAP server
- **WHEN** the IMAP server stops responding while the Sent copy is appended
- **THEN** the send completes after the inactivity timeout with the Sent-copy warning, and a sent draft stays `sent`
