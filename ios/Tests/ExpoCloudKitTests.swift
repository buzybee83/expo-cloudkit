import XCTest

// MARK: - ExpoCloudKitTests
//
// This file is the XCTest entry point for the ExpoCloudKit module's
// Swift unit test suite.  Individual test classes live in separate files:
//
//   ConvertersTests.swift       — Converters static helpers (pure logic)
//   OfflineQueueEntryTests.swift — OfflineQueueEntry Codable + toDictionary
//   OfflineQueueTests.swift     — OfflineQueue backoff, status, cap, persistence
//
// Run from the command line:
//   xcodebuild test \
//     -workspace ios/ExpoCloudKit.xcworkspace \
//     -scheme ExpoCloudKit \
//     -destination "platform=iOS Simulator,name=iPhone 15"
//
// No test logic lives here — XCTest discovers all XCTestCase subclasses
// automatically.  This file exists solely to provide a human-readable
// entry point and the command-line run instructions above.

// The canonical XCTestSuite that aggregates all discovered test classes.
// XCTest populates this automatically; no explicit registration needed.
final class ExpoCloudKitTestSuite: XCTestCase {}
