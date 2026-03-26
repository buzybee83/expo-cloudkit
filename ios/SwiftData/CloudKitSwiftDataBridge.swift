import Foundation

#if canImport(SwiftData)
import SwiftData

/// Bridges expo-cloudkit record dictionaries to SwiftData `PersistentModel` instances.
///
/// expo-cloudkit represents CloudKit records as `[String: Any]` dictionaries where
/// each field value is itself a dictionary of the form `{ "type": String, "value": Any }`.
/// This bridge uses `Mirror` reflection to map those field values onto the matching
/// properties of a `PersistentModel` subclass, and vice versa.
///
/// ## Requirements on the model class
/// - The model **must** declare a `var recordName: String` property so the bridge
///   can locate existing instances and round-trip the CloudKit identity.
/// - For `toRecord`, the model **must** also expose a `static var recordType: String`
///   property so the bridge can set `recordType` on the output dictionary.
///
/// ## Usage
/// ```swift
/// @Model class Note {
///   var title: String = ""
///   var body: String  = ""
///   var recordName: String = ""
///   static let recordType = "Note"
/// }
///
/// // Populate a Note from a fetched record dict:
/// let note: Note = try CloudKitSwiftDataBridge.fromRecord(dict, context: ctx)
///
/// // Convert a Note back to a record dict for saving:
/// let dict = try CloudKitSwiftDataBridge.toRecord(note)
///
/// // Sync a batch of fetched records:
/// try CloudKitSwiftDataBridge.syncRecords(dicts, context: ctx, type: Note.self)
/// ```
///
/// ## Supported field types
/// The bridge handles the subset of expo-cloudkit field types that map naturally
/// to Swift value types:
/// - `"string"` ↔ `String`
/// - `"number"` ↔ `Double` / `Int` / `Float`
/// - `"date"`   ↔ `Date` (stored as Unix ms timestamp in the dict)
/// - `"data"`   ↔ `Data` (stored as base64 string in the dict)
///
/// Fields whose type cannot be coerced to the model property's runtime type
/// are silently skipped — they do not cause an error.
///
/// ## Availability
/// SwiftData requires iOS 17. This entire type is gated with
/// `@available(iOS 17.0, *)` and `#if canImport(SwiftData)`.
@available(iOS 17.0, *)
public enum CloudKitSwiftDataBridge {

  // MARK: - fromRecord

  /// Creates or updates a `PersistentModel` from a CloudKit record dictionary.
  ///
  /// The dictionary must contain at least:
  /// - `"recordName"`: `String` — the CloudKit record identifier.
  /// - `"fields"`: `[String: [String: Any]]` — the field map.
  ///
  /// If an existing model with the same `recordName` is already in the context
  /// it is updated in place; otherwise a new instance is inserted.
  ///
  /// - Parameters:
  ///   - record:  Record dictionary in expo-cloudkit format.
  ///   - context: The `ModelContext` to insert into / fetch from.
  ///   - type:    The concrete `PersistentModel` type. Inferred when possible.
  /// - Returns:   The created or updated model instance.
  /// - Throws:    `CloudKitSwiftDataBridgeError.missingRecordName` if the dict
  ///              has no `"recordName"` key.
  public static func fromRecord<T: PersistentModel>(
    _ record: [String: Any],
    context: ModelContext,
    type: T.Type = T.self
  ) throws -> T {
    guard let recordName = record["recordName"] as? String else {
      throw CloudKitSwiftDataBridgeError.missingRecordName
    }

    // Try to find an existing model with this recordName so we can update in place.
    let existing: T? = try? {
      var descriptor = FetchDescriptor<T>()
      descriptor.fetchLimit = 1
      let all = try context.fetch(descriptor)
      return all.first { instance in
        let mirror = Mirror(reflecting: instance)
        return mirror.children.first(where: { $0.label == "recordName" })?.value as? String == recordName
      }
    }()

    let model: T
    if let existing = existing {
      model = existing
    } else {
      // Use the default initialiser via reflection.
      // SwiftData models must have a no-argument init (the compiler synthesises one
      // for `@Model` classes that have default values on all stored properties).
      guard let instance = T.init() as T? else {
        throw CloudKitSwiftDataBridgeError.cannotInstantiate(String(describing: T.self))
      }
      model = instance
      context.insert(model)
    }

    // Apply field values via Mirror.
    let fields = record["fields"] as? [String: [String: Any]] ?? [:]
    let mirror = Mirror(reflecting: model)

    // Build a lookup of { lowercasedLabel → child } for case-insensitive matching.
    var propertyMap: [String: (label: String, value: Any)] = [:]
    for child in mirror.children {
      if let label = child.label {
        propertyMap[label.lowercased()] = (label: label, value: child.value)
      }
    }

    // Always stamp the recordName property.
    assignProperty(named: "recordName", value: recordName, on: model, mirror: mirror)

    for (fieldName, fieldDict) in fields {
      guard let typeStr = fieldDict["type"] as? String,
            let rawValue = fieldDict["value"]
      else { continue }

      let coerced = coerce(value: rawValue, toType: typeStr)

      // Match field name case-insensitively against model properties.
      let key = fieldName.lowercased()
      if let entry = propertyMap[key] {
        assignProperty(named: entry.label, value: coerced, on: model, mirror: mirror)
      }
    }

    return model
  }

