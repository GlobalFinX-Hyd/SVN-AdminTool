-- SvnAdmin initial schema.
-- SQLite is the source of truth; the Apache passwd and authz files are generated from it.

CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    full_name           TEXT    NOT NULL DEFAULT '',
    email               TEXT    NOT NULL DEFAULT '',
    password_hash       TEXT    NOT NULL,
    is_enabled          INTEGER NOT NULL DEFAULT 1,
    notes               TEXT    NOT NULL DEFAULT '',
    password_changed_at TEXT,
    last_admin_login_at TEXT,
    failed_logins       INTEGER NOT NULL DEFAULT 0,
    locked_until        TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

CREATE TABLE groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE group_user_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

-- Nested groups: authz "@child" inside a parent group.
CREATE TABLE group_group_members (
    group_id        INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, member_group_id),
    CHECK (group_id <> member_group_id)
);

CREATE TABLE repositories (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at  TEXT NOT NULL
);

-- One authz rule line. repo_name NULL means a section that applies to every repo ("[/path]").
-- principal_type: user | group | all | authenticated | anonymous
-- access: '' (no access), 'r', 'rw'
CREATE TABLE access_rules (
    id             INTEGER PRIMARY KEY,
    repo_name      TEXT COLLATE NOCASE,
    path           TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group','all','authenticated','anonymous')),
    principal_name TEXT NOT NULL DEFAULT '',
    access         TEXT NOT NULL CHECK (access IN ('','r','rw')),
    UNIQUE (repo_name, path, principal_type, principal_name)
);

CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    ip      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_audit_at ON audit_log(at DESC);

CREATE TABLE backup_runs (
    id          INTEGER PRIMARY KEY,
    repo_name   TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- config
    trigger     TEXT NOT NULL,          -- manual | schedule
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,          -- running | ok | failed
    revision    INTEGER,
    target_path TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_backup_started ON backup_runs(started_at DESC);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
