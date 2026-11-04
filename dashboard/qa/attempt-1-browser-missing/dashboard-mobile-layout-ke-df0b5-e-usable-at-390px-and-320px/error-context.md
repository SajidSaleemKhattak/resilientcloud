# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard.spec.ts >> mobile layout keeps navigation, telemetry and saved trial table usable at 390px and 320px
- Location: tests/dashboard.spec.ts:149:1

# Error details

```
Error: browserType.launch: Executable doesn't exist at /Users/sajid/Projects/resilientcloud/.cache/playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```