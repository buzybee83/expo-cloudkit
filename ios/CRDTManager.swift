import CloudKit
import Foundation

// MARK: - CRDTManager

/// Applies CRDT merge logic when the sync engine receives conflicting records.
///
/// The schema maps field names to CRDT types. Only fields present in the schema
/// are CRDT-merged; all other fields fall back to server-wins.
///
/// # Shadow Fields
/// Each CRDT-governed field `<name>` is backed by a hidden shadow field
/// `__crdt_<name>` that stores the full CRDT state blob as a JSON string.
/// The plain field `<name>` stores the materialised value for normal reads.
///
/// # Compaction
/// After every merge, if the shadow field's serialised size exceeds 100 KB,
/// `CRDTMerger.compact` is called to prune tombstones / dead state.
///
/// # Thread Safety
/// `CRDTManager` itself is stateless beyond its immutable `schema` and `nodeId`
/// properties. All mutable state is carried in the caller's record dictionaries.
final class CRDTManager {

  // MARK: - Properties

  /// Maps field name → CRDT type for the configured schema.
  let schema: [String: CRDTType]

  /// Stable per-device identifier used for node-level counters / LWW tags.
  /// Stored in UserDefaults on first use, then reused across launches.
  let nodeId: String

  // MARK: - Shadow field key prefix

  private static let shadowPrefix = "__crdt_"

  // MARK: - Compaction threshold: 100 KB

  private static let compactionThreshold = 100 * 1024

  // MARK: - Init

  init(schema: [String: CRDTType]) {
    self.schema = schema
    self.nodeId = CRDTManager.loadOrCreateNodeId()
  }

  // MARK: - Node ID persistence

  private static let nodeIdKey = "expo.cloudkit.crdt.nodeId"

  private static func loadOrCreateNodeId() -> String {
    if let stored = UserDefaults.standard.string(forKey: nodeIdKey) {
      return stored
    }
    let new = UUID().uuidString
    UserDefaults.standard.set(new, forKey: nodeIdKey)
    return new
  }

  // MARK: - Merge (conflict resolution)

  /// Merges two conflicting record dictionaries.
  ///
  /// For each field in `schema`, the CRDT states from `client` and `server`
  /// are merged and the materialised value is written to the result.
  /// All other fields use server-wins (standard CloudKit behaviour).
  ///
  /// - Parameters:
  ///   - client: The local record dictionary (`[String: Any]` from `Converters.toDictionary`).
  ///   - server: The server record dictionary.
  /// - Returns: A merged record dictionary ready to enqueue for re-save.
  func merge(client: [String: Any], server: [String: Any]) -> [String: Any] {
    var result = server  // Start with server as base (server-wins for non-CRDT fields).

    let clientFields = client["fields"] as? [String: [String: Any]] ?? [:]
    var resultFields = result["fields"] as? [String: [String: Any]] ?? [:]

    for (fieldName, crdtType) in schema {
      let shadowKey = CRDTManager.shadowPrefix + fieldName

      // Extract CRDT state blobs from both sides.
      let clientState  = crdtStateFromFields(clientFields, shadowKey: shadowKey)
      let serverState  = crdtStateFromFields(resultFields, shadowKey: shadowKey)

      // Merge the states.
      var merged: [String: Any]
      switch crdtType {
      case .lwwRegister:
        merged = CRDTMerger.mergeLWW(clientState, serverState)
      case .gCounter:
        merged = CRDTMerger.mergeGCounter(clientState, serverState)
      case .pnCounter:
        merged = CRDTMerger.mergePNCounter(clientState, serverState)
      case .orSet:
        merged = CRDTMerger.mergeORSet(clientState, serverState)
      }

      // Compact if the blob would exceed the threshold.
      merged = compactIfNeeded(merged, type: crdtType)

      // Write merged CRDT state back as shadow field.
      resultFields[shadowKey] = encodeState(merged)

      // Write materialised value into the user-visible field.
      if let materialised = materialiseValue(state: merged, type: crdtType) {
        resultFields[fieldName] = materialised
      }
    }

    result["fields"] = resultFields
    return result
  }

  // MARK: - Mutation: PN-Counter / G-Counter increment

