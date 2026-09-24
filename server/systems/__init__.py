"""Smart Systems (owner decision D36, docs/SMART_SYSTEMS.md).

Each Smart System (Albayan Ads Studio, Clothes System, and every future system) is a separate
module inside one Albayan platform: its own package here, its own screens under src/systems/<name>/
built into its own lazy bundle, its own record types (OWNED_TYPES in the package) and API prefix.
Systems share only the platform doors (login/users, wallet, subscriptions, the Meta client,
notifications, audit, design look) and never import main.py or another system's package; they
receive main.py helpers through their router factory's ctx. server/test_system_boundaries.py and
scripts/test-system-boundaries.js enforce this.
"""
