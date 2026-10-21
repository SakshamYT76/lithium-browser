# Lithium Browser

**A privacy-focused, highly customizable Chromium-powered browser.** Lithium is an original project name and implementation. The 0.2.0 source milestone uses Electron's embedded Chromium runtime to establish a real desktop browser shell and a repeatable Windows release pipeline. It is not yet a direct fork of Chromium or Helium.

> Target milestone: a testable Windows preview before Diwali, **8 November 2026**. A date is a goal, not a promise of production readiness. Security-sensitive browser work still needs testing.

## What is in this source milestone

- Desktop window with tabs, address bar, back/forward/reload, bookmarks, downloads, history, internal new-tab page, and settings UI.
- Search providers: DuckDuckGo, Google, Brave Search, Startpage, Bing, Ecosia, Qwant, Mojeek, and a validated custom HTTPS search template.
- Local `!bang` command resolution, with examples such as `!ytc TechnOGamerz`, plus a searchable command manager and user-triggered updates.
- A 177-entry settings catalog. Entries marked **Available** are exposed as working preferences in this build; entries marked **Planned** are disabled instead of pretending to work. Some engine-level settings need a restart.
- Local-first settings, bookmarks, and history. Lithium does not include an account service or product-analytics endpoint.
- Local tracker-domain filtering, optional DNT/GPC headers, optional removal of common tracking query parameters, permission defaults, and selected data-clearing-on-exit options.
- Hardened Electron renderer configuration: context isolation, sandboxing, and no Node integration in the UI or web pages.
- GitHub Actions workflow that compiles a Windows NSIS installer and portable `.exe` on a Windows runner. Builds are currently unsigned, so Windows may show a SmartScreen warning.

## Current limitations (read before using)

- This is an early preview, not a production-audited browser or a direct Chromium fork.
- This is not a VPN and does not guarantee anonymity or comprehensive fingerprinting protection.
- Third-party cookie filtering in this Electron shell uses request/response header heuristics and is not equivalent to Chromium's full cookie-policy implementation.
- Some advanced preferences are disabled and marked planned. Full extension management, sync, deep fingerprint resistance, an update service, private-window isolation, advanced profile management, and a full Chromium fork are not implemented here.
- The source ZIP includes a smaller fallback shortcut list for offline development. The Windows CI build downloads the current public DuckDuckGo bang directory and fails closed if fewer than 3,000 valid entries are returned. The number of shortcuts changes upstream; the packaged count is shown in the app.
- The executable has not been compiled inside this workspace because the workspace has no access to npm's package registry. The Windows workflow is provided to build it on a GitHub-hosted Windows runner. I have not claimed the installer succeeds until an actual Actions run produces artifacts.

## Build the Windows `.exe` without installing development tools on your laptop

1. Create an empty GitHub repository named `lithium-browser` in your account.
2. Upload the contents of this ZIP to the repository's `main` branch. Keep the `.github/workflows/build-windows.yml` path intact.
3. Open the repository's **Actions** tab and open **Build Lithium for Windows**. A push to `main` starts the workflow automatically.
4. When it finishes successfully, open the run and download `lithium-windows-x64-...` under **Artifacts**. It contains the setup `.exe` and portable `.exe`.

The workflow runs tests, downloads/validates the command library, and then packages the application. If the public source is unavailable or returns an unexpectedly small set, the job stops rather than claiming a 3,000+ command library was included.

## Developer commands

Requires Node.js 22+ and a Windows build environment for Windows artifacts.

```bash
npm install
npm test
npm start
npm run fetch-bangs
npm run package:win
```

For an offline UI/source smoke test that uses the included fallback bang list:

```bash
npm run package:win:offline-seed
```

Do not use the offline-seed build for a release advertised as having 3,000+ commands.

## App data

Settings, bookmarks, browsing history, download metadata, and a manually refreshed bang directory are stored in Electron's user-data folder. The app does not silently send those files to a Lithium server. Browsing a page or using a search provider necessarily sends requests to the site/provider you chose.

## Search commands

Examples:

```text
!yt TechnOGamerz
!ytc TechnOGamerz
!gh electron
!w privacy
!r browser settings
```

The `!bang` syntax originates from the broader search-shortcut convention. The first build does not copy Helium's source code. The release script consumes DuckDuckGo's public `bang.js` directory and keeps only entries with valid HTTP(S) destinations. Review upstream terms and current licensing before redistributing any imported data as a separate public dataset.

## Project roadmap

1. **First preview:** make Windows packaging reproducible, validate navigation, tabs, settings, local command search, bookmarks, history, and downloads.
2. **Hardening:** exercise renderer isolation, permission gates, downloads, clear-on-exit behavior, and request filtering on real sites.
3. **Privacy and usability:** correct third-party-cookie behavior, add per-site controls and better page information, test layout/performance across screen sizes.
4. **Release polish:** branding/versioning, installer tests, source/licence review, and release notes.

Before a public release, test on clean Windows 10/11 machines. Do not describe the browser as fully anonymous or security-audited without independent evidence.

## Contributing and security

See [SECURITY.md](SECURITY.md) for responsible issue reporting and [LICENSE](LICENSE) for the license of original Lithium project code. Chromium, Electron, and imported command data retain their own licenses and notices.
