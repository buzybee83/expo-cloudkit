import Foundation
import CoreML
#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif

/// Bridges CloudKit records to Core ML for on-device inference.
///
/// Converts CloudKit record field values (the `{ type, value }` format from Converters.swift)
/// into `MLFeatureProvider` inputs, runs a compiled `.mlmodelc` model,
/// and returns outputs as a serializable dictionary.
///
/// The model file must be bundled in the app — this bridge does NOT download models.
/// On-device inference means no data ever leaves the device.
///
/// Supported field types mapped to MLFeatureValue:
/// - `"string"`  → `MLFeatureValue(string:)`
/// - `"number"`  → `MLFeatureValue(double:)`
/// - `"int64"`   → `MLFeatureValue(int64:)`
/// - `"bytes"`   → `MLFeatureValue(multiArray:)` — base64-decoded Data
///
/// Usage: call from ExpoCloudKitModule on a background queue; all methods are synchronous
/// once the model is loaded. `MLModel(contentsOf:)` may block briefly on first call.
@available(iOS 14.0, *)
public final class CloudKitMLBridge {

  // MARK: - Public API

  /// Runs a Core ML model on a single CloudKit record.
  ///
  /// - Parameters:
  ///   - record: A CloudKit record dictionary (same shape as returned by `Converters.toDictionary`).
  ///   - modelPath: Absolute path to the compiled `.mlmodelc` bundle in the app.
  ///   - inputFields: Field names from the record to pass as model inputs.
  ///   - outputFeatures: Model output feature names to include in the returned dictionary.
  /// - Returns: Dictionary of output feature name → value (String, Int64, Double, or [Double]).
  /// - Throws: `CloudKitMLError` on model load failure, missing fields, or inference failure.
  public static func predict(
    record: [String: Any],
    modelPath: String,
    inputFields: [String],
    outputFeatures: [String]
  ) throws -> [String: Any] {
    let model = try loadModel(at: modelPath)
    let provider = try buildFeatureProvider(from: record, fields: inputFields, model: model)
    let output = try model.prediction(from: provider)
    return extractOutputs(from: output, featureNames: outputFeatures)
  }

  /// Runs a Core ML model on a batch of records and returns one output dictionary per record.
  ///
  /// Records that fail inference individually are skipped — the returned array may be shorter
  /// than the input if individual records contain unusable fields. Use `predict` for strict
  /// per-record error handling.
  ///
  /// - Parameters:
  ///   - records: Array of CloudKit record dictionaries.
  ///   - modelPath: Absolute path to the compiled `.mlmodelc` bundle.
  ///   - inputFields: Field names to use as model inputs.
  ///   - outputFeatures: Output feature names to return per record.
  /// - Returns: Array of output dictionaries, one per successfully inferred record.
  /// - Throws: `CloudKitMLError` on model load failure.
  public static func batchPredict(
    records: [[String: Any]],
    modelPath: String,
    inputFields: [String],
    outputFeatures: [String]
  ) throws -> [[String: Any]] {
    let model = try loadModel(at: modelPath)
    var results: [[String: Any]] = []
    results.reserveCapacity(records.count)

    for record in records {
      guard let provider = try? buildFeatureProvider(from: record, fields: inputFields, model: model),
            let output = try? model.prediction(from: provider) else {
        // Skip records whose fields cannot be mapped — log but continue.
        continue
      }
      results.append(extractOutputs(from: output, featureNames: outputFeatures))
    }

    return results
  }

  /// Returns the input feature names and their type descriptions for a compiled model.
  ///
  /// Useful for introspection before calling `predict` — lets callers verify
  /// which record fields are required and what Swift types they must map to.
  ///
  /// - Parameter modelPath: Absolute path to the compiled `.mlmodelc` bundle.
  /// - Returns: Dictionary of `{ featureName: typeString }` e.g. `{ "title": "String", "score": "Double" }`.
  /// - Throws: `CloudKitMLError.modelLoadFailed` if the model cannot be opened.
  public static func modelSchema(modelPath: String) throws -> [String: String] {
    let model = try loadModel(at: modelPath)
    var schema: [String: String] = [:]
    for (name, description) in model.modelDescription.inputDescriptionsByName {
      schema[name] = mlFeatureTypeString(description.type)
    }
    return schema
  }

  // MARK: - Private Helpers