  /// Applies a counter delta to a record field.
  ///
  /// - For `pncounter`: increments P (delta > 0) or N (delta < 0) sub-counter.
  /// - For `gcounter`: increments the node's counter by `delta` (must be ≥ 1).
  ///
  /// Writes the updated shadow field and materialised value in-place.
  ///
  /// - Parameters:
  ///   - record: Mutable record dictionary (as produced by `Converters.toDictionary`).
  ///   - field:  Field name in `schema`.
  ///   - delta:  Amount to increment. Negative values are valid for `pncounter` only.
  func applyIncrement(to record: inout [String: Any], field: String, delta: Int) throws {
    guard let crdtType = schema[field] else {
      throw CRDTError.fieldNotInSchema(field)
    }
    guard crdtType == .pnCounter || crdtType == .gCounter else {
      throw CRDTError.invalidOperationForType(operation: "increment", type: crdtType)
    }
    if crdtType == .gCounter && delta < 1 {
      throw CRDTError.invalidDelta("G-Counter delta must be ≥ 1")
    }

    let shadowKey = CRDTManager.shadowPrefix + field
    var fields = record["fields"] as? [String: [String: Any]] ?? [:]
    var state  = crdtStateFromFields(fields, shadowKey: shadowKey)

    switch crdtType {
    case .gCounter:
      var counters = state
      let current = (counters[nodeId] as? Int) ?? 0
      counters[nodeId] = current + delta
      state = counters

    case .pnCounter:
      var p = state["P"] as? [String: Any] ?? [:]
      var n = state["N"] as? [String: Any] ?? [:]
      if delta >= 0 {
        let current = (p[nodeId] as? Int) ?? 0
        p[nodeId] = current + delta
      } else {
        let current = (n[nodeId] as? Int) ?? 0
        n[nodeId] = current + (-delta)
      }
      state = ["P": p, "N": n]

    default:
      break  // Unreachable due to guard above.
    }

    state = compactIfNeeded(state, type: crdtType)
    fields[shadowKey] = encodeState(state)
    if let materialised = materialiseValue(state: state, type: crdtType) {
      fields[field] = materialised
    }
    record["fields"] = fields
  }

  // MARK: - Mutation: OR-Set add

  /// Adds a string value to the OR-Set field, tagging it with a fresh UUID.
  func applyAdd(to record: inout [String: Any], field: String, value: String) throws {
    guard let crdtType = schema[field] else {
      throw CRDTError.fieldNotInSchema(field)
    }
    guard crdtType == .orSet else {
      throw CRDTError.invalidOperationForType(operation: "add", type: crdtType)
    }

    let shadowKey = CRDTManager.shadowPrefix + field
    var fields = record["fields"] as? [String: [String: Any]] ?? [:]
    var state  = crdtStateFromFields(fields, shadowKey: shadowKey)

    state = CRDTMerger.addToORSet(state, value: value, nodeId: nodeId)
    state = compactIfNeeded(state, type: .orSet)

    fields[shadowKey] = encodeState(state)
    fields[field] = materialiseORSetField(state)
    record["fields"] = fields
  }

  // MARK: - Mutation: OR-Set remove

  /// Removes a string value from the OR-Set field.
  func applyRemove(to record: inout [String: Any], field: String, value: String) throws {
    guard let crdtType = schema[field] else {
      throw CRDTError.fieldNotInSchema(field)
    }
    guard crdtType == .orSet else {
      throw CRDTError.invalidOperationForType(operation: "remove", type: crdtType)
    }

    let shadowKey = CRDTManager.shadowPrefix + field
    var fields = record["fields"] as? [String: [String: Any]] ?? [:]
    var state  = crdtStateFromFields(fields, shadowKey: shadowKey)

    state = CRDTMerger.removeFromORSet(state, value: value)
    state = compactIfNeeded(state, type: .orSet)

    fields[shadowKey] = encodeState(state)
    fields[field] = materialiseORSetField(state)
    record["fields"] = fields
  }

  // MARK: - Mutation: LWW-Register set

