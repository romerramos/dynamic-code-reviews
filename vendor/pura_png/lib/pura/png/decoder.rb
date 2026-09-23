# frozen_string_literal: true

require "zlib"

module Pura
  module Png
    class DecodeError < StandardError; end
    class LimitExceeded < DecodeError; end

    class Decoder
      PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10].pack("C8")

      # Color types
      GRAYSCALE       = 0
      RGB             = 2
      INDEXED         = 3
      GRAYSCALE_ALPHA = 4
      RGBA            = 6

      DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024
      DEFAULT_MAX_PIXELS = 40_000_000
      DEFAULT_MAX_DECODED_BYTES = 256 * 1024 * 1024
      BIT_DEPTHS = { 0 => [1, 2, 4, 8, 16], 2 => [8, 16], 3 => [1, 2, 4, 8],
                     4 => [8, 16], 6 => [8, 16] }.freeze

      def self.decode(input, max_input_bytes: DEFAULT_MAX_INPUT_BYTES, **options)
        unless max_input_bytes.is_a?(Integer) && max_input_bytes.positive?
          raise ArgumentError, "max_input_bytes must be a positive integer"
        end

        data = if input.is_a?(String) && !input.include?("\x00") && input.bytesize < 4096 && File.exist?(input)
                 File.binread(input, max_input_bytes + 1)
               else
                 input.b
               end
        raise LimitExceeded, "PNG input limit exceeded" if data.bytesize > max_input_bytes

        new(data, **options).decode
      end

      def initialize(data, max_pixels: DEFAULT_MAX_PIXELS, max_decoded_bytes: DEFAULT_MAX_DECODED_BYTES)
        unless [max_pixels, max_decoded_bytes].all? { |value| value.is_a?(Integer) && value.positive? }
          raise ArgumentError, "decode limits must be positive integers"
        end

        @max_pixels = max_pixels
        @max_decoded_bytes = max_decoded_bytes
        @data = data
        @pos = 0
      end

      def decode
        read_signature

        ihdr = nil
        palette = nil
        transparency = nil
        idat_chunks = []

        loop do
          length, type = read_chunk_header
          chunk_data = read_bytes(length)
          crc = read_uint32
          raise DecodeError, "Invalid PNG CRC for #{type}" unless crc == Zlib.crc32(type + chunk_data)
          raise DecodeError, "IHDR must be the first chunk" if !ihdr && type != "IHDR"

          case type
          when "IHDR"
            raise DecodeError, "Duplicate IHDR chunk" if ihdr

            ihdr = parse_ihdr(chunk_data)
          when "PLTE"
            palette = parse_plte(chunk_data)
          when "tRNS"
            transparency = chunk_data
          when "IDAT"
            idat_chunks << chunk_data
          when "IEND"
            raise DecodeError, "IEND must be empty" unless chunk_data.empty?

            break
          else
            raise DecodeError, "Unknown critical PNG chunk: #{type}" if type.getbyte(0).allbits?(0x20) == false
          end
        end

        raise DecodeError, "Missing IHDR chunk" unless ihdr
        raise DecodeError, "Missing IDAT chunk" if idat_chunks.empty?

        compressed = idat_chunks.join
        raw = inflate_scanlines(compressed, ihdr)

        pixels = reconstruct(raw, ihdr, palette, transparency)
        Image.new(ihdr[:width], ihdr[:height], pixels)
      end

      private

      def read_signature
        sig = read_bytes(8)
        raise DecodeError, "Not a PNG file" unless sig == PNG_SIGNATURE
      end

      def read_chunk_header
        length = read_uint32
        type = read_bytes(4)
        [length, type]
      end

      def read_bytes(n)
        raise DecodeError, "Unexpected end of data" if @pos + n > @data.bytesize

        result = @data.byteslice(@pos, n)
        @pos += n
        result
      end

      def read_uint32
        bytes = read_bytes(4)
        bytes.unpack1("N")
      end

      def parse_ihdr(data)
        raise DecodeError, "IHDR must contain 13 bytes" unless data.bytesize == 13

        width, height, bit_depth, color_type, compression, filter, interlace = data.unpack("NNC5")
        raise DecodeError, "Invalid PNG dimensions" unless width.positive? && height.positive?
        raise LimitExceeded, "PNG pixel limit exceeded" if width * height > @max_pixels
        unless BIT_DEPTHS.fetch(color_type, []).include?(bit_depth)
          raise DecodeError, "Invalid PNG color type / bit depth: #{color_type} / #{bit_depth}"
        end

        raise DecodeError, "Unsupported compression method: #{compression}" unless compression.zero?
        raise DecodeError, "Unsupported filter method: #{filter}" unless filter.zero?
        raise DecodeError, "Interlaced PNGs (Adam7) are not supported" unless interlace.zero?

        {
          width: width,
          height: height,
          bit_depth: bit_depth,
          color_type: color_type,
          interlace: interlace
        }
      end

      def inflate_scanlines(compressed, ihdr)
        row_bytes = ((ihdr[:width] * samples_per_pixel(ihdr) * ihdr[:bit_depth]) + 7) / 8
        expected = (row_bytes + 1) * ihdr[:height]
        if [expected, ihdr[:width] * ihdr[:height] * 3].max > @max_decoded_bytes
          raise LimitExceeded, "PNG decoded byte limit exceeded"
        end

        raw = String.new(encoding: Encoding::BINARY)
        inflater = Zlib::Inflate.new
        inflater.inflate(compressed) do |chunk|
          raise DecodeError, "Excess PNG scanline data" if raw.bytesize + chunk.bytesize > expected

          raw << chunk
        end
        raise DecodeError, "Incomplete PNG compressed data" unless inflater.finished?
        raise DecodeError, "Incorrect PNG scanline data length" unless raw.bytesize == expected

        raw
      rescue Zlib::Error => e
        raise DecodeError, "Invalid PNG compressed data: #{e.message}"
      ensure
        inflater&.close
      end

      def parse_plte(data)
        raise DecodeError, "PLTE chunk length not divisible by 3" unless (data.bytesize % 3).zero?

        entries = data.bytesize / 3
        palette = Array.new(entries)
        entries.times do |i|
          offset = i * 3
          palette[i] = [data.getbyte(offset), data.getbyte(offset + 1), data.getbyte(offset + 2)]
        end
        palette
      end

      def bytes_per_pixel(ihdr)
        case ihdr[:color_type]
        when GRAYSCALE       then 1
        when RGB             then 3
        when INDEXED         then 1
        when GRAYSCALE_ALPHA then 2
        when RGBA            then 4
        else raise DecodeError, "Unknown color type: #{ihdr[:color_type]}"
        end
      end

      def samples_per_pixel(ihdr)
        case ihdr[:color_type]
        when GRAYSCALE       then 1
        when RGB             then 3
        when INDEXED         then 1
        when GRAYSCALE_ALPHA then 2
        when RGBA            then 4
        else raise DecodeError, "Unknown color type: #{ihdr[:color_type]}"
        end
      end

      def reconstruct(raw, ihdr, palette, transparency)
        width = ihdr[:width]
        height = ihdr[:height]
        bit_depth = ihdr[:bit_depth]
        color_type = ihdr[:color_type]
        bpp = bytes_per_pixel(ihdr)

        # For sub-byte pixels, compute scanline byte width
        if bit_depth < 8
          pixels_per_byte = 8 / bit_depth
          scanline_bytes = ((width * samples_per_pixel(ihdr)) + pixels_per_byte - 1) / pixels_per_byte
        else
          scanline_bytes = width * bpp * (bit_depth / 8)
        end

        # Bytes per complete pixel (for filter reconstruction, minimum 1)
        filter_bpp = [bpp * (bit_depth / 8), 1].max

        prev_row = "\0".b * scanline_bytes
        pos = 0
        out = String.new(encoding: Encoding::BINARY, capacity: width * height * 3)

        # Parse tRNS for grayscale/RGB transparency
        trns_gray = nil
        trns_rgb = nil
        trns_alpha = nil
        if transparency
          case color_type
          when GRAYSCALE
            trns_gray = transparency.unpack1("n")
          when RGB
            trns_rgb = transparency.unpack("nnn")
          when INDEXED
            trns_alpha = transparency.bytes
          end
        end

        height.times do
          filter_type = raw.getbyte(pos)
          pos += 1
          row_data = raw.byteslice(pos, scanline_bytes).bytes
          pos += scanline_bytes

          # Apply filter
          filtered = apply_filter(filter_type, row_data, prev_row.bytes, filter_bpp)
          prev_row = filtered.pack("C*")

          # Convert to RGB pixels
          convert_row_to_rgb(out, filtered, width, bit_depth, color_type, palette, trns_gray, trns_rgb, trns_alpha)
        end

        out
      end

      def apply_filter(filter_type, row, prev_row, bpp)
        case filter_type
        when 0 # None
          row
        when 1 # Sub
          row.each_with_index do |byte, i|
            left = i >= bpp ? row[i - bpp] : 0
            row[i] = (byte + left) & 0xFF
          end
          row
        when 2 # Up
          row.each_with_index do |byte, i|
            row[i] = (byte + prev_row[i]) & 0xFF
          end
          row
        when 3 # Average
          row.each_with_index do |byte, i|
            left = i >= bpp ? row[i - bpp] : 0
            up = prev_row[i]
            row[i] = (byte + ((left + up) / 2)) & 0xFF
          end
          row
        when 4 # Paeth
          row.each_with_index do |byte, i|
            left = i >= bpp ? row[i - bpp] : 0
            up = prev_row[i]
            up_left = i >= bpp ? prev_row[i - bpp] : 0
            row[i] = (byte + paeth_predictor(left, up, up_left)) & 0xFF
          end
          row
        else
          raise DecodeError, "Unknown filter type: #{filter_type}"
        end
      end

      def paeth_predictor(a, b, c)
        p = a + b - c
        pa = (p - a).abs
        pb = (p - b).abs
        pc = (p - c).abs
        if pa <= pb && pa <= pc
          a
        elsif pb <= pc
          b
        else
          c
        end
      end

      def convert_row_to_rgb(out, row, width, bit_depth, color_type, palette, _trns_gray, _trns_rgb, _trns_alpha)
        case color_type
        when RGB
          if bit_depth == 8
            width.times do |x|
              offset = x * 3
              out << row[offset].chr << row[offset + 1].chr << row[offset + 2].chr
            end
          elsif bit_depth == 16
            width.times do |x|
              offset = x * 6
              out << (row[offset] & 0xFF).chr << (row[offset + 2] & 0xFF).chr << (row[offset + 4] & 0xFF).chr
            end
          end

        when RGBA
          if bit_depth == 8
            width.times do |x|
              offset = x * 4
              out << row[offset].chr << row[offset + 1].chr << row[offset + 2].chr
            end
          elsif bit_depth == 16
            width.times do |x|
              offset = x * 8
              out << (row[offset] & 0xFF).chr << (row[offset + 2] & 0xFF).chr << (row[offset + 4] & 0xFF).chr
            end
          end

        when GRAYSCALE
          if bit_depth == 8
            width.times do |x|
              g = row[x]
              out << g.chr << g.chr << g.chr
            end
          elsif bit_depth == 16
            width.times do |x|
              g = row[x * 2]
              out << g.chr << g.chr << g.chr
            end
          elsif bit_depth < 8
            max_val = (1 << bit_depth) - 1
            pixels_per_byte = 8 / bit_depth
            mask = max_val
            x = 0
            byte_idx = 0
            while x < width
              byte = row[byte_idx]
              pixels_per_byte.times do |p|
                break if x >= width

                shift = 8 - (bit_depth * (p + 1))
                val = (byte >> shift) & mask
                g = (val * 255 / max_val)
                out << g.chr << g.chr << g.chr
                x += 1
              end
              byte_idx += 1
            end
          end

        when GRAYSCALE_ALPHA
          if bit_depth == 8
            width.times do |x|
              offset = x * 2
              g = row[offset]
              out << g.chr << g.chr << g.chr
            end
          elsif bit_depth == 16
            width.times do |x|
              offset = x * 4
              g = row[offset]
              out << g.chr << g.chr << g.chr
            end
          end

        when INDEXED
          raise DecodeError, "Missing PLTE for indexed color" unless palette

          if bit_depth == 8
            width.times do |x|
              idx = row[x]
              r, g, b = palette[idx]
              out << r.chr << g.chr << b.chr
            end
          elsif bit_depth < 8
            max_val = (1 << bit_depth) - 1
            pixels_per_byte = 8 / bit_depth
            mask = max_val
            x = 0
            byte_idx = 0
            while x < width
              byte = row[byte_idx]
              pixels_per_byte.times do |p|
                break if x >= width

                shift = 8 - (bit_depth * (p + 1))
                idx = (byte >> shift) & mask
                r, g, b = palette[idx]
                out << r.chr << g.chr << b.chr
                x += 1
              end
              byte_idx += 1
            end
          end
        end
      end
    end
  end
end
