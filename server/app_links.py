"""Domain verification files that make the app's sign-in deep link forgery-proof.

The packaged apps sign in through the phone's real browser and receive the
result at ``albayan://auth?code=...``. A custom scheme like that is claimed by
name only: ANY app on the phone may register ``albayan://`` and receive the
code. PKCE stops a passive interceptor (the code is useless without the
verifier the real app generated), but not an app that runs the whole flow
itself — it opens the hosted login page with its OWN challenge, and whatever it
gets back it can redeem.

The standard fix is to stop trusting the scheme and use links the operating
system verifies against this domain: Android App Links and iOS Universal
Links. Both work by fetching a file from ``/.well-known/`` on albayanhub.com
and checking it names the app; an impostor cannot publish here, so it cannot
claim the link.

Those files must contain the app's real signing identity, which lives in the
owner's Play Console and Apple developer account — not in this repository. So
they are served from environment variables and each route returns 404 until
its variable is set. Nothing changes until the owner fills them in:

    ALBAYAN_ANDROID_PACKAGE            default com.albayan.app
    ALBAYAN_ANDROID_CERT_FINGERPRINTS  SHA-256 signing fingerprints, comma
                                       separated (Play Console -> App signing)
    ALBAYAN_IOS_APP_ID                 "<TeamID>.<bundle id>", e.g.
                                       ABCDE12345.com.albayan.app

Setting them is only half the job: the Android manifest needs an autoVerify
https intent-filter and the iOS build needs the Associated Domains
entitlement, both of which require rebuilding and resubmitting the apps.
"""

import json
import os
import re

from fastapi import APIRouter, HTTPException, Response

# Play Console prints fingerprints as colon-separated hex byte pairs.
_FINGERPRINT_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){31}$")
# "<10-char Team ID>.<bundle identifier>".
_IOS_APP_ID_RE = re.compile(r"^[0-9A-Z]{10}\.[A-Za-z0-9.\-]{1,128}$")
_PACKAGE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$")

# Both files are fetched by Google's and Apple's crawlers, which cannot send
# the private origin header, and are read before any user signs in.
WELL_KNOWN_PATHS = (
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
)

_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}


def _android_fingerprints() -> list[str]:
    """Configured SHA-256 signing fingerprints, upper-cased and validated.

    A malformed entry is dropped rather than served: a file that fails to
    parse would silently disable verification, and a half-valid one is more
    confusing to diagnose than no file at all.
    """
    raw = os.getenv("ALBAYAN_ANDROID_CERT_FINGERPRINTS", "")
    out: list[str] = []
    for part in raw.replace(" ", "").split(","):
        candidate = part.strip().upper()
        if candidate and _FINGERPRINT_RE.match(candidate) and candidate not in out:
            out.append(candidate)
    return out


def _android_package() -> str:
    package = os.getenv("ALBAYAN_ANDROID_PACKAGE", "com.albayan.app").strip()
    return package if _PACKAGE_RE.match(package) else ""


def _ios_app_ids() -> list[str]:
    raw = os.getenv("ALBAYAN_IOS_APP_ID", "")
    out: list[str] = []
    for part in raw.replace(" ", "").split(","):
        candidate = part.strip()
        if candidate and _IOS_APP_ID_RE.match(candidate) and candidate not in out:
            out.append(candidate)
    return out


def create_app_links_router() -> APIRouter:
    router = APIRouter()

    @router.get("/.well-known/assetlinks.json")
    def android_asset_links() -> Response:
        """Tells Android which app may claim https links on this domain."""
        fingerprints = _android_fingerprints()
        package = _android_package()
        if not fingerprints or not package:
            raise HTTPException(status_code=404, detail="Not found")
        body = [
            {
                "relation": [
                    "delegate_permission/common.handle_all_urls",
                    "delegate_permission/common.get_login_creds",
                ],
                "target": {
                    "namespace": "android_app",
                    "package_name": package,
                    "sha256_cert_fingerprints": fingerprints,
                },
            }
        ]
        return Response(
            content=json.dumps(body, indent=2),
            media_type="application/json",
            headers=_CACHE_HEADERS,
        )

    @router.get("/.well-known/apple-app-site-association")
    def apple_app_site_association() -> Response:
        """Tells iOS which app may claim https links on this domain.

        Apple requires this served as application/json with NO .json
        extension, which is why it is a route rather than a static file.
        """
        app_ids = _ios_app_ids()
        if not app_ids:
            raise HTTPException(status_code=404, detail="Not found")
        body = {
            "applinks": {
                "apps": [],
                "details": [
                    {"appID": app_id, "paths": ["/app-login", "/app-login/*"]}
                    for app_id in app_ids
                ],
            },
            "webcredentials": {"apps": app_ids},
        }
        return Response(
            content=json.dumps(body, indent=2),
            media_type="application/json",
            headers=_CACHE_HEADERS,
        )

    return router
