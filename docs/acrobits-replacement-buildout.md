# SkyeVox Owned Mobile Softphone Buildout

> **Engine update (SKY-PRD-SVOX-2026-005, 2026-09-03).** The liblinphone SDK (AGPLv3, `org.linphone:linphone-sdk-android` 5.4.125 from `https://download.linphone.org/maven_repository`) supersedes the PJSIP/PJSUA2 track described below. The Android native layer now lives in `android/app/src/main/java/com/skyetel/skyevoxconnect/LinphoneEngine.java` behind the unchanged `SkyeVoxNative` plugin contract: TLS to Kamailio with server-certificate verification enabled against the bundled Mozilla root store (`android/app/src/main/assets/skyevox-ca-bundle.pem`, sha256 `f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9`), SRTP mandatory when provisioning says so, RFC 8599 `pn-provider/pn-prid/pn-param` Contact parameters from the FCM token for the self-hosted Flexisip Push Gateway, Telecom `ConnectionService` bound to liblinphone calls, and an FCM wake service (`SkyeVoxMessagingService`). The PJSIP JNI bridge, CMake config, `native/pjsip/`, and `scripts/build-pjsip-*.sh` have been removed; provisioning selects the engine with `mobile.engine = "liblinphone"`. PJSIP references that remain below are historical.

## Decision

SkyeVox Connect is the owned replacement path for Acrobits Cloud Softphone. The native mobile runtime will use open-source SIP/media components and SkyeVox-controlled backend services instead of a commercial softphone license.

The recommended native engine is PJSIP/PJSUA2 under a GPL-compatible distribution model. Pin the native engine at PJSIP 2.17 or newer; 2.17 is the current upstream release and includes fixes for security issues affecting 2.16 and below. SIP.js remains useful for web, desktop, and browser-based calling, but it is not sufficient by itself for Acrobits-grade mobile background calls, push wakeups, native audio routing, CallKit, Android Telecom, or mobile-network survivability.

## Current Build Status

Implemented in this pass:

- SMS/MMS message types, store state, API client, and in-app Messages tab.
- Provisioning fields for native mobile policy and assigned SMS DID.
- Shared provisioning mapper for token, QR, and deep-link setup.
- Capacitor `SkyeVoxNative` plugin contract for registration, calls, DTMF, transfer, default calling status, and settings handoff.
- iOS native bridge scaffold with CallKit provider support and default-calling eligibility status.
- Android native PJSIP bridge with JNI, PJSUA registration/call control, Opus-enabled static libraries, Telecom `ConnectionService`, self-managed phone account registration, `tel:`/`sip:` dialer handoff, and default dialer role screen.
- iOS background modes for audio, VoIP push, and remote notifications.
- Android permissions for foreground phone call service, notification, contacts, Bluetooth audio, and managed calls.
- Android Gradle/CMake build path for `libskyevox_pjsip.so` across `arm64-v8a`, `armeabi-v7a`, and `x86_64`.
- Android native SIP transport now supports TLS by building PJSIP against OpenSSL and provisioning `transport: "tls"`.

## Acrobits Parity Target

The replacement has to cover these operational features:

- Branded iOS and Android app with SkyeVox provisioning.
- SIP registration per tenant/extension through Kamailio, not direct-to-FreeSWITCH.
- Native PJSIP engine for mobile SIP signaling and RTP media.
- Push-assisted inbound calling using APNs/FCM and a SkyeVox push gateway.
- iOS CallKit integration and default calling app eligibility.
- Android Telecom integration and default dialer role eligibility.
- Hold, mute, attended/blind transfer, DTMF, call waiting, call history, voicemail, directory, presence, DND, and caller ID.
- SMS/MMS through SkyeVox backend APIs integrated with Skyetel messaging.
- QR/deep-link provisioning with no SIP password typing by end users.
- Mobile network survival for rotating IPs through short registration TTLs, push wakeups, NAT keepalives, Kamailio contact-path handling, and RTP relay.

## iPhone Default Calling Requirement

Apple supports third-party default calling apps, but the app must be configured as a CallKit or LiveCommunicationKit calling app and must add the relevant Default Calling or Default Dialer capability through Apple entitlement setup. Users enable it in iPhone Settings after the app qualifies.

Implementation work now in place:

- `UIBackgroundModes` includes `audio`, `voip`, and `remote-notification`.
- `SkyeVoxNativePlugin.swift` provides the CallKit bridge entry point.
- The React settings screen can query native default-calling status and open settings.

**Status 2026-10-14: the items below are COMPLETE and live-verified** (iOS Ad Hoc
build via CI, APNs auth key + self-hosted skyevox-push-gateway, Kamailio tsilo
wake-first parking on both edges; sleeping-phone inbound call answered with
two-way audio). Remaining: Android FCM delivery credentials, App Store/TestFlight
distribution, Acrobits decommission phase.

