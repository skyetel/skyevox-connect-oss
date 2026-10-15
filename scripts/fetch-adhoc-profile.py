#!/usr/bin/env python3
"""Download the newest active 'SkyeVox AdHoc' provisioning profile from
App Store Connect and install it for xcodebuild. Requires ASC_* env vars."""
import base64
import os
import pathlib
import time

import jwt
import requests

KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER_ID = os.environ["ASC_ISSUER_ID"]
P8 = os.environ["ASC_API_KEY_P8"]
PROFILE_NAME = os.environ.get("SKYEVOX_PROFILE_NAME", "SkyeVox AdHoc")

now = int(time.time())
token = jwt.encode(
    {"iss": ISSUER_ID, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
    P8,
    algorithm="ES256",
    headers={"kid": KEY_ID, "typ": "JWT"},
)

r = requests.get(
    "https://api.appstoreconnect.apple.com/v1/profiles",
    headers={"Authorization": f"Bearer {token}"},
    params={
        "filter[name]": PROFILE_NAME,
        "filter[profileState]": "ACTIVE",
        "sort": "-id",
        "limit": 1,
    },
    timeout=30,
)
r.raise_for_status()
data = r.json()["data"]
if not data:
    raise SystemExit(f"No ACTIVE profile named {PROFILE_NAME!r} found")

profile = data[0]
content = base64.b64decode(profile["attributes"]["profileContent"])
uuid = profile["attributes"]["uuid"]

dest = pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles"
dest.mkdir(parents=True, exist_ok=True)
path = dest / f"{uuid}.mobileprovision"
path.write_bytes(content)
print(f"Installed profile {profile['attributes']['name']} ({uuid}) -> {path}")
