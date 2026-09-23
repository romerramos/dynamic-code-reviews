# frozen_string_literal: true

require 'tmpdir'
require 'open3'
require 'rbconfig'
require_relative 'qa_gif'

Dir.mktmpdir('review-qa-gif-test-') do |directory|
  png = File.join(directory, 'first.png')
  jpeg = File.join(directory, 'second.jpg')
  plain = File.join(directory, 'plain.gif')
  marked = File.join(directory, 'marked.gif')
  pixels = ([255, 255, 255] * 64).pack('C*')
  Pura::Png.encode(Pura::Png::Image.new(8, 8, pixels), png)
  source = PureJPEG::Source::RawSource.new(8, 8) { |x, y| x == y ? [15, 20, 45] : [255, 255, 255] }
  PureJPEG.encode(source).write(jpeg)

  # Running with an empty PATH catches accidental calls to OS image tools.
  command = [RbConfig.ruby, File.join(__dir__, 'qa_gif.rb'), '--out', plain, png, jpeg]
  _stdout, stderr, status = Open3.capture3({'PATH' => ''}, *command)
  raise "Dependency-free GIF generation failed: #{stderr}" unless status.success?
  ReviewGIF.write(marked, [png, jpeg], clicks: {1 => [4, 4]})
  bytes = File.binread(marked)
  raise 'GIF header or dimensions missing' unless bytes.start_with?('GIF89a' + [8, 8].pack('v2'))
  raise 'GIF trailer missing' unless bytes.end_with?("\x3b".b)
  raise 'Click annotation did not affect output' if File.binread(plain) == bytes
  raise 'GIF lacks two frames' unless bytes.scan("\x21\xf9\x04".b).length == 2
  puts 'PASS PNG and JPEG frames encode without external tools; click marker changes the GIF'
end
