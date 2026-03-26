import Foundation

// MARK: - CRDT Type

/// Identifies which CRDT algorithm governs a field.
enum CRDTType: String {
  case lwwRegister = "lww"
  case gCounter    = "gcounter"
  case pnCounter   = "pncounter"
  case orSet       = "orset"
}

// MARK: - CRDTMerger

/// Pure CRDT merge functions. Operates on JSON-serializable dictionaries.
///
/// All state blobs are persisted as JSON in `__crdt_<fieldName>` shadow
/// fields on a CKRecord. The materialized user-visible value is stored
/// separately in the plain field named `<fieldName>`.
///
/// None of these functions have CloudKit dependencies — they are plain
/// dictionary-in, dictionary-out transformations that can be unit-tested
/// without a CloudKit sandbox.
enum CRDTMerger {

  // MARK: - LWW-Register

  /// Last-writer-wins register merge.
  ///
  /// State shape: `{ "ts": Double, "value": Any, "nodeId": String }`
  ///
  /// The entry with the higher timestamp wins. When timestamps are equal,
  /// the higher `nodeId` string wins (arbitrary but deterministic tiebreak).
  static func mergeLWW(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] {
    let tsA = a["ts"] as? Double ?? 0
    let tsB = b["ts"] as? Double ?? 0

    if tsA > tsB {
      return a
    } else if tsB > tsA {
      return b
    } else {
      // Equal timestamps: higher nodeId wins for a deterministic tiebreak.
      let nodeA = a["nodeId"] as? String ?? ""
      let nodeB = b["nodeId"] as? String ?? ""
      return nodeA >= nodeB ? a : b
    }
  }

  // MARK: - G-Counter (grow-only)

  /// G-Counter merge: element-wise maximum of node counters.
  ///
  /// State shape: `{ "<nodeId>": Int, "<nodeId2>": Int, ... }`
  ///
  /// The merge result contains every nodeId from both states, with the
  /// maximum count for each. Because counts only grow, this is associative,
  /// commutative, and idempotent.
  static func mergeGCounter(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] {
    var result: [String: Any] = a
    for (nodeId, countB) in b {
      let intB = (countB as? Int) ?? (countB as? NSNumber).map { $0.intValue } ?? 0
      let intA = (result[nodeId] as? Int) ?? (result[nodeId] as? NSNumber).map { $0.intValue } ?? 0
      result[nodeId] = max(intA, intB)
    }
    return result
  }

  /// Materialises a G-Counter to a single integer by summing all node values.
  static func valueGCounter(_ state: [String: Any]) -> Int {
    return state.values.reduce(0) { acc, v in
      let n = (v as? Int) ?? (v as? NSNumber).map { $0.intValue } ?? 0
      return acc + n
    }
  }

  // MARK: - PN-Counter (positive/negative)

  /// PN-Counter merge: element-wise max of P and N sub-counters.
  ///
  /// State shape: `{ "P": { "<nodeId>": Int }, "N": { "<nodeId>": Int } }`
  ///
  /// P tracks increments, N tracks decrements. The net value is sum(P)-sum(N).
  static func mergePNCounter(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] {
    let pA = a["P"] as? [String: Any] ?? [:]
    let pB = b["P"] as? [String: Any] ?? [:]
    let nA = a["N"] as? [String: Any] ?? [:]
    let nB = b["N"] as? [String: Any] ?? [:]

    return [
      "P": mergeGCounter(pA, pB),
      "N": mergeGCounter(nA, nB)
    ]
  }

  /// Materialises a PN-Counter: sum(P) - sum(N).
  static func valuePNCounter(_ state: [String: Any]) -> Int {
    let p = state["P"] as? [String: Any] ?? [:]
    let n = state["N"] as? [String: Any] ?? [:]
    return valueGCounter(p) - valueGCounter(n)
  }

  // MARK: - OR-Set (observed-remove set)

  /// OR-Set merge: union of all UUID tag sets for each element.
  ///
  /// State shape: `{ "elements": { "<value>": ["<uuid1>", "<uuid2>"] } }`
  ///
  /// An element is a member of the set when its UUID list is non-empty.
  /// Remove assigns an empty list (deletes all UUIDs). Add assigns a fresh UUID.
  /// Merge is union: an element present in either state (with any UUID) survives.
  static func mergeORSet(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] {
    var elemA = a["elements"] as? [String: [String]] ?? [:]
    let elemB = b["elements"] as? [String: [String]] ?? [:]

    for (value, uuidsB) in elemB {
      if let existing = elemA[value] {
        // Union: keep all UUIDs from both sides, deduplicated.
        let merged = Array(Set(existing).union(Set(uuidsB)))
        elemA[value] = merged
      } else {
        elemA[value] = uuidsB
      }
    }

    return ["elements": elemA]
  }

  /// Adds a value to the OR-Set by tagging it with a fresh UUID.
  ///
  /// Any existing UUIDs for this value are preserved (union semantics).
  /// A concurrent remove on another node will lose to this add (correct OR-Set behaviour).
  static func addToORSet(_ state: [String: Any], value: String, nodeId: String) -> [String: Any] {
    var elems = state["elements"] as? [String: [String]] ?? [:]
    let newTag = "\(nodeId)-\(UUID().uuidString)"
    var tags = elems[value] ?? []
    tags.append(newTag)
    elems[value] = tags
    return ["elements": elems]
  }

  /// Removes a value from the OR-Set by clearing all its UUID tags.
  ///
  /// Any in-flight concurrent adds that produce new UUIDs after this remove
  /// will cause the element to re-appear on the next merge (correct OR-Set semantics).
  static func removeFromORSet(_ state: [String: Any], value: String) -> [String: Any] {
    var elems = state["elements"] as? [String: [String]] ?? [:]
    elems[value] = []   // Empty, not deleted — preserves the key for GC tracking.
    return ["elements": elems]
  }

  /// Returns the current members of the OR-Set (all values with at least one UUID tag).
  static func membersORSet(_ state: [String: Any]) -> [String] {
    let elems = state["elements"] as? [String: [String]] ?? [:]
    return elems.compactMap { (value, uuids) in uuids.isEmpty ? nil : value }
  }

  // MARK: - Compaction

  /// Compacts oversized CRDT state blobs.
  ///
  /// Called when the serialised blob exceeds 100 KB.
  ///
  /// - G-Counter and PN-Counter are already minimal — no-op.
  /// - LWW-Register is already minimal — no-op.
  /// - OR-Set: prunes elements whose UUID list is empty (tombstones with no adds).
  static func compact(_ state: [String: Any], type: CRDTType) -> [String: Any] {
    switch type {
    case .orSet:
      var elems = state["elements"] as? [String: [String]] ?? [:]
      elems = elems.filter { !$0.value.isEmpty }
      return ["elements": elems]
    case .lwwRegister, .gCounter, .pnCounter:
      // These formats have no dead weight to remove.
      return state
    }
  }
}
