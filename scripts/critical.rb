#!/usr/bin/env ruby
# frozen_string_literal: true

# `dcr critical`: the candidate files for a critical-code review of a repository.
require_relative 'review'
require_relative '../lib/dcr/critical'

options = {}
parser = OptionParser.new do |p|
  p.banner = 'dcr critical --repo <root> --out <candidates.json>'
  %w[repo out].each { |key| p.on("--#{key} VALUE") { |value| options[key] = value } }
end
parser.parse!(ARGV)
abort parser.to_s unless options['repo'] && options['out']
begin
  root = DynamicReviews.git(options['repo'], 'rev-parse', '--show-toplevel').strip
  abort 'Write the candidates outside the repository' if File.expand_path(options['out']).start_with?("#{root}/")
  found = DCR::Critical.new(root).candidates
  File.write(options['out'], JSON.pretty_generate({'repo' => root, 'kinds' => DCR::Critical::KINDS.transform_values { |rule| rule['title'] }, 'files' => found}))
  puts DCR::Critical.brief(found, options['out'])
rescue ArgumentError, SystemCallError => error
  abort error.message
end
