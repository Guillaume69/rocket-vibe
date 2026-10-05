Pod::Spec.new do |s|
  s.name           = 'NotificationReply'
  s.version        = '1.0.0'
  s.summary        = 'Reply from a notification (iOS)'
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
