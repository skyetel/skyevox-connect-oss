# SkyeVox Connect

**Classification:** INTERNAL — SkyeVox engineering and operations.

A Skyetel-branded softphone application for SIP over WebSocket calling, available as a web app, Android app, Chrome extension, and desktop application.

## Overview

SkyeVox Connect is a compact, minimal softphone UI designed for use with the SkyeVox-AI PBX platform. It provides browser-based voice calling via SIP.js with WebRTC audio, provisioned automatically via token-based URLs or QR codes. It is also the owned native mobile replacement track for Acrobits Cloud Softphone, with iOS/Android calling, SMS/MMS, and push wakeup moving behind a SkyeVox-controlled Capacitor native bridge.

**Web Phone:** [skyevox.skyetel.ai/connect/](https://skyevox.skyetel.ai/connect/)

## Tech Stack

- **React 19** + **TypeScript** — UI framework
- **Vite 7** — Build tool and dev server
- **SIP.js 0.21** — SIP over WebSocket (WebRTC)
- **Zustand 5** — Lightweight state management
- **Tailwind CSS v4** — Utility-first styling
- **react-i18next** — Internationalization (English + Spanish)
- **Capacitor 6** — Android/iOS native wrapper
- **Electron** — Desktop application (Windows, macOS, Linux)

## Features

### Core Calling
- SIP registration over WSS (WebSocket Secure)
- Outbound and inbound calling
- Dialpad with DTMF in-call support
- Call controls: mute, hold, blind transfer, hangup
- Incoming call screen with answer/reject. While answering, **Connecting call...** replaces the ringing status and Answer is disabled until media negotiation finishes. Allow microphone access if prompted; Reject remains available to cancel. Repeated answer actions share the pending operation instead of starting another SIP acceptance.
- Web/Electron Hold and Resume report success only after SIP acceptance and media negotiation while the same calls remain established; a late response cannot revive an ended call. The native mobile bridge acknowledges SDK initiation, not final SIP/media acceptance.
- Call history with direction indicators (inbound/outbound/missed)

### Enhanced Features (Phase 2)
- Extension directory with registration presence and search. Directory reads authenticate with the configured extension's SIP credentials and remain restricted to its tenant; a PBX console-login cookie is not required. Legacy profiles with a display name in Extension are repaired only when their SIP username supplies a valid numeric extension.
- Visual voicemail (play, delete, transcription)
- Call park and pickup
- 3-way conference calling. From version 4.0.44, the main Hold/Resume control targets both explicitly merged call legs; separate consultations and explicit per-call controls remain independent.
  - Hold blocks both outgoing mixes before requesting PBX Hold on both dialogs. Resume restores the mix only after both media negotiations finish, preserving the caller's existing microphone-mute setting.
  - Partial failures compensate completed changes. Incomplete recovery keeps conference audio isolated and reports an error rather than claiming success.
  - Splitting a held conference leaves the active call held and its microphone isolated until explicitly resumed.
  - Native mobile control targets the captured conference members through the SDK bridge. Desk-phone-hosted conferences remain controlled by the handset; this application change does not reconfigure handset conference behavior.
- Do Not Disturb (DND) with server sync
- Call recording indicator
- Call waiting with hold-and-answer, reject, merge

### Mobile (Phase 3)
- Android APK via Capacitor 6
- iOS app shell via Capacitor 6
- QR code provisioning scanner
- Swipe gestures for answer/reject
- Background audio support
- Deep link handling (`skyevox://` URI scheme)
- Native `SkyeVoxNative` bridge for the liblinphone engine, iOS CallKit, Android Telecom, and default-calling/default-dialer handoff

### Polish & Advanced (Phase 4)
- **Localization** — English and Spanish with auto-detection
- **Accessibility** — ARIA labels, focus traps, keyboard shortcuts (M=mute, H=hold), screen reader announcements, high contrast mode, reduced motion support
- **Call quality metrics** — Real-time MOS score, jitter, packet loss, RTT, bitrate, codec display
- **CRM screen pops** — Configurable webhook for inbound caller lookup with slide-in overlay
- **Auto-update** — Version check with update banner
- **Chrome extension** — Manifest V3 click-to-call with phone number detection
- **Electron desktop app** — System tray, native notifications, auto-start, minimize to tray, deep links
- **SMS/MMS** — Message threads and send surface backed by SkyeVox Connect API endpoints

### Owned Mobile Replacement
- No Acrobits commercial license dependency
- Native mobile SIP/media engine: liblinphone SDK (AGPLv3) per SKY-PRD-SVOX-2026-005, with a self-hosted Flexisip Push Gateway in front of Kamailio
- iOS default-calling eligibility path through CallKit/Apple entitlement setup
- Android Telecom/default-dialer eligibility path
- APNs/FCM push wakeup path for mobile network changes and suspended inbound calls
- SkyeVox backend integration for Skyetel SMS/MMS without exposing carrier credentials to the app

See `docs/acrobits-replacement-buildout.md` and `docs/mobile-api-contracts.md`.

### Settings
- Audio device selection (microphone, speaker)
- Volume and ringtone settings
- Language selection (English / Español)
- CRM integration toggle and webhook URL
- Desktop settings (start at login, minimize to tray) — Electron only
- Auto-provisioning via URL token parameter
- Persistent configuration via localStorage

## Getting Started

### Development

```bash
npm install
npm run dev
```

The dev server starts on http://localhost:3000.

### Production Build

```bash
npm run build
```

Output goes to `dist/`.

### Android Build

```bash
npx cap sync android
cd android && ./gradlew assembleRelease
```

Release signing is loaded from environment variables:

```bash
export SKYEVOX_ANDROID_KEYSTORE=/secure/path/skyevox-release.keystore
export SKYEVOX_ANDROID_KEYSTORE_PASSWORD=...
export SKYEVOX_ANDROID_KEY_ALIAS=skyevox
export SKYEVOX_ANDROID_KEY_PASSWORD=...
```

### Electron Build

```bash
cd electron
npm install
npm run dist:linux    # AppImage + deb
npm run dist:win      # NSIS installer
npm run dist:mac      # DMG
```

### Provisioning

The softphone loads its SIP configuration in one of two ways:

1. **Token URL** — Navigate to `/?token=<provisioning-token>`. The app fetches configuration from `/api/provisioning/<token>` and stores it in localStorage.
2. **QR Code** — Scan a provisioning QR code containing a `skyevox://` URI with the mobile or desktop app.
3. **Saved config** — On subsequent loads, the app reads the stored configuration from localStorage automatically.

### Configuration Format

The provisioning API should return:

```json
{
  "sip_server": "sip.example.com",
  "wss_url": "wss://sip.example.com:8089/ws",
  "username": "1001",
  "password": "secret",
  "display_name": "John Doe",
  "extension": "1001",
  "sms_from": "+15551234567",
  "turn_server": "turn:turn.example.com:3478",
  "turn_credentials": { "username": "user", "credential": "pass" },
  "srtp": "optional",
  "register_interval": 300,
  "mobile": {
    "engine": "liblinphone",
    "pushEnabled": true,
    "defaultCallingEligible": true,
    "smsEnabled": true,
    "mmsEnabled": true,
    "e911Enabled": true
  }
}
```

## Project Structure

```
src/
  i18n/                   — Internationalization config + locale files
    locales/en.json       — English translations
    locales/es.json       — Spanish translations
  types.ts                — TypeScript interfaces
  store/useStore.ts       — Zustand state store
  sip/SipClient.ts        — SIP.js wrapper class
  platform.ts             — Platform detection (web/native/electron)
  storage.ts              — Cross-platform storage abstraction
  hooks/
    useAnnouncer.ts       — Screen reader announcements
    useFocusTrap.ts       — Modal focus trapping
    useKeyboardNav.ts     — Global keyboard shortcuts
    useCallQuality.ts     — WebRTC call quality metrics
    useScreenPop.ts       — CRM screen pop caller lookup
    useAutoUpdate.ts      — Version check and update banner
  components/
    Dialpad.tsx           — Numeric keypad + call button
    CallControls.tsx      — In-call controls (mute/hold/transfer/hangup)
    IncomingCall.tsx       — Incoming call answer/reject screen
    CallHistory.tsx       — Recent calls list with quality indicators
    Directory.tsx         — Extension directory with BLF presence
    Voicemail.tsx         — Visual voicemail player
    CallWaiting.tsx       — Call waiting overlay
    Settings.tsx          — Audio/language/CRM/desktop settings
    QRScanner.tsx         — QR code provisioning scanner
    InputModal.tsx        — Native-friendly input modal
    CallQualityIndicator.tsx — Call quality dot + metrics panel
    ScreenPop.tsx         — CRM caller info overlay
    UpdateBanner.tsx      — Auto-update notification banner
  App.tsx                 — Main application shell
  main.tsx                — Entry point
  index.css               — Tailwind CSS + accessibility styles
android/                  — Capacitor Android project
electron/                 — Electron desktop app
  main.js                 — Main process (window, tray, notifications)
  preload.js              — Context bridge for renderer
chrome-extension/         — Chrome Manifest V3 click-to-call extension
  manifest.json           — Extension manifest
  content.js              — Phone number detection
  background.js           — Service worker + context menu
  popup.html/js/css       — Extension popup UI
```

## Downloads

| Platform | Download |
|----------|----------|
| Web | [connect.skyetel.ai](https://connect.skyetel.ai) |
| Android | [SkyeVoxConnect-v4.0.0.apk](https://connect.skyetel.ai/download/SkyeVoxConnect-v4.0.0.apk) |
| Linux Desktop | [SkyeVoxConnect-v4.0.0.AppImage](https://connect.skyetel.ai/download/SkyeVoxConnect-v4.0.0.AppImage) |
| Chrome Extension | [GitHub Release](https://github.com/mhalperin1/skyevox-connect/releases/tag/v4.0.0) |

## License

SkyeVox Connect is free software, licensed under the GNU Affero General
Public License v3.0 (see [LICENSE](LICENSE)). It embeds the liblinphone SDK
(AGPLv3) by Belledonne Communications. Corresponding source for each released
build is published at https://github.com/skyetel/skyevox-connect-oss.

Branding is not licensed: see [TRADEMARKS.md](TRADEMARKS.md).
