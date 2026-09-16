require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'RNUIAcceptance'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.homepage     = 'https://github.com/ehaier/react-native-ui-acceptance'
  s.author       = { 'Haier' => 'mobile@haier.com' }
  s.source       = { :git => 'https://github.com/ehaier/react-native-ui-acceptance.git', :tag => "v#{s.version}" }
  s.ios.deployment_target = '15.1'
  s.source_files = 'ios/**/*.{h,m,mm}'
  s.requires_arc = true
  s.dependency 'React-Core'
end
