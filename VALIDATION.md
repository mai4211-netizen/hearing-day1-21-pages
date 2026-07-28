# Validation

- `app.js` passed `node --check` locally.
- `index.html` passed HTML parsing locally.
- Embedded legacy payload extraction was tested with nested objects and escaped quotes.
- The branch is three commits ahead of `main` and contains only `index.html`, `styles.css`, and `app.js` changes.

## Audio behavior

The list tries a human dictionary recording first. If a recording is unavailable for a word or phrase, it falls back to the best matching English voice exposed by the device/browser. This fallback is intentionally labelled in the UI.
