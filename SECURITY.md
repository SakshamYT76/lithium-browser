# Security policy

Lithium is an early preview and has not been independently audited. Do not rely on it for high-risk anonymity or sensitive workflows.

## Reporting issues

For a private report, contact the maintainer through the repository's private vulnerability-reporting feature when enabled. Avoid publishing credentials, private URLs, personal data, or exploit details in a public issue.

## Security design notes

- The app UI and web contents use `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- The renderer receives a limited API through `preload.cjs`; it is not handed raw `ipcRenderer` access.
- Navigation from the address bar is restricted to HTTP(S) URLs or known in-app `lithium://` routes.
- Permission requests are denied by default unless a corresponding global preference enables them.
- There is no Lithium analytics endpoint or cloud account service in this source milestone.
- The local tracker list is a small initial list. It is not a substitute for a maintained content blocker.

These measures reduce some risks but do not guarantee that all Electron/Chromium vulnerabilities are absent. Keep dependencies and the Chromium runtime updated, test updates, and review the security notes of each release.
