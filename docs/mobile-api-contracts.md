# SkyeVox Mobile API Contracts

These contracts are the backend surface needed by the owned iOS/Android softphone. The mobile app must receive tenant-specific policy from SkyeVox and must never receive Skyetel API credentials.

## Provisioning

`GET /api/provisioning/:token`

Response:

```json
{
  "sip_domain": "tc-systems-llc.skyetel.ai",
  "sip_server": "connect.skyetel.ai:8443",
  "wss_url": "wss://connect.skyetel.ai:8443",
  "username": "1001",
  "password": "redacted",
  "display_name": "TC Systems 1001",
  "extension": "1001",
  "sms_from": "+15551234567",
  "turn_server": "turn:connect.skyetel.ai:3478",
  "turn_credentials": {
    "username": "redacted",
    "credential": "redacted"
  },
  "srtp": "mandatory",
  "register_interval": 120,
  "mobile": {
    "engine": "liblinphone",
    "transport": "tls",
    "srtp": "mandatory",
    "pushEnabled": true,
    "pushProvider": { "ios": "apns-voip", "android": "fcm" },
    "pushTeamId": "redacted",
    "pushBundleId": "com.skyetel.skyevoxconnect",
    "defaultCallingEligible": false,
    "smsEnabled": true,
    "mmsEnabled": true,
    "e911Enabled": true,
    "deviceId": "device-uuid",
    "provisioningRevision": "2026-09-03.1",
    "caBundleSha256": "f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9",
    "pushRegisterExpiresSeconds": 86400
  }
}
```

Tokens are single-use: the first `GET` consumes the token and returns the credentials; later calls return `410` (`token already used` / `token revoked` / `token expired`) and an unknown token returns `404`. `HEAD` reports the same status without consuming. `mobile.deviceId` is a server-issued UUID minted per redemption.

Registration lifetime: the Flexisip push gateway never pushes for an expired binding, so a push-capable contact must outlive any suspend. When `mobile.pushEnabled` is true and the app holds a platform push token, the native engine registers with `Expires: mobile.pushRegisterExpiresSeconds` (server env `SKYEVOX_MOBILE_PUSH_REGISTER_EXPIRES`, default 86400; the app clamps to a 600 s minimum) and a dead TCP/TLS connection, not expiry, triggers the push. `register_interval` (120) still governs web/desktop clients and native registrations whose Contact carries no `pn-*` params (push disabled or no token yet). The edge's `max-expires` is 86400 to match.

Push provider names: `mobile.pushProvider.ios` stays `apns-voip` (the device-registration `pushProvider` value the backend and push webhook see; the registered `pushToken` is the PushKit VoIP token, not the regular APNs token). On the SIP side the iOS engine writes the RFC 8599 Contact params the way Belledonne's Flexisip gateway expects: `pn-provider=apns.dev` for debug builds (APNs sandbox) or `apns` for release builds, `pn-prid=<VoIP token hex>`, `pn-param=<mobile.pushTeamId>.<mobile.pushBundleId>.voip` (`mobile.pushParam` overrides it verbatim). Without `pushTeamId` (or `pushParam`) the iOS Contact carries no `pn-*` params and keeps the short `register_interval` refresh. The VoIP push payload must carry `call-id` (also accepted: `callId`, `call_id`, or `aps.call-id`), and may carry `from-uri`/`from` and `display-name`/`callerName` for the CallKit placeholder shown before the INVITE arrives.

Companion endpoints:

- `GET /api/provisioning/:token/qr.png` — PNG of `skyevox://provision?token=<token>&server=connect.skyetel.ai` while the token is still valid.
- `POST /api/provisioning/validate` with `{"token": "..."}` — `{"valid": true}` or `{"valid": false, "reason": "not_found|already_used|revoked|expired"}`; non-consuming.
- Console (session, admin or tenant_admin): `POST /api/provisioning/tokens` with `{"extension_id": 5, "email": "optional", "expires_minutes": 15}` (default 15, max 4320) returns `{id, token, extension_id, extension, tenant, created_at, expires_at, qr_url, provision_url, deep_link, email_sent}`; `GET /api/provisioning/tokens` lists recent tokens without their values; `DELETE /api/provisioning/tokens/:id` revokes an unused token.

## Device Registration

