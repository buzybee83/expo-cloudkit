// swift-tools-version: 5.9
// NOTE: Full SPM support requires ExpoModulesCore to ship a Package.swift.
// Until then, this package compiles the CloudKit managers standalone (no Expo
// dependency). The Expo module entry point is guarded with #if canImport(ExpoModulesCore)
// and compiles to nothing when ExpoModulesCore is absent.
// Expo projects: continue using CocoaPods — no changes needed.
// Pure Swift projects: CloudKitRecordManager, CloudKitZoneManager, etc. are available via SPM today.

import PackageDescription

let package = Package(
    name: "ExpoCloudKit",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "ExpoCloudKit",
            targets: ["ExpoCloudKit"]
        )
    ],
    dependencies: [
        // ExpoModulesCore does not yet publish a Package.swift.
        // Uncomment when available:
        // .package(url: "https://github.com/expo/expo.git", from: "53.0.0"),
    ],
    targets: [
        .target(
            name: "ExpoCloudKit",
            dependencies: [
                // .product(name: "ExpoModulesCore", package: "expo"),
            ],
            path: "ios",
            exclude: ["Tests"]
        ),
        .testTarget(
            name: "ExpoCloudKitTests",
            dependencies: ["ExpoCloudKit"],
            path: "ios/Tests"
        )
    ]
)
