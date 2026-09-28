Pod::Spec.new do |s|
  s.name           = 'ReponseNotif'
  s.version        = '1.0.0'
  s.summary        = 'Répondre depuis une notification (iOS)'
  s.author         = ''
  s.homepage       = 'https://github.com/Guillaume69/rocket-vibe'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
