import Foundation
import CloudKit
#if canImport(SwiftUI)
import SwiftUI

// MARK: - CloudKitStoreView (iOS 17+ @Observable)

/// A generic SwiftUI view that handles loading and error states for `CloudKitStore`.
///
/// Renders a `ProgressView` while `store.isLoading` is true, an error banner when
/// `store.error` is non-nil, and the caller-supplied `content` view when records
/// are available. Errors are dismissed when the user taps "Dismiss".
///
/// Usage:
/// ```swift
/// @State private var store = CloudKitStore()
///
/// var body: some View {
///   CloudKitStoreView(store: store) { records in
///     List(records.values.sorted(by: { $0.id < $1.id })) { record in
///       Text(record.recordType)
///     }
///   }
///   .task { await store.fetch(FetchConfig(recordType: "Note")) }
/// }
/// ```
@available(iOS 17.0, macOS 14.0, *)
public struct CloudKitStoreView<Content: View>: View {
  @Bindable private var store: CloudKitStore
  private let content: ([String: CloudKitRecord]) -> Content

  /// Creates a `CloudKitStoreView` bound to an `@Observable` `CloudKitStore`.
  ///
  /// - Parameters:
  ///   - store: The `CloudKitStore` instance to observe. Must be `@Observable`.
  ///   - content: A `@ViewBuilder` closure that receives the current `records`
  ///     dictionary and returns the main content view.
  public init(
    store: CloudKitStore,
    @ViewBuilder content: @escaping ([String: CloudKitRecord]) -> Content
  ) {
    self.store = store
    self.content = content
  }

  public var body: some View {
    ZStack {
      content(store.records)

      if store.isLoading {
        CloudKitLoadingOverlay()
      }
    }
    .overlay(alignment: .top) {
      if let error = store.error {
        CloudKitErrorBanner(error: error) {
          store.error = nil
        }
        .transition(.move(edge: .top).combined(with: .opacity))
        .animation(.easeInOut(duration: 0.25), value: store.error != nil)
      }
    }
  }
}

// MARK: - CloudKitStoreViewLegacy (iOS 16 ObservableObject)

/// A generic SwiftUI view that handles loading and error states for `CloudKitStoreLegacy`.
///
/// Provides the same visual behaviour as `CloudKitStoreView` for iOS 16 deployments
/// that use `CloudKitStoreLegacy` (`ObservableObject`).
///
/// Usage:
/// ```swift
/// @StateObject private var store = CloudKitStoreLegacy()
///
/// var body: some View {
///   CloudKitStoreViewLegacy(store: store) { records in
///     List(records.values.sorted(by: { $0.id < $1.id })) { record in
///       Text(record.recordType)
///     }
///   }
///   .task { await store.fetch(FetchConfig(recordType: "Note")) }
/// }
/// ```
@available(iOS 16.0, macOS 13.0, *)
public struct CloudKitStoreViewLegacy<Content: View>: View {
  @ObservedObject private var store: CloudKitStoreLegacy
  private let content: ([String: CloudKitRecord]) -> Content

  /// Creates a `CloudKitStoreViewLegacy` bound to a `CloudKitStoreLegacy`.
  ///
  /// - Parameters:
  ///   - store: The `CloudKitStoreLegacy` instance to observe.
  ///   - content: A `@ViewBuilder` closure that receives the current `records`
  ///     dictionary and returns the main content view.
  public init(
    store: CloudKitStoreLegacy,
    @ViewBuilder content: @escaping ([String: CloudKitRecord]) -> Content
  ) {
    self.store = store
    self.content = content
  }

  public var body: some View {
    ZStack {
      content(store.records)

      if store.isLoading {
        CloudKitLoadingOverlay()
      }
    }
    .overlay(alignment: .top) {
      if let error = store.error {
        CloudKitErrorBanner(error: error) {
          store.error = nil
        }
        .transition(.move(edge: .top).combined(with: .opacity))
        .animation(.easeInOut(duration: 0.25), value: store.error != nil)
      }
    }
  }
}

// MARK: - Internal Subviews

/// A centered activity indicator used while CloudKit operations are in flight.
@available(iOS 16.0, macOS 13.0, *)
private struct CloudKitLoadingOverlay: View {
  var body: some View {
    ZStack {
      Color.black.opacity(0.15)
        .ignoresSafeArea()
      ProgressView()
        .progressViewStyle(.circular)
        .padding(24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
  }
}

/// A top-of-screen error banner with a dismiss button.
@available(iOS 16.0, macOS 13.0, *)
private struct CloudKitErrorBanner: View {
  let error: CloudKitError
  let onDismiss: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.yellow)
        .font(.body)

      VStack(alignment: .leading, spacing: 2) {
        Text(error.code)
          .font(.caption)
          .fontWeight(.semibold)
          .foregroundStyle(.secondary)
        Text(error.message)
          .font(.callout)
          .foregroundStyle(.primary)
          .lineLimit(3)
      }

      Spacer()

      Button {
        onDismiss()
      } label: {
        Image(systemName: "xmark")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }
}

#endif // canImport(SwiftUI)