Previously required before production:

- Add the Apple entitlement in the Apple Developer account/Xcode capability once approved.
- Add APNs VoIP push entitlement and production push certificate/key setup.
- Bind CallKit actions to real PJSIP sessions.
- Build and link the iOS PJSIP artifacts on a Mac builder.
- Add App Store review notes proving the app provides real calling functionality.

References:

- PJSIP download/current release: `https://www.pjsip.org/download.htm`
- Apple Developer: `https://developer.apple.com/documentation/callkit/preparing-your-app-to-be-the-default-calling-app`
- Apple Developer entitlement: `https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.calling-app`
- Apple Support user setting: `https://support.apple.com/guide/iphone/change-the-default-apps-iphc57feab64/ios`

## Native Engine Plan

Use a single Capacitor plugin contract from TypeScript:

- Web/desktop: continue SIP.js over WSS for browser-capable calling.
- iOS native: PJSUA2 built for iOS, bridged into Swift, surfaced through `SkyeVoxNative`.
- Android native: PJSIP/PJSUA built for Android NDK, bridged through JNI and Java, surfaced through `SkyeVoxNative`.

Native PJSIP must own:

- SIP registration with Kamailio registrar/outbound proxy.
- INVITE/answer/hangup/hold/transfer/DTMF.
- RTP, SRTP policy, codec negotiation, jitter buffer, acoustic echo cancellation integration, and audio device switching.
- NAT keepalive and network handoff behavior.
- Push wakeup re-registration before answering inbound calls.

## Kamailio And Push Flow

Inbound mobile flow should be:

1. Carrier/Skyetel sends inbound call to Kamailio.
2. Kamailio resolves tenant and extension contacts.
3. If native mobile contact is awake/registered, Kamailio routes INVITE to the current contact and uses RTPengine for media.
4. If contact is push-only or stale, Kamailio suspends the INVITE, calls SkyeVox push gateway, and waits for the phone to re-register.
5. Phone receives APNs/FCM push, wakes native engine, re-registers through Kamailio, and reports readiness.
6. Kamailio resumes the INVITE to the refreshed contact.
7. RTP stays anchored on RTPengine; FreeSWITCH is not the direct mobile endpoint.

Required Kamailio behavior:

- Store mobile push metadata on registration.
- Keep contact path and received NAT data correct.
- Avoid routing directly to FreeSWITCH for client media.
- Use RTPengine offer/answer consistently for all softphone legs.
- Use short mobile registration intervals and qualify/keepalive policies that tolerate network IP changes.

## SMS/MMS Backend Contract

The app must never hold Skyetel messaging credentials. The app talks only to SkyeVox backend endpoints:

- `GET /api/connect/messages/:extension/threads?domain=:domain`
- `GET /api/connect/messages/:extension/threads/:threadId?domain=:domain`
- `POST /api/connect/messages/:extension/send?domain=:domain`

Provisioning should include:

- `sms_from`: assigned E.164 DID for outbound SMS/MMS.
- `mobile.smsEnabled`: enables Messages tab.
- `mobile.mmsEnabled`: enables attachment send/receive.
- `mobile.deviceId`: stable app device identity.
- `mobile.provisioningRevision`: policy/config revision.

Skyetel webhook handling belongs on the SkyeVox backend:

- Validate inbound webhook signature.
- Resolve tenant/domain/DID to message thread.
- Store message and media references.
- Push notify registered mobile devices.
- Return messages through the Connect API.

## No-Commercial-License Implications

This removes Acrobits licensing cost, but it does not remove:

- Apple Developer Program cost.
- Google Play publishing cost.
- APNs/FCM, backend hosting, monitoring, and storage.
- Skyetel SIP/SMS usage charges.
- GPL source distribution obligations if PJSIP GPL is used.

The clean licensing posture is to publish the mobile app source under a GPL-compatible license or keep a private internal distribution only where the chosen dependency licenses permit it.

## Immediate Next Engineering Tasks

1. Finish the iOS PJSIP build/link on macOS and bind CallKit actions to real sessions.
2. Replace Kamailio's current wake-and-return bridge with INVITE suspend/resume so a push-woken phone can receive the original call.
3. Deploy APNs/FCM provider credentials behind the SkyeVox push gateway webhook.
4. Run Android device tests against Kamailio over mobile data for registration, inbound, outbound, hold, transfer, DTMF, and network handoff.
5. Add CI checks for TypeScript, Android debug/release, PJSIP artifact presence, backend compile, and iOS simulator on a Mac runner.
