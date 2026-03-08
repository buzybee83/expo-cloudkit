# expo-cloudkit — Project Context

## What It Is

`expo-cloudkit` is an open-source Expo native module that gives React Native / Expo apps
first-class access to Apple's CloudKit framework. It is distributed as an npm package and
works with any Expo project (managed or bare workflow) via the included config plugin.

## Target Audience

Expo developers who need iCloud sync, iCloud Drive storage, or CloudKit sharing in their apps
without dropping down to raw Swift. The module is especially useful for:

- Note/document apps wanting iCloud sync across a user's devices
- Apps that need to share data between users (families, teams) via CKShare
- Apps targeting power users on Apple devices who expect iCloud "just works"

## Design Principles

### 1. Thin wrapper — expose CloudKit semantics, don't abstract them away

The API surface mirrors CloudKit naming and concepts closely. If you've read Apple's
CloudKit documentation, the module should feel immediately familiar. We don't invent
alternative abstractions (e.g., no "collection" abstraction over zones + records).

Rationale: CloudKit has nuanced capabilities (conflict resolution, change tokens, zone
granularity) that would be lost or incorrectly handled by a heavy abstraction layer.

### 2. iOS 17+ preferred path, iOS 16 fallback

`CKSyncEngine` (iOS 17+) is the correct, Apple-recommended sync primitive. The module
uses it on iOS 17+ and falls back to manual `CKServerChangeToken`-based fetching on
iOS 16. The JS API surface is identical regardless of the underlying path — feature
detection is internal.

### 3. Zero dependencies beyond Expo Modules Core

The native module depends only on:
- `expo-modules-core` (Expo Modules Core Swift/Kotlin runtime)
- Apple's built-in `CloudKit` framework

No third-party Swift packages. No extra npm packages at runtime.

### 4. Errors are first-class

Every CloudKit operation can fail in several structured ways (`notAuthenticated`,
`networkUnavailable`, `serverRejectedRequest`, etc.). The module maps all `CKError`
codes to typed JS error objects with a `code` field that can be caught and handled
specifically. Callers should always handle errors.

## API Conventions

- **camelCase** for all JS identifiers — `fetchRecord`, `saveRecord`, `createZone`
- **CloudKit naming where it aids clarity** — `recordType` (not `type`), `recordName` (not `id`), `zoneName` (not `zone`)
- **Async functions** return Promises — no callback style
- **Events** use `addEventListener(eventName, handler)` / `removeEventListener(eventName, handler)` — matches Expo conventions
- **Dates** are Unix millisecond timestamps as `number` in JS; converted to/from `Date` in Swift
- **Assets** are referenced by local file URI on the JS side; the module handles upload/download

## Repository Structure

```
expo-cloudkit/
├── ios/                    — Swift native implementation
│   ├── ExpoCloudKitModule.swift
│   ├── CloudKitContainer.swift
│   ├── CloudKitRecordManager.swift
│   ├── CloudKitZoneManager.swift
│   └── Converters.swift
├── src/                    — TypeScript public API
│   ├── index.ts            — single entry point
│   ├── types.ts            — all public types
│   ├── ExpoCloudKit.ts     — native module bridge
│   └── errors.ts           — typed error classes
├── plugin/                 — Expo config plugin (entitlements)
├── example/                — Example Expo app
├── openspec/               — Roadmap and project context (this directory)
├── CHANGELOG.md            — Semver changelog
├── CLAUDE.md               — Claude Code agent instructions
└── package.json
```
