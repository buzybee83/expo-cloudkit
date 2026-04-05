import XCTest
import CloudKit
@testable import ExpoCloudKit

// MARK: - CompilationRegressionTests
//
// These tests guard against regressions where a property or enum case is
// renamed, removed, or has its type changed in a way that breaks callers
// elsewhere in the module.
//
// Most tests here contain no runtime assertions beyond `XCTAssertTrue(true)`.
// Their value is entirely compile-time: if an API is broken, *this file will
// not compile*, surfacing the error locally and in CI before it cascades into
// dozens of downstream "cannot find X in scope" errors.
//
// Pattern: reference the symbol in a closure that is never called. Swift still
// type-checks the closure body, so any missing member or wrong signature is a
// compile error, but the test itself always passes at runtime.

final class CompilationRegressionTests: XCTestCase {

  // MARK: - ConflictStrategy exhaustiveness
  //
  // If a new ConflictStrategy case is added and the switches in
  // CloudKitSyncEngine/CloudKitSyncFallback are not updated, this test will
  // fail to compile first — giving a local signal before CI fails.

  func test_conflictStrategy_allCasesHandled() {
    func handle(_ strategy: ConflictStrategy) -> String {
      switch strategy {
      case .serverWins:      return "serverWins"
      case .clientWins:      return "clientWins"
      case .fieldLevelMerge: return "fieldLevelMerge"
      case .manual:          return "manual"
      case .crdtMerge:       return "crdtMerge"
      }
    }
    // Exercise every case so the switch body is reachable.
    XCTAssertEqual(handle(.serverWins),      "serverWins")
    XCTAssertEqual(handle(.clientWins),      "clientWins")
    XCTAssertEqual(handle(.fieldLevelMerge), "fieldLevelMerge")
    XCTAssertEqual(handle(.manual),          "manual")
    XCTAssertEqual(handle(.crdtMerge),       "crdtMerge")
  }

  // MARK: - CloudKitModuleError members
  //
  // Guards against a member being renamed or removed. Previously, callers used
  // the non-existent `CloudKitModuleError.recordNotFound`, which caused ~30
  // cascading "cannot find … in scope" errors in CI.

  func test_cloudKitModuleError_allMembersCompile() {
    // Wrapped in a never-called closure so there are no side effects at runtime.
    let _: () -> Void = {
      _ = CloudKitModuleError.notConfigured
      _ = CloudKitModuleError.requiresiOS17
      _ = CloudKitModuleError.syncEngineNotRunning
      _ = CloudKitModuleError.sharingUIUnavailable
      _ = CloudKitModuleError.sharingUINotSupportedOnMacOS
      _ = CloudKitModuleError.backgroundSyncUnavailable
      _ = CloudKitModuleError.participantLookupFailed
      _ = CloudKitModuleError.notImplemented("fn")
      _ = CloudKitModuleError.subscriptionNotFound("id")
      _ = CloudKitModuleError.invalidArgument("msg")
      _ = CloudKitModuleError.participantNotFound("name")
      _ = CloudKitModuleError.shareNotFound()
      _ = CloudKitModuleError.shareNotFound("detail")
    }
    XCTAssertTrue(true, "All CloudKitModuleError members compiled successfully")
  }

  // MARK: - ExpoCloudKitModule.sharedSyncProviders type
  //
  // Guards against sharedSyncProviders being renamed back to sharedSyncProvider
  // (singular), which caused CloudKitStore to fail to compile.

  func test_sharedSyncProviders_isDictionaryType() {
    // Type annotation is the assertion: if sharedSyncProviders doesn't have this
    // type, the assignment is a compile error.
    let providers: [CKDatabase.Scope: WeakSyncProviderBox] = ExpoCloudKitModule.sharedSyncProviders
    XCTAssertTrue(providers.isEmpty, "sharedSyncProviders should be empty before configure()")
  }
}
