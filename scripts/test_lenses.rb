# frozen_string_literal: true
# Run with ruby scripts/test_lenses.rb. Stdlib only; nothing is fetched.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings
require 'json'
require 'open3'
require 'rbconfig'
require_relative '../lib/dcr/live_api'

def assert(condition, message)
  raise message unless condition
end

DCR_BIN = File.expand_path('../bin/dcr', __dir__)

# Every lens the page can offer has its files, and every one from another author carries that
# author's license and a pinned commit, so a review never reads a file that is not there.
lenses = DCR::Lenses.all
assert(DCR::Lenses.find(DCR::Lenses.default_id), 'The default lens must be one of the lenses')
assert(DCR::Lenses.ids.uniq == DCR::Lenses.ids, 'Lens ids must be unique')
lenses.each do |lens|
  DCR::Lenses.paths(lens).each { |path| assert(File.file?(path) && File.size(path).positive?, "#{lens['id']} reads #{path}, which is missing") }
  assert(lens['read'].first == "#{lens['id']}/LENS.md", "#{lens['id']} must start with its own adapter")
  next unless (upstream = lens['upstream'])
  assert(upstream['commit'].match?(/\A\h{40}\z/), "#{lens['id']} must pin a full commit")
  assert(upstream['files'].values.include?("#{lens['id']}/LICENSE") && File.read(File.join(DCR::Lenses::DIR, lens['id'], 'LICENSE')).include?('Permission is hereby granted'), "#{lens['id']} must carry its author's license")
  lens['read'].drop(1).each { |file| assert(upstream['files'].value?(file), "#{lens['id']} reads #{file}, which `dcr lens update` would not refresh") }
end
puts 'PASS every lens has its files, and every borrowed one its license and pinned commit'

# The choice: none means the default, a known one is kept beside the other settings, an unknown
# one is refused, and a choice whose lens was removed falls back to the default.
settings = DCR::Settings.new
assert(settings.review_lens.nil? && DCR::Lenses.active(settings.review_lens)['id'] == 'dynamic', 'With no choice the default lens is active')
settings.save_adversaries([{'agent' => 'codex'}])
settings.save_review_lens('mattpocock')
settings.save_adversaries([{'agent' => 'gemini'}])
settings.write('colorMode' => 'dark')
assert(settings.review_lens == 'mattpocock', 'Saving other settings must keep the lens')
assert(settings.adversaries.map { |each| each['agent'] } == ['gemini'], 'Saving the lens must keep the adversaries')
begin
  settings.save_review_lens('nope')
  raise 'An unknown lens must be refused'
rescue ArgumentError => error
  assert(error.message.include?('dynamic, addyosmani'), "The refusal names the known lenses: #{error.message}")
end
File.write(settings.path, JSON.generate(JSON.parse(File.read(settings.path)).merge('reviewLens' => 'removed-lens')))
assert(settings.review_lens.nil? && DCR::Lenses.active(settings.review_lens)['id'] == 'dynamic', 'A removed lens falls back to the default')
puts 'PASS the chosen lens is kept with the other settings, validated, and falls back to the default'

# The page lists and saves the choice through the served review's API.
Dir.mktmpdir do |series|
  api = DCR::LiveAPI.new(series)
  code, listed = api.call('GET', '/api/lens', nil)
  assert(code == 200 && listed['active'] == 'dynamic' && listed['lenses'].map { |lens| lens['id'] } == DCR::Lenses.ids, "The page lists every lens: #{listed}")
  assert(listed['lenses'].none? { |lens| lens.key?('read') }, 'The page is not told file paths')
  code, saved = api.call('POST', '/api/lens', -> { JSON.generate('id' => 'pstack') })
  assert(code == 200 && saved['active'] == 'pstack' && DCR::Settings.new.review_lens == 'pstack', "Choosing a lens saves it: #{saved}")
  code, refused = api.call('POST', '/api/lens', -> { JSON.generate('id' => '../etc') })
  assert(code == 400 && refused['error'].start_with?('Unknown review lens') && DCR::Settings.new.review_lens == 'pstack', 'An unknown lens is refused and the choice stays')
end
puts 'PASS the review page lists the lenses and saves the reviewer\'s choice'

# The agent's side: `dcr lens` names the chosen lens and prints the files to read.
out, status = Open3.capture2e(RbConfig.ruby, DCR_BIN, 'lens')
pstack = DCR::Lenses.find('pstack')
assert(status.success? && out.start_with?('Review lens: pstack (poteto) (from cursor/plugins at ') && DCR::Lenses.paths(pstack).all? { |path| out.include?("  #{path}\n") }, "dcr lens prints the chosen lens and its files:\n#{out}")
out, status = Open3.capture2e(RbConfig.ruby, DCR_BIN, 'lens', 'use', 'superpowers')
assert(status.success? && DCR::Settings.new.review_lens == 'superpowers', "dcr lens use chooses a lens: #{out}")
out, status = Open3.capture2e(RbConfig.ruby, DCR_BIN, 'lens', 'use', 'nope')
assert(!status.success? && out.include?('Unknown review lens'), "dcr lens use refuses an unknown lens: #{out}")
puts 'PASS dcr lens gives the agent the chosen lens and its files'
