# Browser runtime and CDP handoff

The default engine is Obscura. Chrome is an explicit compatibility option; a missing or incompatible Obscura never silently changes engines. `doctor` checks executable discovery or CDP discovery, and does not claim successful business operation.

## Installation and discovery

Install the official Obscura archive for your OS/CPU from [Obscura Releases](https://github.com/h4ckf0r0day/obscura/releases). Keep the extracted binary and its worker together. The runtime checks an explicit executable path, `JLC_OBSCURA_EXECUTABLE`, `PATH`, and user cache locations. Chrome uses an explicit executable path, `JLC_CHROME_EXECUTABLE`, `PATH`, and standard macOS, Windows and Linux installation locations. No normal Chrome profile is opened or modified.

Supported cache layouts are `~/Library/Caches/jlc-cli/obscura/obscura` on macOS, `~/.cache/jlc-cli/obscura/obscura` on Linux, and `%LOCALAPPDATA%/jlc-cli/obscura/obscura.exe` on Windows. On Windows the user may also put the executable on `PATH`.

The CLI does not download and execute a browser as a hidden side effect. Installation is separate and inspectable. Cross-platform discovery and launch arguments are implemented; only the host environments actually listed in the verification record are accepted as runtime-verified.

## Session ownership and handoff

The runtime launches a detached local broker and a separate browser profile inside the CLI profile directory. The broker holds the upstream CDP WebSocket open between commands. Exiting a CLI command disconnects its client; the broker, browser, exact page target and DOM remain available. `BrowserConnection.targetId` identifies the retained page. If an explicitly requested target has disappeared, connection fails with `BROWSER_TARGET_GONE`; it does not create a replacement page or replay an operation.

The returned HTTP endpoint exposes `/json/version` and a browser WebSocket for ordinary Playwright `connectOverCDP`. Only one downstream CDP client may connect at a time. Another client receives HTTP 409. Release the CLI connection before an Agent acquires the handoff connection, and disconnect the Agent before the CLI resumes. A business task's separate control lease still decides whether writes are authorized. Reconnection itself does not authorize a submission or payment.

Both browser and broker listen on `127.0.0.1`. Remote/public endpoints, credential-bearing URLs, query tokens, redirects to other discovery servers, and browser-origin connections to the broker are rejected. Direct Chrome endpoints can be used explicitly and are only disconnected, never stopped. Direct raw Obscura endpoints are rejected because they cannot retain the same page after disconnect; use the jlc-cli relay endpoint instead.

The broker rejects every `Origin` header, including empty or opaque `null` origins, and browser fetch metadata. Its Host must match the returned loopback endpoint. Native Playwright/Node clients send no Origin and remain supported. Shutdown additionally requires POST and the matching instance token; even a request containing the correct token is rejected when it originates in a web page.

Chrome starts headless by default. Set `JLC_CHROME_HEADLESS=0` before starting an explicitly selected Chrome profile to open a visible, dedicated browser window for a human to complete a CAPTCHA or other verification. If the profile already has a retained broker, stop it first so the launch setting takes effect. The human uses that same page while the task is handed off; the Agent then releases its CDP client before the CLI reconnects and verifies the result. Obscura itself remains headless. A normal website is not permitted to connect directly to the broker as a CDP frontend.

Initialization locks carry a unique owner nonce. Recovery of a proven exited owner uses a permanent election marker for that old nonce and rechecks the owner before removing its lock, so a delayed recovery contender cannot delete a new owner's lock. Locks with missing/legacy ownership metadata are preserved for inspection rather than guessed stale. Do not remove the election markers while provider processes may still be running.

`stopOwnedBrowser(directory)` validates a broker instance marker, asks that broker to terminate the child process it owns, and waits until the broker is gone. Owned Chrome receives a graceful CDP `Browser.close` before bounded signal escalation; this matters because [Node signals terminate Windows processes abruptly](https://nodejs.org/api/child_process.html#subprocesskillsignal). It never kills a PID copied from a state file or sends `Browser.close` to an external browser. Retention lasts until an explicit stop, the browser/broker exits, or the machine restarts; there is no implicit expiration timer.

## Credentials and diagnostics

For owned browser profiles, the CLI saves a private cookie/localStorage snapshot and restores session cookies after browser restart. Chrome also restores saved localStorage in temporary pages whose documents are intercepted and fulfilled locally, with service workers bypassed. Those pages make no website request, run no website scripts and are closed after restoration; recovery therefore does not depend on native profile writes surviving an abrupt stop. Obscura 0.2.3 did not persist late localStorage changes in the tested shutdown path, so its broker restores each saved origin before that origin's page scripts run, then removes the restoration script after the matching navigation. Subsequent logout or storage clearing is not undone by a permanent restore script. Local artifacts use owner-only directories/files (`0700`/`0600` on POSIX); these are private local plaintext, not encrypted exports. On Windows, effective privacy also depends on the inherited user-directory ACL, and must be verified on the installation host.

An explicit external endpoint reuses the browser's live session only. Its `save()` does not export cookies or localStorage into the CLI profile, because the external context may contain unrelated accounts. Local logout does not sign out or clear that external browser.

Live browser stdout/stderr are not copied into normal diagnostics. If the browser exits before CDP startup, `browser-startup.json` records its exit code/signal and a sanitized stderr excerpt with private file permissions. Capture stops at 16 KiB of startup input and the stored/output excerpt is limited to 4 KiB; URL credentials/query/fragment, credential headers and secret assignments are removed. After CDP becomes available, stderr is drained and discarded. The returned page diagnostic snapshot contains a sanitized URL, page state, and a structural element inventory. It excludes element values, page text, HTML, scripts and storage. Generic screenshots are deliberately omitted because they could expose account data or credentials; login QR artifacts are handled explicitly by the login adapter.

Production Chrome retains its sandbox by default. The isolated Ubuntu CI fixtures explicitly set `JLC_CHROME_NO_SANDBOX=1` because hosted-runner user-namespace restrictions can prevent the downloaded Chromium binary from starting. The override only adds `--no-sandbox` on Linux; neither `CI=true` nor a startup failure enables it automatically. This follows the sandbox setting used by the existing Playwright fixture launcher and does not establish a recommended production configuration. See Chromium's [AppArmor user-namespace restrictions](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Obscura protocol compatibility

Current upstream [server implementation](https://github.com/h4ckf0r0day/obscura/blob/main/crates/obscura-cdp/src/server.rs) creates a separate page/V8 context for each WebSocket and tears that context down on disconnect. Consequently, simply leaving `obscura serve` running is insufficient for same-page recovery. The broker keeps one upstream connection alive.

Obscura 0.2.3 also acknowledges `Target.setAutoAttach` without attaching existing targets and does not infer `Target.getTargetInfo` from its flattened session. The broker supplies existing-target attachments and explicit target IDs for those two operations. It does not rewrite website business responses.

Upstream documents incomplete browser APIs and storage-state limitations in [Playwright integration](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Use-with-Playwright.md) and native persistence in [cookies and storage](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Persist-cookies-and-storage.md). A successful CDP connection is not proof that a particular jlc.com workflow is supported.

## Verification on 2026-09-21

Environment: macOS arm64, Node 25.3.0, installed Google Chrome, official Obscura 0.2.3 macOS arm64 rendering archive. Downloaded archive SHA-256: `45653cfad226f1c9b415603a2ed59477fcbd6335c742338ce133c05de0bdd056`. This recorded hash identifies the tested download; it is not an upstream signature verification.

Actual Chrome checks cover a separate CLI process exiting, reuse of the exact target/DOM, rejecting a second CDP client, cookie/localStorage persistence through restart, private file modes, diagnostic redaction, missing-target failure and safe external-browser disconnection. The automated tests are in `tests/browser.test.ts`; set `JLC_TEST_BROWSER=chromium` to use Playwright's installed Chromium in CI.

The restart test deliberately removes Chrome's native Local Storage directory after shutdown, verifies the saved snapshot, then checks restoration before any real request reaches its local fixture server. It also clears storage and reloads to ensure recovery does not reinsert an old login value.

Security regression tests reject untrusted/local/opaque/empty WebSocket origins, credentialed browser-origin shutdown requests, mismatched Hosts, missing or incorrect shutdown tokens, and GET shutdown requests; a subsequent native CDP connection and authorized shutdown still succeed. A deterministic concurrency test pauses an old-owner reader while a replacement owns the lock and verifies that the delayed reader cannot remove the replacement lock.

The automated Obscura fixture test also verifies exact target/DOM retention, cookie/localStorage restoration after process restart, and that clearing storage is not undone on the next navigation.

Actual Obscura checks opened `https://example.com`, read its title and heading, disconnected/reconnected the same `page-1`, and then opened `https://www.jlc.com/`. The expected Chinese PCB homepage title, login navigation and PCB pricing content were readable. This proves public-page navigation and target retention only. It does not prove authenticated login, upload, quote, order submission or payment.

The subsequent real login check on the same version did **not** pass. At `https://member.jlc.com/`, the retained page showed a blank screenshot, an unmounted Nuxt placeholder, no passport iframe and no login buttons even after a fresh navigation completed. The public source response had one body element, while Obscura exposed two body elements; its standalone CLI fetch also returned an empty rendered body. A separate official `passport.jlc.com/window/login` probe could intermittently render login choices and a WeChat iframe element, but repeated probes did not reliably initialize the iframe; raw `Page.getFrameTree` and Playwright both lacked a child browsing context. This is not an omitted Playwright frame event that the relay can safely synthesize. The precise underlying SPA/iframe engine defect remains unresolved. Use an explicitly selected Chrome profile for the currently verified login path; the runtime does not silently replace Obscura or report its blank page as successful login.

Observed limitation: Playwright `page.setContent` using its default `load` wait timed out in Obscura 0.2.3; real navigation with `waitUntil: 'domcontentloaded'` succeeded. This API difference remains documented rather than being reported as site business success.

The [CI baseline at 6a57534](https://github.com/TXyy2023/jlc-cli/actions/runs/35602632946) passed on Windows Server 2025 x64, Ubuntu 24.04.5 x64 and macOS 26.6.2 arm64 with Node 22.12.0 and real Playwright Chromium fixtures. These runners did not install Obscura or use real JLC accounts. See the [acceptance matrix](acceptance.md) for the separate runtime and business evidence boundaries.
