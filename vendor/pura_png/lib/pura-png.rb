# frozen_string_literal: true

require_relative "pura/png/version"
require_relative "pura/png/image"
require_relative "pura/png/decoder"
require_relative "pura/png/encoder"

module Pura
  module Png
    def self.decode(input, **options)
      Decoder.decode(input, **options)
    end

    def self.encode(image, output_path, compression: 6)
      Encoder.encode(image, output_path, compression: compression)
    end
  end
end
