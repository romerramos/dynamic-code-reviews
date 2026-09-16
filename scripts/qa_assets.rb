# frozen_string_literal: true

require 'base64'

# Small, portable media bundles. No URLs, fetches, runtime installs or sidecars.
module ReviewQA
  LIMIT = 24 * 1024 * 1024
  TYPES = %w[image/png image/jpeg image/webp video/mp4 video/webm].freeze
  module_function

  def media_type(bytes)
    return 'image/png' if bytes.start_with?("\x89PNG\r\n\x1a\n".b)
    return 'image/jpeg' if bytes.start_with?("\xff\xd8\xff".b)
    return 'image/webp' if bytes.start_with?('RIFF') && bytes.byteslice(8, 4) == 'WEBP'
    return 'video/mp4' if bytes.byteslice(4, 4) == 'ftyp'
    return 'video/webm' if bytes.start_with?("\x1a\x45\xdf\xa3".b)
    raise ArgumentError, 'QA media must be PNG, JPEG, WebP, MP4 or WebM'
  end

  def pack(qa, directory:)
    qa = Marshal.load(Marshal.dump(qa))
    total = 0
    Array(qa['flows']).each do |flow|
      Array(flow['assets']).each do |asset|
        next unless asset.key?('path')
        path = File.expand_path(asset.delete('path'), directory)
        raise ArgumentError, 'QA asset must be a regular non-symlink file' if File.symlink?(path) || !File.file?(path)
        total += File.size(path)
        raise ArgumentError, 'QA media exceeds 24 MiB; shorten or compress the capture' if total > LIMIT
        bytes = File.binread(path)
        asset['data_uri'] = "data:#{media_type(bytes)};base64,#{Base64.strict_encode64(bytes)}"
      end
    end
    qa
  end

  def validate(qa, snapshot, review = nil)
    return unless qa
    raise ArgumentError, 'Invalid QA status' unless %w[awaiting-environment pending complete partial blocked skipped].include?(qa['status'])
    raise ArgumentError, 'QA belongs to a different snapshot' unless qa['fingerprint'] == snapshot['fingerprint']
    raise ArgumentError, 'QA summary is required' if qa['summary'].to_s.strip.empty?
    flows = qa.fetch('flows', [])
    raise ArgumentError, 'QA flows must be an array' unless flows.is_a?(Array)
    if %w[complete partial].include?(qa['status'])
      raise ArgumentError, 'Recorded QA needs environment/source evidence and at least one flow' if qa['environment'].to_s.strip.empty? || flows.empty?
    end
    if qa['status'] == 'complete' && flows.none? { |flow| Array(flow['assets']).any? }
      raise ArgumentError, 'Completed visual QA needs at least one embedded screenshot or video; use partial or blocked when capture failed'
    end
    total = 0
    flows.each do |flow|
      if flow['comment_id'] && review && !Array(review['comments']).any? { |comment| comment['id'] == flow['comment_id'] }
        raise ArgumentError, 'QA flow refers to an unknown review comment'
      end
      %w[title expected observed].each { |key| raise ArgumentError, "QA flow needs #{key}" if flow[key].to_s.strip.empty? }
      raise ArgumentError, 'Invalid QA result' unless %w[passed failed blocked not-run].include?(flow['result'])
      raise ArgumentError, 'QA steps must be text' unless flow['steps'].is_a?(Array) && flow['steps'].all? { |step| step.is_a?(String) }
      if qa['status'] == 'complete' && %w[blocked not-run].include?(flow['result'])
        raise ArgumentError, 'Incomplete flow cannot be marked complete'
      end
      if flow.key?('journey') && (!flow['journey'].is_a?(Array) || flow['journey'].empty? || !flow['journey'].all? { |step| step.is_a?(String) && !step.strip.empty? })
        raise ArgumentError, 'QA journey must contain short text steps'
      end
      Array(flow['assets']).each do |asset|
        if asset['comment_id'] && review && !Array(review['comments']).any? { |comment| comment['id'] == asset['comment_id'] }
          raise ArgumentError, 'QA asset refers to an unknown review comment'
        end
        raise ArgumentError, 'QA asset caption is required' if asset['caption'].to_s.strip.empty?
        uri = asset['data_uri'].to_s
        raise ArgumentError, 'QA media exceeds 24 MiB' if uri.bytesize > (LIMIT * 4 / 3 + 128)
        match = uri.match(%r{\Adata:(image/png|image/jpeg|image/webp|video/mp4|video/webm);base64,([A-Za-z0-9+/=]+)\z})
        raise ArgumentError, 'Use packed QA media; external URLs and file paths are not supported' unless match && !asset.key?('path')
        bytes = Base64.strict_decode64(match[2])
        raise ArgumentError, 'QA media type does not match its bytes' unless media_type(bytes) == match[1]
        total += bytes.bytesize
        raise ArgumentError, 'QA media exceeds 24 MiB; shorten or compress the capture' if total > LIMIT
      end
    end
  end
end
