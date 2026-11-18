# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

First public release (planned as 1.0.0).

### Added
- Users, groups (including nested groups) and folder-level permissions, with validation before every write
- Repositories: create, archive, restore, recent commits; file lock management
- Access review, inactive accounts report, dashboard and CSV export
- Audit log with date filters and CSV download
- Two-step sign-in with passkeys (WebAuthn) or an authenticator app (TOTP), plus recovery codes
- Self-service password change, "forgot password" and welcome emails (SMTP settings with a test button)
- Offboarding, bulk actions and CSV import
- Daily config backups (passwd, authz, database) with restore, delete and download
- Light and dark mode, `Ctrl+K` global search, keyboard shortcuts
- Configurable product name and logo
