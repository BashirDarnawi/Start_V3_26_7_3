"""Version of read-side rules applied equally to existing and newly created data.

This is not a database schema revision and never authorizes a money repair.
Bump it when a new projection/backfill changes what unchanged rows return.
Clients use it to refresh their permitted collections once instead of waiting
for an edit timestamp that a read-only compatibility rule cannot produce.
See docs/DATA_COMPATIBILITY.md for the upgrade and regression-test contract.
"""

# Version 2 publishes corrected owner visibility for private campaigns after
# older delta reads incorrectly treated them as reviewer-only tombstones.
# Existing cached deletion markers still require an authoritative full reload;
# a compatibility merge deliberately cannot resurrect equal-version deletions.
DATA_COMPATIBILITY_VERSION = 2