  // MARK: - toRecord

  /// Converts a `PersistentModel` to an expo-cloudkit record dictionary for saving.
  ///
  /// The model must expose:
  /// - `var recordName: String` — used as the CloudKit record identifier.
  /// - `static var recordType: String` — used as the CloudKit record type.
  ///
  /// All stored properties (excluding `recordName`) are serialised into the
  /// `"fields"` map using the expo-cloudkit `{ type, value }` format.
  ///
  /// - Parameter model: The model instance to convert.
  /// - Returns:         A dictionary in expo-cloudkit `RecordToSave` format.
  /// - Throws:          `CloudKitSwiftDataBridgeError.missingRecordType` if the
  ///                    model class has no `static var recordType: String`.
  public static func toRecord<T: PersistentModel>(_ model: T) throws -> [String: Any] {
    // Resolve recordType from the class via the type metadata.
    let modelType = type(of: model) as AnyObject.Type
    guard let recordType = (modelType as? NSObject.Type)?.value(forKey: "recordType") as? String
            ?? Mirror(reflecting: modelType).children.first(where: { $0.label == "recordType" })?.value as? String
    else {
      throw CloudKitSwiftDataBridgeError.missingRecordType(String(describing: T.self))
    }

    let mirror = Mirror(reflecting: model)
    var fields: [String: [String: Any]] = [:]
    var recordName = ""

    for child in mirror.children {
      guard let label = child.label else { continue }
      // Exclude Swift internal property wrappers (prefixed with underscore).
      if label.hasPrefix("_") { continue }

      if label == "recordName" {
        recordName = (child.value as? String) ?? ""
        continue
      }

      if let fieldDict = encodeField(value: child.value, label: label) {
        fields[label] = fieldDict
      }
    }

    var dict: [String: Any] = [
      "recordType": recordType,
      "fields": fields,
    ]
    if !recordName.isEmpty {
      dict["recordName"] = recordName
    }
    return dict
  }

  // MARK: - syncRecords

  /// Syncs an array of CloudKit record dictionaries into a SwiftData store.
  ///
  /// For each dict, calls `fromRecord(_:context:type:)`. New models are inserted;
  /// existing models (matched by `recordName`) are updated in place.
  ///
  /// Changes are accumulated in the context but **not saved** — call
  /// `context.save()` after this method if you want the changes to persist to disk.
  ///
  /// - Parameters:
  ///   - records: Array of record dictionaries in expo-cloudkit format.
  ///   - context: The model context to operate on.
  ///   - type:    The concrete `PersistentModel` type. Inferred when possible.
  /// - Throws:    The first error encountered, if any. Partial results may have
  ///              been applied to the context before the error was thrown.
  public static func syncRecords<T: PersistentModel>(
    _ records: [[String: Any]],
    context: ModelContext,
    type: T.Type = T.self
  ) throws {
    for record in records {
      _ = try fromRecord(record, context: context, type: type)
    }
  }

