"""Albayan Ads Studio (Smart System `ad_maker`): customer self-service ads, Social Studio posts and
comment auto-replies. Screens: src/systems/ads_studio/ (bundle studio.js). API prefixes:
/api/ad-studio, /api/social-studio and /api/studio (the redesign, studio_api.py).

OWNED_TYPES lists the record types only this system reads and writes. Anything else goes through
a platform door (wallet ledger, subscriptions, Meta client, users) — see docs/SMART_SYSTEMS.md.
"""

OWNED_TYPES = frozenset(
    {
        "adCampaignRequests",
        "socialStudioSettings",
        "socialPages",
        "socialReplyRules",
        "socialPosts",
        "socialReplyLog",
        "studioSettings",  # /api/studio switches (studio_settings.py)
        "adCampaignResults",  # Meta's view of a linked request (studio_results.py)
        "studioAlerts",  # staff/admin alerts raised by the studio jobs loop (studio_jobs.py)
        "studioJobState",  # the jobs loop's one heartbeat and claims row (studio_jobs.py)
        "studioProfiles",  # optional WhatsApp number (route P2-07; scrubbed on anonymisation, studio_privacy.py)
    }
)
