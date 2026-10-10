# Spec Delta

## ADDED Requirements

### Requirement: Unsubscribe options are parsed while reading
Each message detail SHALL carry `unsubscribe` when its `List-Unsubscribe` header names at least one usable target: `{ https, mailto, oneClick }`, where `https` is the first `https:` URI or null, `mailto` the first `mailto:` URI or null, and `oneClick` is true only when `https` is set and `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`. URIs with other schemes, including `http:`, SHALL be ignored. Without a usable target the field SHALL be absent.

#### Scenario: One-click header
- **WHEN** a message has `List-Unsubscribe: <mailto:leave@example.test>, <https://example.test/u/1>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- **THEN** its detail has `unsubscribe` `{ https: "https://example.test/u/1", mailto: "mailto:leave@example.test", oneClick: true }`

#### Scenario: Plain http link only
- **WHEN** a message's only `List-Unsubscribe` target is `<http://example.test/u>`
- **THEN** its detail has no `unsubscribe`
