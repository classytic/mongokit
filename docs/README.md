# MongoKit Documentation

This directory contains development and contribution documentation that is kept in the repository but excluded from the npm package to minimize package size.

## Contents

### [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)
Complete pre-release verification checklist for maintainers. Includes:
- Code quality checks
- Compatibility verification
- Testing requirements
- Security audits
- Type system validation
- Package configuration
- Final approval criteria

### [TYPES_GUIDE.md](./TYPES_GUIDE.md)
Type organization and architecture guide for contributors. Includes:
- Single source of truth principle
- Type definition rules
- Migration checklist
- Duplication prevention strategies
- Future refactoring guidance

## For Users

End users should refer to the main [README.md](../README.md) in the package root for:
- Installation instructions
- Usage examples
- API documentation
- Plugin guides

## For Contributors

When contributing to MongoKit:

1. **Read the Type Guide** before adding new types
2. **Follow the Release Checklist** before creating PRs for releases
3. **Run tests** with `npm test` before committing
4. **Build verification** with `npm run build` and `npm run typecheck`

## Package Exclusion

This `docs/` directory is intentionally excluded from the npm package via the `"files"` field in `package.json`. Only the following are included in the published package:

- `dist/` - Compiled JavaScript and TypeScript definitions
- `README.md` - User documentation
- `LICENSE` - MIT License

This keeps the package size minimal (211.4 KB compressed) while maintaining comprehensive documentation in the GitHub repository.
