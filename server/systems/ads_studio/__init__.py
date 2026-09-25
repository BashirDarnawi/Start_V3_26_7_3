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
        "studioActivity",  # the owner's in-app inbox items (studio_activity.py, P3-05)
        "studioStopRequests",  # one urgent stop request per ad: the staff queue (studio_stop.py, P3-10)
        "supportTickets",  # help tickets (studio_support.py, P3-07; stop-request tickets from studio_stop.py)
        "supportTicketMessages",  # the messages of a help ticket (studio_support.py, P3-07)
        "studioAlerts",  # staff/admin alerts raised by the studio jobs loop (studio_jobs.py)
        "studioJobState",  # the jobs loop's one heartbeat and claims row (studio_jobs.py)
        "studioProfiles",  # optional WhatsApp number (route P2-07; scrubbed on anonymisation, studio_privacy.py)
        "supportTickets",  # help desk tickets (studio_support.py, P3-07; texts scrubbed on anonymisation)
        "supportTicketMessages",  # their append-only messages (studio_support.py, P3-07)
        "studioCounters",  # the ticket number counter row (studio_support.py, P3-07)
    }
)
