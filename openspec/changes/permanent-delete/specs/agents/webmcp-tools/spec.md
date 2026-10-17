## ADDED Requirements

### Requirement: No permanent delete tool
No WebMCP tool SHALL delete a message permanently or empty a folder, and `apply_message_actions` SHALL NOT accept an action that does. Permanent deletion requires a human confirmation in the UI.

#### Scenario: Tool list inspected
- **WHEN** the registered tools and their input schemas are inspected
- **THEN** none can permanently delete mail or empty a folder
