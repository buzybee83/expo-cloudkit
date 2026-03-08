# expo-cloudkit

Open-source Expo native module for CloudKit (MIT). Thin, idiomatic Swift bindings exposed to React Native via Expo Modules Core.

## Quick Context

- **Stack**: Swift (Expo Modules Core), TypeScript SDK bindings
- **Type**: OSS Expo native module — no backend, no managed service
- **Purpose**: CloudKit integration for Expo/React Native apps — records, zones, sharing, CKSyncEngine
- **iOS targets**: iOS 17+ for CKSyncEngine; iOS 16 fallback with manual fetch + change tokens
- **Specs**: See `openspec/` for roadmap and project context

## Key Files

- `ios/ExpoCloudKitModule.swift` — Expo Modules Core entry point; all exported methods/events registered here
- `ios/CloudKitContainer.swift` — container setup, account status checks
- `ios/CloudKitRecordManager.swift` — record CRUD (save, fetch, delete, query)
- `ios/CloudKitZoneManager.swift` — custom zone management (create, delete, list)
- `ios/Converters.swift` — CKRecord ↔ JS dictionary conversion, field type mapping
- `src/index.ts` — single public entry point, re-exports everything
- `src/types.ts` — TypeScript type definitions for the public API
- `src/ExpoCloudKit.ts` — `requireNativeModule` bridge, event emitter setup
- `src/errors.ts` — typed error classes mirroring CKError codes
- `plugin/` — Expo config plugin for iCloud entitlements
- `example/` — Example Expo app exercising all module features
- `CHANGELOG.md` — Semver changelog (keep updated on every release)
- `openspec/ROADMAP.md` — Phase A/B/C roadmap with checkboxes

## Agent Mapping

| Phase | Agent | When to Use |
|-------|-------|-------------|
| Architecture | `architect` | API design, CloudKit pattern decisions, module structure |
| iOS Native | `ios-native-dev` | Swift implementation, Expo Modules Core, CKSyncEngine, CKShare |
| TypeScript SDK | `ts-sdk-dev` | JS/TS bindings, public API surface, type definitions, `src/` |
| Testing | `qa-tester` | Swift unit tests, TS typecheck, example app validation |
| Code Review | `code-reviewer` | Pre-PR review, Swift + TS quality gates |
| Docs | `technical-writer` | README, API docs, CHANGELOG updates |
| CI/CD & Publishing | `devops` | GitHub Actions, npm publish, versioning, git tags |
| Planning | `project-manager` | Roadmap, phase planning, parallel dispatch |

### Agent Flow for New Features

```
project-manager  →  plan phases, identify parallelizable work
    ↓ dispatch (parallel where possible)
ios-native-dev   →  Swift implementation
ts-sdk-dev       →  TypeScript bindings
    ↓ both done
code-reviewer    →  review PR (Swift + TS)
    ↓ approved
qa-tester        →  validate on example app + typecheck
    ↓ passed
devops           →  npm publish + git tag
    ↓
technical-writer →  update README / CHANGELOG
```

### Invoking Agents

```
Task(subagent_type="ios-native-dev", prompt="Implement CKSyncEngine adapter in ios/ExpoCloudKitSyncEngine.swift...")
Task(subagent_type="ts-sdk-dev", prompt="Add TypeScript bindings for sync API in src/...")
```

For parallel work, invoke multiple agents in one message:
```
Task(subagent_type="ios-native-dev", prompt="Build the Swift side...")
Task(subagent_type="ts-sdk-dev", prompt="Build the TS side...")
```

## Git Workflow (MANDATORY)

**All agents MUST use feature branches. Never commit directly to `main`.**

