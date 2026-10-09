#!/usr/bin/env ruby
# frozen_string_literal: true

# `dcr record`: drive the recorder of a running `dcr serve` from the terminal. Each action waits
# for the recorder page's result and prints it as JSON.
require 'optparse'
require_relative '../lib/dcr/recorder'

options = {}
OptionParser.new do |parser|
  parser.banner = "Usage: dcr record --out <capture-directory> <#{DCR::Recorder::ACTIONS.join('|')}|wait-ready|wait-request> [--name NAME] [--timeout SECONDS]"
  parser.on('--out PATH') { |value| options[:directory] = value }
  parser.on('--name NAME') { |value| options[:name] = value }
  parser.on('--timeout SECONDS', Integer) { |value| options[:timeout] = value }
end.parse!
action = ARGV.shift
abort 'Provide --out <capture-directory> and an action' unless options[:directory] && action
abort "Unknown action #{action}" unless %w[wait-ready wait-request].include?(action) || DCR::Recorder::ACTIONS.include?(action)
client = DCR::Recorder::Client
begin
  if action == 'wait-request'
    puts JSON.generate(client.wait_request(directory: options[:directory], timeout: options[:timeout] || 120))
    exit 0
  end
  result = if action == 'wait-ready'
    client.wait_ready(directory: options[:directory], timeout: options[:timeout] || 180)
  else
    client.call(directory: options[:directory], action: action, name: options[:name], timeout: options[:timeout] || 60)
  end
  puts JSON.generate(result)
  exit(result['ok'] ? 0 : 1)
rescue StandardError => error
  warn error.message
  exit 1
end
