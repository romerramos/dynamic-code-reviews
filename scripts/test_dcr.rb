#!/usr/bin/env ruby
# frozen_string_literal: true

# Run with ruby scripts/test_dcr.rb. The dispatcher only forwards to the helper scripts.
require 'minitest/autorun'
require 'json'
require 'open3'
require 'rbconfig'
require 'tmpdir'

class DcrDispatchTest < Minitest::Test
  DCR = File.expand_path('../bin/dcr', __dir__)

  def dcr(*args) = Open3.capture3(RbConfig.ruby, DCR, *args)

  def test_forwards_to_the_script_with_its_own_usage_and_exit_code
    _out, err, status = dcr('collect', '--bogus')
    refute status.success?
    assert_match(/invalid option|--bogus/, err)
  end

  def test_series_forwards_the_subcommand
    Dir.mktmpdir('dcr-dispatch-') do |repo|
      Open3.capture3('git', '-C', repo, 'init', '-q')
      out, err, status = dcr('series', 'list', '--repo', repo)
      assert status.success?, err
      assert_equal [], JSON.parse(out)
    end
  end

  def test_serve_resolves_a_series_and_rejects_a_bad_name_or_missing_report
    _out, err, status = dcr('serve', '--name', 'Bad Name')
    refute status.success?
    assert_includes err, 'lowercase series slug'
    Dir.mktmpdir('dcr-serve-') do |repo|
      _out, err, status = dcr('serve', '--repo', repo, '--name', 'nothing-here')
      refute status.success?
      assert_match(/No saved review for that series/, err)
    end
  end

  def test_record_forwards_to_the_recorder_control
    _out, err, status = dcr('record', 'status')
    refute status.success?
    assert_match(/--out|capture-directory/, err)
  end

  def test_unknown_command_and_bare_series_fail_with_usage
    [%w[nonsense], %w[series], %w[series nonsense], %w[previews]].each do |args|
      _out, err, status = dcr(*args)
      refute status.success?, args.inspect
      assert_includes err, 'Usage: dcr'
    end
  end

  def test_help_lists_the_commands
    out, _err, status = dcr('--help')
    assert status.success?
    %w[collect series previews serve record].each { |name| assert_includes out, name }
  end
end
