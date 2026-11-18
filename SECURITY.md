# Security policy

SvnAdmin controls who can read and write source code, so we take security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately with GitHub's private vulnerability reporting:
go to the **Security** tab of this repository and click **Report a vulnerability**.

Please include the version (or commit), what an attacker could do, and steps to reproduce. We aim to acknowledge
reports within 3 working days and to agree a disclosure date with you once a fix is ready.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope: the SvnAdmin API and web app, the generated passwd/authz files, and the deployment scripts and examples
in this repository. Out of scope: Apache httpd, Subversion itself, and issues that need an already-compromised
server or admin account.
