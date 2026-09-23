# frozen_string_literal: true

require "zlib"

module Pura
  module Png
    class Encoder
      PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10].pack("C8")

      def self.encode(image, output_path, compression: 6)
        encoder = new(image, compression: compression)
        data = encoder.encode
        File.binwrite(output_path, data)
        data.bytesize
      end

      def initialize(image, compression: 6)
        @image = image
        @compression = compression
      end

      def encode
        out = String.new(encoding: Encoding::BINARY)
        out << PNG_SIGNATURE
        out << make_chunk("IHDR", ihdr_data)
        out << make_chunk("IDAT", idat_data)
        out << make_chunk("IEND", "")
        out
      end

      private

      def ihdr_data
        [
          @image.width,
          @image.height,
          8,  # bit depth
          2,  # color type: RGB
          0,  # compression method
          0,  # filter method
          0   # interlace method
        ].pack("NNC5")
      end

      def idat_data
        raw = build_raw_data
        Zlib::Deflate.deflate(raw, @compression)
      end

      def build_raw_data
        width = @image.width
        height = @image.height
        pixels = @image.pixels
        stride = width * 3

        raw = String.new(encoding: Encoding::BINARY, capacity: height * (1 + stride))

        prev_row = nil
        height.times do |y|
          row_start = y * stride
          row = pixels.byteslice(row_start, stride)

          # Choose filter: try None and Sub, pick smaller
          none_row = "\x00".b + row
          sub_row = build_sub_filtered(row)

          raw << if sub_row.bytesize <= none_row.bytesize
                   # Rough heuristic: sum of absolute values
                   sub_row
                 else
                   none_row
                 end

          prev_row = row
        end

        raw
      end

      def build_sub_filtered(row)
        filtered = String.new("\x01".b, encoding: Encoding::BINARY, capacity: 1 + row.bytesize)
        row.bytesize.times do |i|
          cur = row.getbyte(i)
          left = i >= 3 ? row.getbyte(i - 3) : 0
          filtered << ((cur - left) & 0xFF).chr
        end
        filtered
      end

      def make_chunk(type, data)
        data = data.b
        crc = Zlib.crc32(type + data)
        [data.bytesize].pack("N") + type + data + [crc].pack("N")
      end
    end
  end
end
