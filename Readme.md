# Universal Page Flight Recorder

A browser userscript for recording and analyzing browser navigation flows across
multiple pages, redirects, clicks, DOM changes, and dynamically generated
navigation paths.

The recorder is designed for **observability and debugging**. It captures what
the browser actually does without modifying cookies, sessions, countdowns, or
protected page state.

## Features

- Cross-page navigation recording
- Automatic navigation detection
- Click-to-navigation correlation
- Per-click lifecycle tracking
- Same-page DOM-change detection
- Navigation chain reconstruction
- Click outcome classification
- Resource observation
- DOM mutation observation
- Page snapshots
- URL and domain tracking
- Recorder-owned DOM isolation
- Clean recorder telemetry
- JSON recording export
- Navigation/click chain export
- Persistent recording across normal document navigations
- Handles rapid successive clicks without losing pending click state

## Click Outcome Types

Each observed click can be classified as:

```text
navigated
same-page-dom-change
no-navigation
popup-new-tab