**Branch naming:**
| Prefix | Use Case |
|--------|----------|
| `feature/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation |
| `chore/` | Maintenance, CI, tooling |

**Required workflow:**
1. Branch from `main`: `git checkout main && git pull && git checkout -b feature/<name>`
2. Commit work on the branch
3. Push: `git push -u origin feature/<name>`
4. Open PR targeting `main`: `gh pr create --base main --title "..." --body "..."`
5. `code-reviewer` reviews and merges (or requests changes)
6. `qa-tester` validates on example app after merge
7. `devops` publishes to npm after QA passes

**PR Template:**
```
## Summary
<1-3 bullet points>

## Test plan
- [ ] npm run typecheck passes
- [ ] npm run lint passes
- [ ] Example app builds and runs on iOS Simulator
- [ ] New Swift code covered by XCTest (if unit-testable)
- [ ] ROADMAP.md checkboxes updated for completed items

Built with [Claude Code](https://claude.com/claude-code)
```

## Release Workflow

1. Update `CHANGELOG.md` with version number + date + changes
2. Bump `version` in `package.json`
3. Commit: `git commit -m "chore: release vX.Y.Z"`
4. `code-reviewer` approves
5. `qa-tester` validates on example app
6. `devops` runs `npm publish` with correct tag
7. `devops` creates git tag: `git tag v{version} && git push origin v{version}`

**Semver rules:**
- Patch (`0.x.Y`): bug fixes, no API changes
- Minor (`0.X.0`): new APIs, backwards compatible
- Major (`X.0.0`): breaking API changes

## Testing Strategy

```bash
# TypeScript type checking
npm run typecheck

# Linting
npm run lint

# Run example app on iOS Simulator (manual)
cd example && npx expo run:ios

# Swift unit tests (if ios/Tests/ exists)
xcodebuild test -workspace ios/ExpoCloudKit.xcworkspace -scheme ExpoCloudKit -destination "platform=iOS Simulator,name=iPhone 15"
```

## CloudKit-Specific Guidelines

### Error Handling (MANDATORY)
- Always handle `CKError.accountTemporarilyUnavailable` and `CKError.notAuthenticated` — these are common and must not crash
- Wrap ALL CloudKit calls in `do/catch`; never let Swift errors propagate uncaught to JS
- Bridge errors to JS via `ExpoModulesCore.Exception` subclasses — never throw raw `CKError` objects
- Map `CKError.Code` values to typed JS error codes defined in `src/errors.ts`

### CKSyncEngine (iOS 17+)
- Always check `#available(iOS 17, *)` before using `CKSyncEngine`
- Provide graceful fallback path for iOS 16 (manual fetch with `CKServerChangeToken`)
- Persist change tokens in `UserDefaults` — loss of token means full re-sync
- Use server-record-wins as the default conflict resolution strategy
- Delegate pattern: `CKSyncEngineDelegate` — implement all required methods

### General CloudKit Patterns
- Never store `CKRecord.ID.recordName` as a user-visible string without escaping
- Use `CKContainer.default()` unless the config plugin has set a custom container identifier
- `CKRecordZone.ID` and `CKRecord.ID` are value types — always pass by value
- Batch operations with `CKModifyRecordsOperation` for efficiency (never call save record in a loop)
- Always specify `desiredKeys` on fetch operations to avoid over-fetching

### Swift ↔ JS Type Mapping
| CloudKit type | JS/TS type |
|---------------|------------|
| `String` | `string` |
| `NSNumber` (Int/Double) | `number` |
| `Date` | `number` (Unix ms timestamp) |
| `CKAsset` | `{ uri: string, size?: number }` |
| `CLLocation` | `{ latitude: number, longitude: number }` |
| `Data` | `string` (base64) |
| `[CKRecord.Reference]` | `string[]` (record names) |

## Phase B Roadmap (in progress)

See `openspec/ROADMAP.md` for full checklist. Current in-progress work:

- [ ] CKSyncEngine integration (iOS 17+)
- [ ] Push subscriptions (CKQuerySubscription, CKDatabaseSubscription)
- [ ] CKShare (shared zones, participants)
- [ ] iOS 16 fallback with CKServerChangeToken
