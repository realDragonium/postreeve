## ADDED Requirements

### Requirement: Reader previews image attachments
For an expanded message, the reader SHALL show image attachments whose media type is PNG, JPEG, GIF, WebP, AVIF or BMP inline below the attachment list, scaled to the reader width, loading up to 8 images of at most 10 MB each on its own and offering **Preview** for the others. SVG and other types SHALL NOT be previewed. A failed preview SHALL show the server's error as an alert.

#### Scenario: Photo attachment
- **WHEN** a person opens a message with a 200 KB `image/png` attachment
- **THEN** the image appears below the attachment list and **Download** still saves the file

#### Scenario: SVG attachment
- **WHEN** a message carries an `image/svg+xml` attachment
- **THEN** the reader offers only **Download** for it

### Requirement: Reader previews PDF attachments
A PDF attachment SHALL offer **Preview**, which opens the file, typed `application/pdf`, in a new browser tab.

#### Scenario: PDF preview
- **WHEN** a person selects **Preview** for a PDF attachment
- **THEN** a new tab opens showing the PDF

### Requirement: Previews stay inside the existing isolation
Attachment previews SHALL load bytes only through the attachment download endpoint, SHALL NOT use frames, and SHALL NOT require a change to the server's Content Security Policy.

#### Scenario: Preview under the current policy
- **WHEN** an image preview renders under `img-src 'self' data: blob: http: https:` and `frame-src 'none'`
- **THEN** it displays from a `blob:` URL without a policy violation
