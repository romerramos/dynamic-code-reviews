#!/usr/bin/env ruby
# frozen_string_literal: true

# `dcr serve`: serve a review with the QA recorder panel and live conversation threads, on loopback
# (and the tailnet with --share). Ruby stdlib only; the server lives in lib/dcr/server.rb.
require 'optparse'
require 'tmpdir'
require_relative '../lib/dcr/server'

options = {port: 0}
OptionParser.new do |parser|
  parser.banner = 'Usage: dcr serve (--repo <root> --name <series> | --report <review.html>) [--out <capture-directory>] [--port 0] [--app URL [--app-ca PATH]]'
  parser.on('--out PATH', 'Where recordings are saved; a temporary directory when omitted') { |value| options[:directory] = value }
  parser.on('--report PATH') { |value| options[:report] = value }
  parser.on('--repo PATH', 'With --name: serve that series\' current review') { |value| options[:repo] = value }
  parser.on('--name SLUG') { |value| options[:name] = value }
  parser.on('--port NUMBER', Integer) { |value| options[:port] = value }
  parser.on('--app URL', 'The running app to show inside the review, like http://localhost:3000 or https://app.myproject.test') { |value| options[:app] = value }
  parser.on('--app-ca PATH', 'A local CA certificate the app\'s HTTPS uses (mkcert\'s root is found automatically)') { |value| options[:app_ca] = value }
  parser.on('--share', 'Also serve it on your tailnet with Tailscale Serve, for your own login; stays local when Tailscale cannot') { options[:share] = true }
  parser.on('--share-with LOGIN', 'Another tailnet login allowed to open the shared review (repeatable)') { |value| (options[:share_with] ||= []) << value }
end.parse!
if (name = options.delete(:name))
  abort 'Use a short lowercase series slug' unless name.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
  repo = options.fetch(:repo, Dir.pwd)
  options[:report] ||= File.join(File.expand_path(repo), '.reviews', name, 'current.html')
  # The served page is always rendered with today's UI; the saved file is what opens offline, so
  # a page saved by an older version has its display files rebuilt first.
  require_relative 'series'
  abort 'No saved review for that series' unless File.file?(options[:report])
  unless File.read(options[:report])[/<meta name="dcr-ui" content="([0-9a-f]+)">/, 1] == DCR::Page.ui_version
    ReviewSeries.refresh(repo: repo, name: name)
    warn 'Refreshed the saved report with the current review UI. Saved revisions are unchanged.'
  end
end
options.delete(:repo)
options[:directory] ||= Dir.mktmpdir('dcr-capture-')
server = DCR::Server.new(**options)
$stdout.sync = true
puts options[:report] ? "Review with QA panel: #{server.url}/#overview" : "QA recorder: #{server.url}"
puts "App inside the review: #{server.url}/?app#overview (proxying #{options[:app]} through #{server.app_url})" if server.app_url
puts 'Open the review in a tab your browser tool controls (Claude in Chrome: its tab group), so you can act in it when the reviewer presses Start QA review.' if server.app_url
puts 'No --app: the review shows the older recorder card and has no Start QA review. Find the running app and serve again with --app <url>, or tell the reviewer why it is missing.' if options[:report] && !server.app_url
puts "On your tailnet: #{server.shared_origin}/#overview (only for your Tailscale login#{options[:share_with] ? ' and the ones you shared it with' : ''})" if server.shared_origin
puts server.share_note if server.share_note
puts "Local capture files: #{File.expand_path(options[:directory])}"
puts "Control: dcr record --out #{File.expand_path(options[:directory])} <wait-request|wait-ready|start|still|stop|end|status|reload> [--name NAME]"
begin
  server.run
rescue Interrupt
  nil
ensure
  server.close
end
