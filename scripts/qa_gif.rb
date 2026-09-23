# frozen_string_literal: true

# Encode real browser frames as an animated GIF using bundled Ruby codecs.
require 'optparse'
require_relative '../vendor/pure_jpeg/lib/pure_jpeg'
require_relative '../vendor/pura_png/lib/pura-png'

module ReviewGIF
  module_function

  def bmp(path)
    bytes = File.binread(path)
    raise ArgumentError, "Not a BMP: #{path}" unless bytes.start_with?('BM')
    offset = bytes.unpack1('V', offset: 10)
    width = bytes.unpack1('l<', offset: 18)
    signed_height = bytes.unpack1('l<', offset: 22)
    depth = bytes.unpack1('v', offset: 28)
    compression = bytes.unpack1('V', offset: 30)
    raise ArgumentError, 'Only uncompressed 24-bit BMP is supported' unless width.positive? && signed_height != 0 && depth == 24 && compression.zero?
    height = signed_height.abs
    stride = ((width * 3 + 3) / 4) * 4
    raise ArgumentError, 'Truncated BMP' if bytes.bytesize < offset + stride * height
    pixels = Array.new(width * height)
    height.times do |y|
      source_y = signed_height.negative? ? y : height - y - 1
      row = offset + source_y * stride
      width.times do |x|
        blue, green, red = bytes.byteslice(row + x * 3, 3).bytes
        pixels[y * width + x] = (red << 16) | (green << 8) | blue
      end
    end
    [width, height, pixels]
  end

  def decode(path)
    signature = File.binread(path, 8)
    return bmp(path) if signature.start_with?('BM')
    if signature.start_with?("\xff\xd8".b)
      image = PureJPEG.read(path)
      return [image.width, image.height, image.packed_pixels]
    end
    if signature == "\x89PNG\r\n\x1a\n".b
      image = Pura::Png.decode(path)
      return [image.width, image.height, image.pixels.bytes.each_slice(3).map { |red, green, blue| (red << 16) | (green << 8) | blue }]
    end
    raise ArgumentError, 'GIF creation supports PNG, JPEG or BMP browser frames'
  end

  def bucket(rgb)
    (((rgb >> 16) & 255) >> 3 << 10) | (((rgb >> 8) & 255) >> 3 << 5) | ((rgb & 255) >> 3)
  end

  def palette_for(frames)
    histogram = Hash.new { |hash, key| hash[key] = [0, 0, 0, 0] }
    frames.each do |(_width, _height, pixels)|
      pixels.each do |rgb|
        sample = histogram[bucket(rgb)]
        sample[0] += 1
        sample[1] += (rgb >> 16) & 255
        sample[2] += (rgb >> 8) & 255
        sample[3] += rgb & 255
      end
    end
    boxes = [histogram.keys]
    while boxes.length < 253
      candidate = boxes.each_index.select { |index| boxes[index].length > 1 }.max_by do |index|
        keys = boxes[index]
        channels = [10, 5, 0]
        span = channels.map { |shift| keys.map { |key| (key >> shift) & 31 }.minmax.then { |lo, hi| hi - lo } }.max
        span * Math.sqrt(keys.sum { |key| histogram[key][0] })
      end
      break unless candidate
      keys = boxes.delete_at(candidate)
      channel = [10, 5, 0].max_by { |shift| keys.map { |key| (key >> shift) & 31 }.minmax.then { |lo, hi| hi - lo } }
      sorted = keys.sort_by { |key| (key >> channel) & 31 }
      midpoint = sorted.sum { |key| histogram[key][0] } / 2
      total = 0
      split = sorted.index do |key|
        total += histogram[key][0]
        total >= midpoint
      end.to_i + 1
      split = [[split, 1].max, sorted.length - 1].min
      boxes << sorted.take(split) << sorted.drop(split)
    end
    colors = [[0, 0, 0], [255, 255, 255], [255, 90, 35]]
    lookup = {}
    boxes.each_with_index do |keys, index|
      sums = keys.map { |key| histogram[key] }
      count = sums.sum { |entry| entry[0] }
      colors << (1..3).map { |channel| sums.sum { |entry| entry[channel] } / count }
      keys.each { |key| lookup[key] = index + 3 }
    end
    colors.fill([0, 0, 0], colors.length...256)
    [colors.flatten.pack('C*'), lookup]
  end

  # The ring and pointer are annotations at the confirmed click location, not a claim
  # that the capture API recorded pointer movement.
  def mark_click(pixels, width, height, x, y)
    raise ArgumentError, 'Click marker outside frame' unless x.between?(0, width - 1) && y.between?(0, height - 1)
    (-13..13).each do |dy|
      (-13..13).each do |dx|
        px = x + dx
        py = y + dy
        next unless px.between?(0, width - 1) && py.between?(0, height - 1)
        distance = dx * dx + dy * dy
        pixels[py * width + px] = 2 if distance.between?(80, 155)
      end
    end
    pixels[y * width + x] = 2
    pointer = [
      '#', '##', '#o#', '#oo#', '#ooo#', '#oooo#', '#ooooo#',
      '#oooooo#', '#ooooooo#', '#oooo#', '#oo##o#', '#o#.#oo#',
      '##..#oo#', '#....#oo#', '.....#oo#', '......##'
    ]
    pointer.each_with_index do |row, dy|
      row.chars.each_with_index do |color, dx|
        px = x + 5 + dx
        py = y + 3 + dy
        next unless px.between?(0, width - 1) && py.between?(0, height - 1)
        pixels[py * width + px] = color == '#' ? 0 : 1 unless color == '.'
      end
    end
  end

  def lzw(indices)
    dictionary = {}
    code_size = 9
    next_code = 258
    buffer = +''.b
    bits = 0
    count = 0
    emit = lambda do |code|
      bits |= code << count
      count += code_size
      while count >= 8
        buffer << (bits & 255)
        bits >>= 8
        count -= 8
      end
    end
    emit.call(256)
    prefix = indices.first
    indices.drop(1).each do |value|
      key = (prefix << 8) | value
      if (found = dictionary[key])
        prefix = found
      else
        emit.call(prefix)
        if next_code < 4096
          dictionary[key] = next_code
          next_code += 1
          code_size += 1 if next_code > (1 << code_size) && code_size < 12
        else
          emit.call(256)
          dictionary.clear
          code_size = 9
          next_code = 258
        end
        prefix = value
      end
    end
    emit.call(prefix)
    emit.call(257)
    buffer << (bits & 255) if count.positive?
    buffer
  end

  def write(output, paths, clicks: {}, delay: 140)
    raise ArgumentError, 'GIF needs at least two frames' if paths.length < 2
    raise ArgumentError, 'Frame delay must be 2..1000 centiseconds' unless delay.between?(2, 1000)
    frames = paths.map { |path| decode(path) }
    dimensions = frames.first.take(2)
    raise ArgumentError, 'GIF frames must have identical dimensions' unless frames.all? { |width, height, _pixels| [width, height] == dimensions }
    raise ArgumentError, 'GIF frame exceeds 1600 x 1200' if dimensions[0] > 1600 || dimensions[1] > 1200
    colors, lookup = palette_for(frames)
    File.open(output, 'wb') do |gif|
      frames.each_with_index do |(width, height, rgb_pixels), index|
        pixels = rgb_pixels.map { |rgb| lookup.fetch(bucket(rgb)) }
        if index.zero?
          gif.write('GIF89a'.b + [width, height].pack('v2') + "\xf7\x00\x00".b + colors)
          gif.write("\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00".b)
        end
        mark_click(pixels, width, height, *clicks.fetch(index)) if clicks.key?(index)
        gif.write("\x21\xf9\x04\x00".b + [delay].pack('v') + "\x00\x00".b)
        gif.write("\x2c".b + [0, 0, width, height].pack('v4') + "\x00\x08".b)
        compressed = lzw(pixels)
        compressed.bytes.each_slice(255) { |slice| gif.write([slice.length].pack('C') + slice.pack('C*')) }
        gif.write("\x00".b)
      end
      gif.write("\x3b".b)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  options = {clicks: {}, delay: 140}
  parser = OptionParser.new do |flags|
    flags.banner = 'Usage: ruby qa_gif.rb --out flow.gif [--delay 140] [--click frame:x:y] frame1.jpg frame2.jpg ...'
    flags.on('--out PATH') { |value| options[:out] = value }
    flags.on('--delay CENTISECONDS', Integer) { |value| options[:delay] = value }
    flags.on('--click FRAME:X:Y', '0-based frame index and confirmed point in cropped image pixels') do |value|
      parts = value.split(':')
      raise OptionParser::InvalidArgument, value unless parts.length == 3 && parts.all? { |part| part.match?(/\A\d+\z/) }
      options[:clicks][parts[0].to_i] = parts.drop(1).map(&:to_i)
    end
  end
  parser.parse!
  raise OptionParser::MissingArgument, '--out' unless options[:out]
  raise ArgumentError, 'Click marker frame index outside sequence' if options[:clicks].keys.any? { |index| index >= ARGV.length }
  ReviewGIF.write(options[:out], ARGV, clicks: options[:clicks], delay: options[:delay])
  puts options[:out]
end