  // MARK: - Private helpers — property assignment

  /// Uses `Mirror` to locate the named property and assigns `value` via KVC.
  /// Silently ignores properties that cannot be resolved or are not KVC-compliant.
  private static func assignProperty(
    named name: String,
    value: Any?,
    on object: some AnyObject,
    mirror: Mirror
  ) {
    guard let nsObject = object as? NSObject, let value = value else { return }

    // Only assign if the property exists in the mirror to avoid spurious KVC crashes.
    let exists = mirror.children.contains { $0.label == name }
    guard exists else { return }

    nsObject.setValue(value, forKey: name)
  }

  // MARK: - Private helpers — field type coercion

  /// Coerces a raw value from an expo-cloudkit field dict to a Swift type
  /// appropriate for model assignment.
  private static func coerce(value: Any, toType typeStr: String) -> Any? {
    switch typeStr {
    case "string":
      return value as? String

    case "number":
      if let n = value as? Double { return n }
      if let n = value as? Int    { return Double(n) }
      if let n = value as? NSNumber { return n.doubleValue }
      return nil

    case "date":
      // expo-cloudkit stores dates as Unix milliseconds.
      if let ms = (value as? NSNumber)?.doubleValue {
        return Date(timeIntervalSince1970: ms / 1_000)
      }
      return nil

    case "data":
      // expo-cloudkit stores Data as a base64 string.
      if let b64 = value as? String {
        return Data(base64Encoded: b64)
      }
      return nil

    default:
      return nil
    }
  }

  // MARK: - Private helpers — field encoding

  /// Encodes a model property value to an expo-cloudkit field dictionary.
  /// Returns `nil` for types the bridge does not know how to serialise
  /// (e.g. `CLLocation`, `CKAsset`).
  private static func encodeField(value: Any, label: String) -> [String: Any]? {
    switch value {
    case let s as String:
      return ["type": "string", "value": s]

    case let d as Double:
      return ["type": "number", "value": d]

    case let i as Int:
      return ["type": "number", "value": Double(i)]

    case let f as Float:
      return ["type": "number", "value": Double(f)]

    case let date as Date:
      // Convert back to Unix milliseconds.
      return ["type": "date", "value": date.timeIntervalSince1970 * 1_000]

    case let data as Data:
      return ["type": "data", "value": data.base64EncodedString()]

    case let bool as Bool:
      // Booleans are encoded as numbers (0 / 1) to match JS expectations.
      return ["type": "number", "value": bool ? 1.0 : 0.0]

    case let optional as (any OptionalProtocol):
      // Unwrap Optionals recursively.
      if let inner = optional.wrapped {
        return encodeField(value: inner, label: label)
      }
      return nil

    default:
      // Unsupported type — skip silently.
      return nil
    }
  }
}

// MARK: - OptionalProtocol helper

/// Internal protocol that lets us unwrap `Optional<T>` at runtime without
/// knowing the wrapped type at compile time.
private protocol OptionalProtocol {
  var wrapped: Any? { get }
}

extension Optional: OptionalProtocol {
  var wrapped: Any? { self.map { $0 as Any } }
}

// MARK: - Error type

/// Errors that can be thrown by `CloudKitSwiftDataBridge`.
@available(iOS 17.0, *)
public enum CloudKitSwiftDataBridgeError: Error, LocalizedError {
  /// The record dictionary had no `"recordName"` key.
  case missingRecordName
  /// The model class has no `static var recordType: String` property.
  case missingRecordType(String)
  /// The default initialiser could not be invoked (all stored properties need default values).
  case cannotInstantiate(String)

  public var errorDescription: String? {
    switch self {
    case .missingRecordName:
      return "The record dictionary is missing the required 'recordName' key."
    case .missingRecordType(let typeName):
      return "\(typeName) must expose a `static var recordType: String` property for CloudKitSwiftDataBridge.toRecord to work."
    case .cannotInstantiate(let typeName):
      return "\(typeName) could not be instantiated. Ensure all stored properties have default values."
    }
  }
}

#endif // canImport(SwiftData)
