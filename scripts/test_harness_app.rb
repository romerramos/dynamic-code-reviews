# frozen_string_literal: true
# The app a harness declares for the checkout: Conductor's preview URLs.
require 'tmpdir'
require 'fileutils'
require_relative '../lib/dcr/harness_app'

def assert(condition, message)
  raise message unless condition
end

Dir.mktmpdir do |tmp|
  root = File.join(tmp, 'shop')
  workspace = File.join(tmp, 'workspaces', 'oslo')
  FileUtils.mkdir_p([File.join(root, '.conductor'), workspace])
  File.write(File.join(root, '.conductor', 'settings.local.toml'), <<~TOML)
    [scripts]
    setup = "bin/setup"

    [[preview_urls]]
    name = "Mailpit"
    url = "https://mailpit.$CONDUCTOR_WORKSPACE_NAME.test"

    [[preview_urls]]
    name = "App"
    url = "https://app.${CONDUCTOR_WORKSPACE_NAME}.test/login"

    [prompts]
    general = "url = \\"nope\\""
  TOML
  env = {'CONDUCTOR_WORKSPACE_PATH' => workspace, 'CONDUCTOR_ROOT_PATH' => root, 'CONDUCTOR_WORKSPACE_NAME' => 'oslo'}

  url, source = DCR::HarnessApp.find(workspace, env)
  assert url == 'https://app.oslo.test/login', "The App preview is used, filled in: #{url.inspect}"
  assert source.include?('settings.local.toml'), "It says where it came from: #{source}"

  assert DCR::HarnessApp.find(root, env).nil?, 'Another checkout than the workspace gets nothing'
  assert DCR::HarnessApp.find(workspace, env.except('CONDUCTOR_WORKSPACE_PATH')).nil?, 'Outside Conductor nothing is guessed'
  assert DCR::HarnessApp.find(workspace, env.except('CONDUCTOR_WORKSPACE_NAME')).nil?, 'A preview naming a missing variable is skipped'

  FileUtils.mkdir_p(File.join(workspace, '.conductor'))
  File.write(File.join(workspace, '.conductor', 'settings.toml'), %([[preview_urls]]\nurl = "http://localhost:$CONDUCTOR_PORT"\n))
  url, = DCR::HarnessApp.find(workspace, env.merge('CONDUCTOR_PORT' => '55100'))
  assert url == 'http://localhost:55100', "The workspace's own settings come first, and an unnamed preview is used: #{url.inspect}"
end
puts 'harness app ok'
