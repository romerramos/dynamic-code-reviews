# frozen_string_literal: true
# The workspace marker: the name and app a workspace tool gave a checkout, in its git dir.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config')
require 'fileutils'
require 'json'
require 'net/http'
require 'open3'
require_relative '../lib/dcr/workspace'
require_relative '../lib/dcr/server'
require_relative '../lib/dcr/page'

def assert(condition, message)
  raise message unless condition
end

def git(*args)
  out, status = Open3.capture2e('git', *args)
  raise out unless status.success?
  out.strip
end

Dir.mktmpdir('dcr-workspace') do |tmp|
  main = File.join(tmp, 'shop')
  tree = File.join(tmp, 't3-c6839a9e')
  git('init', '-q', main)
  git('-C', main, 'commit', '-q', '--allow-empty', '-m', 'start')
  git('-C', main, 'worktree', 'add', '-q', tree)
  marker = File.join(git('-C', tree, 'rev-parse', '--absolute-git-dir'), 'workspace.json')

  assert DCR::Workspace.find(tree).nil?, 'A worktree without a marker has no workspace'
  File.write(marker, JSON.generate(name: 'orion', app: 'https://app.orion.test'))
  found = DCR::Workspace.find(tree)
  assert found == {'name' => 'orion', 'app' => 'https://app.orion.test', 'path' => marker}, "The marker is read: #{found.inspect}"
  assert DCR::Workspace.find(main).nil?, 'Another worktree of the same repository does not get its name'

  File.write(marker, JSON.generate(name: 'orion <b>', app: 'javascript:alert(1)'))
  assert DCR::Workspace.find(tree).nil?, 'A marker with no usable field gives nothing'
  File.write(marker, JSON.generate(name: 'vega'))
  assert DCR::Workspace.find(tree) == {'name' => 'vega', 'path' => marker}, 'The fields are each optional'
  File.write(marker, 'not json')
  assert DCR::Workspace.find(tree).nil?, 'A broken marker gives nothing'
  puts 'PASS the workspace marker is read from the checkout\'s own git dir, keeping only usable fields'

  File.write(marker, JSON.generate(name: 'orion'))
  series = File.join(tree, '.reviews', 'checkout')
  FileUtils.mkdir_p(series)
  report = File.join(series, 'current.html')
  File.write(report, DCR::Page.review({'snapshot' => {}, 'review' => {'title' => 'Checkout'}}))
  server = DCR::Server.new(directory: File.join(tmp, 'captures'), report: report, no_app: 'no UI')
  thread = Thread.new { server.run }
  begin
    page = Net::HTTP.new('127.0.0.1', server.port).get('/').body
    assert page.include?('<meta name="dcr-workspace" content="orion">'), 'The served review does not name its workspace'
    File.delete(marker)
    page = Net::HTTP.new('127.0.0.1', server.port).get('/').body
    assert !page.include?('<meta name="dcr-workspace"'), 'A review without a marker names no workspace'
    puts 'PASS the served review names the workspace its checkout\'s marker gives'
  ensure
    server.close
    thread.join
  end
end