`POST /api/connect/mobile/:extension/register-device?domain=:domain`

Request:

```json
{
  "deviceId": "device-uuid",
  "platform": "ios",
  "appVersion": "4.0.17",
  "pushProvider": "apns-voip",
  "pushToken": "redacted",
  "bundleId": "com.skyetel.skyevoxconnect",
  "capabilities": {
    "engine": "liblinphone",
    "callkit": true,
    "defaultCallingEligible": true,
    "sms": true,
    "mms": true
  }
}
```

Response:

```json
{
  "ok": true,
  "deviceId": "device-uuid",
  "serverDeviceId": 42,
  "registrationTtlSeconds": 120,
  "pushPolicy": "wake-and-register",
  "nativeSip": {
    "outboundProxy": "sip:connect.skyetel.ai:8443;transport=tls",
    "registrar": "sip:tc-systems-llc.skyetel.ai",
    "keepAliveSeconds": 25,
    "transport": "tls"
  }
}
```

## Push Wakeup

The push gateway is called by Kamailio or a SkyeVox call-control service when a contact is push-only/stale.

`POST /api/connect/mobile/:extension/wake?domain=:domain`

Required security header. The backend reads `SKYEVOX_MOBILE_WAKE_SECRET`; when it is unset the route fails closed with `503` (it never runs open), and a missing or wrong value is `403`. The same value may be passed as `?secret=` for callers that cannot set headers.

`X-SkyeVox-Mobile-Wake-Secret: <shared-secret>`

Request:

```json
{
  "callId": "kamailio-call-id",
  "from": "+15559876543",
  "to": "+15551234567",
  "reason": "incoming-call",
  "expiresSeconds": 30
}
```

Response:

```json
{
  "ok": true,
  "attemptedDevices": 1,
  "pushedDevices": 1,
  "pendingDevices": 0,
  "resumeToken": "opaque-resume-token"
}
```

The backend posts each wake event to `SKYEVOX_PUSH_WEBHOOK_URL` when configured. That service owns the final APNs/FCM provider delivery and receives:

```json
{
  "type": "incoming-call",
  "platform": "ios",
  "token": "apns-or-fcm-token",
  "extension": "1001",
  "domain": "tc-systems-llc.skyetel.ai",
  "callId": "kamailio-call-id",
  "from": "+15559876543",
  "to": "+15551234567",
  "reason": "incoming-call",
  "expiresSeconds": 30
}
```

Optional outbound header when `SKYEVOX_PUSH_WEBHOOK_SECRET` is configured:

`X-SkyeVox-Push-Secret: <shared-secret>`

## Messages

`GET /api/connect/messages/:extension/threads?domain=:domain`

Response:

```json
[
  {
    "id": "thread-id",
    "participants": ["+15559876543"],
    "displayName": "+1 555 987 6543",
    "lastMessage": "See you at 3",
    "lastMessageAt": "2026-06-20T16:00:00Z",
    "unreadCount": 1
  }
]
```

`GET /api/connect/messages/:extension/threads/:threadId?domain=:domain`

Response:

```json
[
  {
    "id": "message-id",
    "threadId": "thread-id",
    "direction": "inbound",
    "from": "+15559876543",
    "to": "+15551234567",
    "text": "See you at 3",
    "media": [],
    "status": "delivered",
    "createdAt": "2026-06-20T16:00:00Z"
  }
]
```

`POST /api/connect/messages/:extension/send?domain=:domain`

Request:

```json
{
  "from": "+15551234567",
  "to": "+15559876543",
  "text": "Confirmed",
  "media": []
}
```

Skyetel inbound webhook:

`POST /api/connect/messages/skyetel/webhook`

Required security header. The backend reads `SKYEVOX_SMS_WEBHOOK_SECRET`; when it is unset the route fails closed with `503`, and a missing or wrong value is `403`. `?secret=` is accepted as an alternative to the header. A destination number that is not an extension `sms_number` or a tenant DID is `404`.

`X-SkyeVox-Webhook-Secret: <shared-secret>`

Response:

```json
{
  "id": "message-id",
  "threadId": "thread-id",
  "direction": "outbound",
  "from": "+15551234567",
  "to": "+15559876543",
  "text": "Confirmed",
  "media": [],
  "status": "queued",
  "createdAt": "2026-06-20T16:01:00Z"
}
```
