# Contributing to SvnAdmin

Thanks for helping. Bug reports, fixes, docs and new features are all welcome.

## Before you start

- **Bugs:** open an issue with the steps to reproduce, what you expected, and your Subversion and Apache versions.
- **Features:** open an issue first for anything larger than a small fix, so we can agree the approach.
- **Security issues:** see [SECURITY.md](SECURITY.md). Please don't report them in public issues.

## Development setup

You need the .NET 10 SDK and Node.js 22+. See **Quick start** in the [README](README.md): the API runs against
the sample data in `dev-data/`, and the Angular dev server proxies `/api` to it.

## Pull requests

1. Keep each pull request to one change, and add or update tests for it.
2. Run the tests: `cd server && dotnet test`. Run `npm run build` in `client/` for UI changes.
3. Anything that changes the generated passwd or authz files needs a test in `AuthzFileTests.cs` or
   `AccessEvaluatorTests.cs`. A wrong authz file can lock everyone out of SVN.
4. Database changes go in a new numbered file in `server/SvnAdmin.Api/Data/Migrations/`. Never edit a
   migration that has already been released.
5. UI changes should work in light and dark mode and at phone width.
6. Add a line to [CHANGELOG.md](CHANGELOG.md) under **Unreleased**.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Code of conduct

Be respectful and constructive. Harassment or abuse of any kind isn't tolerated, and maintainers may remove
comments or contributors that break this.