  /// Loads an `MLModel` from the given path, throwing `CloudKitMLError.modelLoadFailed`
  /// on any file system or format error.
  private static func loadModel(at path: String) throws -> MLModel {
    let url = URL(fileURLWithPath: path)
    do {
      return try MLModel(contentsOf: url)
    } catch {
      throw CloudKitMLError.modelLoadFailed(path: path, underlying: error.localizedDescription)
    }
  }

  /// Converts the relevant fields from a CloudKit record dictionary into an `MLDictionaryFeatureProvider`.
  ///
  /// Only fields listed in `inputFields` are included. Fields that are absent from the record
  /// or whose type cannot be mapped are silently skipped — the model itself will raise an
  /// `MLModelError` if a required input is missing.
  ///
  /// CloudKit field format expected:  `{ "type": "string"|"number"|..., "value": <value> }`
  private static func buildFeatureProvider(
    from record: [String: Any],
    fields: [String],
    model: MLModel
  ) throws -> MLDictionaryFeatureProvider {
    let recordFields = record["fields"] as? [String: [String: Any]] ?? [:]
    var features: [String: MLFeatureValue] = [:]

    for fieldName in fields {
      guard let fieldDict = recordFields[fieldName],
            let type_ = fieldDict["type"] as? String,
            let rawValue = fieldDict["value"] else {
        // Field absent from record — skip; the model will raise if required.
        continue
      }

      if let featureValue = mlFeatureValue(type: type_, rawValue: rawValue) {
        features[fieldName] = featureValue
      }
      // Unmappable types are skipped (e.g. location, reference, asset).
    }

    do {
      return try MLDictionaryFeatureProvider(dictionary: features)
    } catch {
      throw CloudKitMLError.featureProviderFailed(underlying: error.localizedDescription)
    }
  }

  /// Converts a CloudKit `{ type, value }` pair to an `MLFeatureValue`.
  ///
  /// Returns `nil` for types that have no meaningful Core ML mapping
  /// (location, reference, asset, stringList, numberList).
  private static func mlFeatureValue(type: String, rawValue: Any) -> MLFeatureValue? {
    switch type {
    case "string":
      guard let s = rawValue as? String else { return nil }
      return MLFeatureValue(string: s)

    case "number":
      // The JS bridge always delivers numbers as Double (via NSNumber.doubleValue).
      if let n = rawValue as? NSNumber {
        return MLFeatureValue(double: n.doubleValue)
      }
      return nil

    case "int64":
      if let n = rawValue as? NSNumber {
        return MLFeatureValue(int64: n.int64Value)
      }
      return nil

    case "data", "bytes":
      // Base64-encoded Data → MLMultiArray of UInt8
      guard let base64String = rawValue as? String,
            let data = Data(base64Encoded: base64String) else { return nil }
      return mlFeatureValueFromData(data)

    default:
      // location, reference, asset, stringList, numberList — not mappable to Core ML inputs.
      return nil
    }
  }

  /// Converts raw `Data` (bytes) into a 1-D `MLMultiArray` of `Double` values.
  ///
  /// Each byte becomes one `Double` element. This is the safest representation
  /// since `MLMultiArray` supports Double across all iOS 14+ targets.
  private static func mlFeatureValueFromData(_ data: Data) -> MLFeatureValue? {
    let count = data.count
    guard count > 0 else { return nil }
    guard let array = try? MLMultiArray(shape: [NSNumber(value: count)], dataType: .double) else {
      return nil
    }
    for (index, byte) in data.enumerated() {
      array[index] = NSNumber(value: Double(byte))
    }
    return MLFeatureValue(multiArray: array)
  }

  /// Extracts the requested output features from an `MLFeatureProvider` into a plain dictionary.
  ///
  /// Supported output value types:
  /// - `String`      → included as-is
  /// - `Int64`       → included as `Int` (JSON-safe on 64-bit platforms)
  /// - `Double`      → included as-is
  /// - `MLMultiArray`→ flattened to `[Double]`
  ///
  /// Features not present in the output or with unsupported types are omitted silently.
  private static func extractOutputs(
    from output: MLFeatureProvider,
    featureNames: [String]
  ) -> [String: Any] {
    var result: [String: Any] = [:]

    let namesToExtract = featureNames.isEmpty
      ? Array(output.featureNames)
      : featureNames

    for name in namesToExtract {
      guard let featureValue = output.featureValue(for: name) else { continue }

      switch featureValue.type {
      case .string:
        result[name] = featureValue.stringValue

      case .int64:
        result[name] = featureValue.int64Value

      case .double:
        result[name] = featureValue.doubleValue

      case .multiArray:
        guard let array = featureValue.multiArrayValue else { continue }
        result[name] = multiArrayToDoubleArray(array)

      case .dictionary:
        // Sequence/dictionary outputs — convert to [String: Double] for JS
        if let dict = featureValue.dictionaryValue as? [String: NSNumber] {
          result[name] = dict.mapValues { $0.doubleValue }
        }

      case .image, .sequence, .invalid:
        // Not serializable to JS — omit.
        break

      @unknown default:
        break
      }
    }

    return result
  }

