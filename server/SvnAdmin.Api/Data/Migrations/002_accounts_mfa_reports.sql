-- Self-service accounts, email links, MFA (TOTP + recovery codes + passkeys), activity cache.

ALTER TABLE users ADD COLUMN last_login_at TEXT;          -- any sign-in to SvnAdmin (admin or self-service)
ALTER TABLE users ADD COLUMN totp_secret TEXT;            -- encrypted with ASP.NET Data Protection
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;      -- replay protection: last accepted 30s step
ALTER TABLE users ADD COLUMN mfa_enabled_at TEXT;
ALTER TABLE users ADD COLUMN offboarded_at TEXT;

-- One-time links sent by email: password reset and welcome (set your first password).
CREATE TABLE user_tokens (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT    NOT NULL CHECK (purpose IN ('reset','welcome')),
    token_hash TEXT    NOT NULL UNIQUE,                    -- SHA-256 of the token; the token itself is only in the email
    expires_at TEXT    NOT NULL,
    used_at    TEXT,
    created_at TEXT    NOT NULL,
    created_by TEXT    NOT NULL
);
CREATE INDEX ix_user_tokens_user ON user_tokens(user_id);

CREATE TABLE recovery_codes (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT    NOT NULL,
    used_at   TEXT
);
CREATE INDEX ix_recovery_user ON recovery_codes(user_id);

CREATE TABLE passkeys (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id  BLOB    NOT NULL UNIQUE,
    public_key     BLOB    NOT NULL,
    user_handle    BLOB    NOT NULL,
    sign_count     INTEGER NOT NULL DEFAULT 0,
    aaguid         TEXT    NOT NULL DEFAULT '',
    transports     TEXT    NOT NULL DEFAULT '',
    name           TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL,
    last_used_at   TEXT
);
CREATE INDEX ix_passkeys_user ON passkeys(user_id);

-- Last commit per author, filled incrementally from "svn log -q" (see ActivityScanner).
CREATE TABLE author_activity (
    username       TEXT PRIMARY KEY COLLATE NOCASE,
    last_commit_at TEXT NOT NULL,
    last_repo      TEXT NOT NULL,
    commit_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE repo_scan (
    repo_name     TEXT PRIMARY KEY COLLATE NOCASE,
    last_revision INTEGER NOT NULL,
    scanned_at    TEXT NOT NULL
);
