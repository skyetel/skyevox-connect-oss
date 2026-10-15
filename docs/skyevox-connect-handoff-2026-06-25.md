# SkyeVox Connect Handoff - 2026-06-25

This note captures the current SkyeVox Connect state so work can resume later
without depending on chat context. No secrets are stored here.

## Scope

- iOS native work is intentionally deferred.
- Android is the active owned replacement path for Acrobits Cloud Softphone.
- Android must support SIP over TCP/TLS through Kamailio, not direct FreeSWITCH.
- SMS/MMS integration uses SkyeVox backend APIs and Skyetel-backed numbers.
- Mobile default-calling behavior is targeted through Android Telecom now; iOS
  default calling will need a separate review.

## Repositories

- Connect app: `/home/michael/oracle-successor-workbench/repos/skyevox-connect`
- Backend web/API: `/home/michael/oracle-successor-workbench/repos/ai-ivr/web`
- Kamailio edge config: `/home/michael/oracle-successor-workbench/repos/skyevox-kamailio`

## Current Android State

- Native PJSIP bridge exists under `android/app/src/main/cpp/` and Java bridge
  classes under `android/app/src/main/java/com/skyetel/skyevoxconnect/`.
- Android PJSIP build script now builds OpenSSL and links PJSIP with TLS support.
- PJSIP/OpenSSL artifacts were built successfully for:
  - `arm64-v8a`
  - `armeabi-v7a`
  - `x86_64`
- Built artifacts are staged under `native/pjsip/dist/android/`.
- Debug APK was built successfully:
  `/home/michael/oracle-successor-workbench/repos/skyevox-connect/android/app/build/outputs/apk/debug/app-debug.apk`
- APK contained native library outputs:
  - `lib/arm64-v8a/libskyevox_pjsip.so`
  - `lib/armeabi-v7a/libskyevox_pjsip.so`
  - `lib/x86_64/libskyevox_pjsip.so`

## SIP/TLS Provisioning

- Kamailio TLS listener in the checked config is on `8443`.
- The Connect mobile contract and backend provisioning were adjusted to avoid
  relying on default SIP TLS ports or SRV records.
- Native SIP provisioning should use:
  - SIP server: `connect.skyetel.ai:8443`
  - Transport: `tls`
  - Outbound proxy: `sip:connect.skyetel.ai:8443;transport=tls`
- Tenant/account identity remains separate from the edge proxy:
  - `sip_domain` / `tenant_domain` should remain the tenant domain.
  - Android PJSIP uses `sipServer` for registrar/proxy and `sipDomain` for AOR.
- `connect.skyetel.ai` had no `_sips._tcp` or `_sip._tls` SRV records from this
  host during testing, so the explicit port is required.

## TLS Security Note

- PJSIP TLS transport support is enabled by building PJSIP against OpenSSL.
- PJSIP exposes `verify_server`, but hard-fail certificate verification was not
  enabled yet.
- Reason: OpenSSL/PJSIP on Android needs a known CA bundle/path or pinned CA
  material first. Enabling server verification without that can break all
  registrations.
- Recommended next hardening step: ship a CA bundle or pinned SkyeVox CA/public
  cert path, then enable `transport_cfg.tls_setting.verify_server = PJ_TRUE`
  after device testing.

## Backend/API State

- Backend mobile router exists:
  `/home/michael/oracle-successor-workbench/repos/ai-ivr/web/app/routers/connect_mobile.py`
- Mobile replacement migration file exists:
  `/home/michael/oracle-successor-workbench/repos/ai-ivr/web/migrations/008_connect_mobile_replacement.sql`
- The migration file was not applied live in this session.
- Reason: applying live DDL/schema changes should go through the normal migration
  path and target selection. Do not apply manually without an explicit DB target
  and deployment window.
- Backend provisioning now includes native mobile metadata:
  - `mobile.engine = "pjsip"`
  - `mobile.transport = "tls"`
  - push/default-calling/SMS/MMS capability flags
  - `register_interval = 120`

## Kamailio State

- Kamailio is still the SIP edge. Calls must flow through Kamailio.
- Current push wake behavior on usrloc miss:
  - Kamailio calls `/etc/kamailio/skyevox-mobile-wakeup.sh`
  - The helper calls the Connect backend wake endpoint.
  - Kamailio returns `480 Temporarily Unavailable - Mobile Wake Sent`.
- `tsilo` suspend/resume was not added.
- Reason: current config saves registrations only after FreeSWITCH authenticates
  REGISTER and returns `200 OK`. That is the right security posture, but it makes
  the naive `ts_append()` path unsafe because it normally belongs in request or
  failure routes, not the current post-auth reply route.
- Future Acrobits-grade push behavior needs either:
  - Kamailio-side REGISTER auth so `save()` and `ts_append()` happen in a normal
    route, or
  - a carefully designed post-auth continuation path that preserves the current
    anti-spoof behavior.

## Public Preview Access

- Direct Vite port `3002` was only reachable locally/VPN, not publicly.
- Direct high ports such as `3002` and `8099` timed out at the public edge.
- Public IP observed from host: `35.209.38.222`
- Nginx public `80/443` were reachable.
- The default Nginx HTTP site was changed to proxy `/` to:
  `http://127.0.0.1:8099`
- Public preview URL:
  `http://35.209.38.222/`
- Nginx default-site backup:
  `/etc/nginx/sites-available/default.bak-20260621-skyevox-connect`
- Detached Vite command used:
  `npm run dev -- --host 0.0.0.0 --port 8099`
- Log file used:
  `/tmp/skyevox-connect-8099.log`

## Validation Already Run

In `skyevox-connect`:

- `npm run lint`
- `npm run build`
- `npx cap sync android`
- `ANDROID_HOME=/home/michael/.local/share/android-sdk ANDROID_SDK_ROOT=/home/michael/.local/share/android-sdk ./gradlew assembleDebug`
- `bash -n scripts/build-pjsip-android.sh scripts/build-pjsip-ios.sh`
- `git diff --check`

In `ai-ivr/web`:

- `python3 -m py_compile app/routers/connect_mobile.py app/routers/connect_provisioning.py main.py app/routers/__init__.py`
- `git diff --check`

In `skyevox-kamailio`:

- `bash -n etc/kamailio/skyevox-mobile-wakeup.sh`

Nginx:

- `sudo nginx -t`
- `sudo systemctl reload nginx`
- `curl -fsSI --max-time 5 http://35.209.38.222/`

## Important Resume Items

1. Test Android APK on real Android hardware over LTE/mobile data.
2. Verify TLS registration to Kamailio on `connect.skyetel.ai:8443`.
3. Verify inbound, outbound, audio, hold, unhold, transfer, DTMF, and network
   handoff against Kamailio and RTPengine.
4. Apply the mobile replacement DB migration only through the normal migration
   path after confirming target DB and window.
5. Decide whether to implement true push call hold/resume by moving auth into
   Kamailio or designing a secure post-auth `tsilo` continuation.
6. Add Android release signing and release APK/AAB build once device testing
   passes.
7. Come back to iOS separately: PJSIP artifacts, CallKit session binding, and
   default calling limitations need a dedicated pass.

