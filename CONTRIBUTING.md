# Contributing to Lithium

1. Explain the user problem before proposing a new setting.
2. Settings that do not have a working effect should be marked planned/disabled until implemented.
3. Keep settings and browsing history on-device unless the user explicitly opts into a documented network service.
4. Avoid silent background network calls. Make directory updates and exports user-initiated.
5. Add tests for the bang parser, URL validation, and setting-value validation when modifying those modules.
6. Run `npm test` before submitting.
7. Do not claim anonymity, complete ad blocking, or a security audit without evidence.
