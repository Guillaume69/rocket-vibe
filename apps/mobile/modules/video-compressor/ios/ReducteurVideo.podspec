Pod::Spec.new do |s|
  s.name           = 'ReducteurVideo'
  s.version        = '1.0.0'
  s.summary        = 'Réduction vidéo avant envoi (AVFoundation)'
  s.author         = ''
  s.homepage       = 'https://github.com/Guillaume69/rocket-vibe'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