  /// Sets the LWW-Register to a new value, stamped with the current time.
  ///
  /// The `value` parameter can be any JSON-serialisable type that is valid as
  /// a CloudKit field value (String, NSNumber, etc.).
  func applySet(to record: inout [String: Any], field: String, value: Any) throws {
    guard let crdtType = schema[field] else {
      throw CRDTError.fieldNotInSchema(field)
    }
    guard crdtType == .lwwRegister else {
      throw CRDTError.invalidOperationForType(operation: "set", type: crdtType)
    }

    let shadowKey = CRDTManager.shadowPrefix + field
    var fields = record["fields"] as? [String: [String: Any]] ?? [:]

    let state: [String: Any] = [
      "ts": Date().timeIntervalSince1970,
      "value": value,
      "nodeId": nodeId
    ]

    fields[shadowKey] = encodeState(state)

    // Materialise: the value itself goes into the named field.
    // We wrap it in a `RecordField`-shaped dict that Converters expects.
    let fieldType = inferFieldType(value)
    fields[field] = ["type": fieldType, "value": value]
    record["fields"] = fields
  }

  // MARK: - Materialised value extraction

  /// Extracts the materialised value from a CRDT shadow field in a record dict.
  ///
  /// Returns nil if the field is not governed by this manager's schema,
  /// or if the field has never been written.
  func materializedValue(record: [String: Any], field: String) -> Any? {
    guard schema[field] != nil else { return nil }
    let fields = record["fields"] as? [String: [String: Any]] ?? [:]
    return fields[field]?["value"]
  }

  // MARK: - Private helpers

  /// Reads the CRDT state blob from a shadow field, deserialising from JSON.
  /// Returns an empty dictionary if the field is absent or malformed.
  private func crdtStateFromFields(_ fields: [String: [String: Any]], shadowKey: String) -> [String: Any] {
    guard let shadowField = fields[shadowKey],
          let jsonString  = shadowField["value"] as? String,
          let data        = jsonString.data(using: .utf8),
          let parsed      = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return [:]
    }
    return parsed
  }

  /// Serialises a CRDT state dictionary to a JSON string and wraps it in a
  /// RecordField-shaped dict `{ type: "string", value: "<json>" }`.
  private func encodeState(_ state: [String: Any]) -> [String: Any] {
    guard let data = try? JSONSerialization.data(withJSONObject: state),
          let json = String(data: data, encoding: .utf8)
    else {
      return ["type": "string", "value": "{}"]
    }
    return ["type": "string", "value": json]
  }

  /// Runs compaction if the serialised size of `state` exceeds the threshold.
  private func compactIfNeeded(_ state: [String: Any], type: CRDTType) -> [String: Any] {
    guard let data = try? JSONSerialization.data(withJSONObject: state),
          data.count > CRDTManager.compactionThreshold
    else {
      return state
    }
    return CRDTMerger.compact(state, type: type)
  }

  /// Produces a `{ type, value }` field dict from a CRDT state for the materialised
  /// value. Returns nil if no materialised value is appropriate (e.g. empty OR-Set).
  private func materialiseValue(state: [String: Any], type: CRDTType) -> [String: Any]? {
    switch type {
    case .lwwRegister:
      guard let value = state["value"] else { return nil }
      let fieldType = inferFieldType(value)
      return ["type": fieldType, "value": value]
    case .gCounter:
      return ["type": "number", "value": CRDTMerger.valueGCounter(state)]
    case .pnCounter:
      return ["type": "number", "value": CRDTMerger.valuePNCounter(state)]
    case .orSet:
      return materialiseORSetField(state)
    }
  }

  /// Materialises an OR-Set state into a `{ type: "stringList", value: [String] }` field.
  private func materialiseORSetField(_ state: [String: Any]) -> [String: Any] {
    let members = CRDTMerger.membersORSet(state)
    return ["type": "stringList", "value": members]
  }

  /// Infers a RecordField `type` string from a Swift value for LWW materialisation.
  private func inferFieldType(_ value: Any) -> String {
    switch value {
    case is String:    return "string"
    case is NSNumber:  return "number"
    case is Date:      return "date"
    case is [String]:  return "stringList"
    default:           return "string"
    }
  }
}

// MARK: - CRDTError

enum CRDTError: Error, LocalizedError {
  case fieldNotInSchema(String)
  case invalidOperationForType(operation: String, type: CRDTType)
  case invalidDelta(String)

  var errorDescription: String? {
    switch self {
    case .fieldNotInSchema(let f):
      return "Field '\(f)' is not registered in the CRDT schema."
    case .invalidOperationForType(let op, let t):
      return "Operation '\(op)' is not valid for CRDT type '\(t.rawValue)'."
    case .invalidDelta(let msg):
      return msg
    }
  }
}
