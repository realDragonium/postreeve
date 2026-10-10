## MODIFIED Requirements

### Requirement: Filter the visible list
All, Unread and Flagged filters SHALL apply before pagination to every indexed message in the selected sources. Mutable flags SHALL come from a representative matching location. Confirmed Gmail read and flag changes and their undo SHALL update all locations of the same tenant/account/provider message; IMAP flags SHALL remain location-specific.

#### Scenario: Unread filter
- **WHEN** Unread is selected in a synchronized folder
- **THEN** unread messages beyond the initial 100 messages remain reachable