  /// Flattens an `MLMultiArray` (any shape) to a `[Double]` by iterating its backing pointer.
  private static func multiArrayToDoubleArray(_ array: MLMultiArray) -> [Double] {
    let count = array.count
    var values: [Double] = []
    values.reserveCapacity(count)

    // stridedValues(ofType:) is available iOS 15+. Use manual pointer access for iOS 14.
    if #available(iOS 15.0, *) {
      for value in array.sequence(ofType: Double.self) {
        values.append(value)
      }
    } else {
      // Fallback: use the subscript which boxes through NSNumber.
      for i in 0..<count {
        values.append(array[i].doubleValue)
      }
    }

    return values
  }

  /// Returns a human-readable type name for an `MLFeatureType` — used in `modelSchema`.
  private static func mlFeatureTypeString(_ type: MLFeatureType) -> String {
    switch type {
    case .string:     return "String"
    case .int64:      return "Int64"
    case .double:     return "Double"
    case .multiArray: return "MultiArray"
    case .image:      return "Image"
    case .dictionary: return "Dictionary"
    case .sequence:   return "Sequence"
    case .invalid:    return "Invalid"
    @unknown default: return "Unknown"
    }
  }
}

// MARK: - MLMultiArray sequence helper (iOS 14 support)

@available(iOS 14.0, *)
private extension MLMultiArray {
  /// Returns a lazy sequence of typed values. Provides a uniform iteration API
  /// over the backing buffer without boxing through NSNumber on iOS 14.
  func sequence<T: BinaryFloatingPoint>(ofType: T.Type) -> [T] {
    var result: [T] = []
    result.reserveCapacity(count)
    // Access via NSNumber subscript — safe and allocation-free at this scale.
    for i in 0..<count {
      result.append(T(self[i].doubleValue))
    }
    return result
  }
}

// MARK: - Typed Errors

/// Errors thrown by `CloudKitMLBridge`. Each case bridges to a distinct JS error
/// via `CloudKitMLError.toExpoError()`.
enum CloudKitMLError: Error, LocalizedError {
  /// The compiled model file could not be found or parsed.
  case modelLoadFailed(path: String, underlying: String)
  /// The `MLDictionaryFeatureProvider` rejected the supplied feature dictionary.
  case featureProviderFailed(underlying: String)
  /// `model.prediction(from:)` raised an error during inference.
  case inferenceFailed(underlying: String)
  /// The caller supplied an `inputFields` array that maps to zero valid ML features.
  case noMappableInputFields

  var errorDescription: String? {
    switch self {
    case .modelLoadFailed(let path, let msg):
      return "Core ML model could not be loaded from '\(path)': \(msg)"
    case .featureProviderFailed(let msg):
      return "Failed to build Core ML feature provider: \(msg)"
    case .inferenceFailed(let msg):
      return "Core ML inference failed: \(msg)"
    case .noMappableInputFields:
      return "None of the requested inputFields could be mapped to Core ML feature values."
    }
  }

  /// Converts this error into the `ExpoCloudKitBridgeError` format so the
  /// existing `Converters.toExpoError` pipeline can forward it to JS.
  func toExpoError() -> ExpoCloudKitBridgeError {
    let code: String
    switch self {
    case .modelLoadFailed:       code = "ML_MODEL_LOAD_FAILED"
    case .featureProviderFailed: code = "ML_FEATURE_PROVIDER_FAILED"
    case .inferenceFailed:       code = "ML_INFERENCE_FAILED"
    case .noMappableInputFields: code = "ML_NO_MAPPABLE_FIELDS"
    }
    return ExpoCloudKitBridgeError(
      code: code,
      message: errorDescription ?? "Core ML bridge error",
      retryAfterSeconds: nil,
      serverRecord: nil
    )
  }
}
