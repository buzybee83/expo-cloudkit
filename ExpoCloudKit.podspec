require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoCloudKit'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Expo'
  s.homepage       = 'https://github.com/buzybee83/expo-cloudkit'
  s.platform       = :ios, '13.4'
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/buzybee83/expo-cloudkit.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.exclude_files = 'ios/Tests/**/*'
end
