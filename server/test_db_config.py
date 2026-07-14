"""Database configuration and keyset-index regression tests."""

from sqlalchemy.engine import URL

from server.db import METADATA, define_schema, get_database_url


def test_discrete_database_config_preserves_special_password(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ALBAYAN_DATABASE_URL", raising=False)
    monkeypatch.setenv("ALBAYAN_DB_HOST", "database.internal")
    monkeypatch.setenv("ALBAYAN_DB_PORT", "5433")
    monkeypatch.setenv("ALBAYAN_DB_NAME", "albayan")
    monkeypatch.setenv("ALBAYAN_DB_USER", "app_user")
    monkeypatch.setenv("ALBAYAN_DB_PASSWORD", "p@ss%:/ word")

    url = get_database_url()
    assert isinstance(url, URL)
    assert url.drivername == "postgresql+psycopg"
    assert url.username == "app_user"
    assert url.password == "p@ss%:/ word"
    assert url.host == "database.internal"
    assert url.port == 5433
    assert url.database == "albayan"
    rendered = url.render_as_string(hide_password=False)
    assert "p%40ss%25%3A%2F word" in rendered


def test_keyset_indexes_are_in_schema_metadata():
    define_schema()
    names = {index.name for index in METADATA.tables["entities"].indexes}
    assert {"entities_type_created_id", "entities_type_modified_id"}.issubset(names)
