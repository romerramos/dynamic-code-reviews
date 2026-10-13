# frozen_string_literal: true

require 'base64'
require 'digest'
require 'fileutils'
require 'securerandom'
require_relative 'qa_assets'

# Screenshots the review's agent takes of the running app while it reviews: what the change looks
# like (the Overview's Seen in the app) or what a comment is about. Each names the changed files it
# shows, so an update can tell which ones still hold. Posted ones keep their image in the series
# folder until a saved revision embeds it.
module ReviewScreenshots
  FOLDER = 'screenshots'
  LIMIT = 4 * 1024 * 1024 # each
  TOTAL = 24 * 1024 * 1024
  SHOWN = 6        # on no comment, in Seen in the app
  PER_COMMENT = 3
  TYPES = {'image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp'}.freeze
  FIELDS = %w[id path title caption page paths comment_id].freeze
  ID = /\A[a-zA-Z0-9-]{1,60}\z/
  module_function

  # The agent's items as records, their images saved in the series folder. comments: the review's,
  # with the posted ones. existing: the screenshots it has so far; one posted again under its id
  # replaces the earlier one. base: what a relative image path resolves against.
  def store(items, snapshot:, comments:, existing:, directory:, base:)
    raise ArgumentError, 'Give one screenshot object or an array of them' if items.empty? || !items.all?(Hash)
    changed = snapshot.fetch('files').to_h { |file| [file['id'], file['path']] }
    ranges = snapshot.fetch('files').flat_map { |file| file.fetch('hunks').map { |hunk| [hunk['id'], file['path']] } }.to_h
    records = items.map do |item|
      unknown = item.keys - FIELDS
      raise ArgumentError, "Unknown screenshot field(s): #{unknown.join(', ')}" unless unknown.empty?
      record = {'id' => item['id'] || "shot-#{SecureRandom.hex(3)}", 'title' => text(item['title'], 'A screenshot title', 120)}
      raise ArgumentError, 'A screenshot id is short and URL-safe' unless record['id'].is_a?(String) && record['id'].match?(ID)
      record['caption'] = text(item['caption'], 'A caption', 300) if item.key?('caption')
      record['page'] = text(item['page'], 'The app page', 500) if item.key?('page')
      paths = item['paths']
      if item.key?('comment_id')
        comment = comments.find { |entry| entry['id'] == item['comment_id'] }
        raise ArgumentError, "No comment #{item['comment_id']} in this review; post the comment first" unless comment
        record['comment_id'] = comment['id']
        paths ||= [ranges[comment['hunk']]].compact
      end
      unless paths.is_a?(Array) && paths.any? && (paths - changed.values).empty?
        raise ArgumentError, "Screenshot #{record['id']} needs paths: the changed files it shows, as the review lists them"
      end
      record['paths'] = paths.uniq
      bytes = image(File.expand_path(item['path'].to_s, base))
      name = "#{record['id']}-#{Digest::SHA256.hexdigest(bytes)[0, 12]}.#{TYPES.fetch(ReviewQA.media_type(bytes))}"
      [record.merge('file' => name), bytes]
    end
    ids = records.map { |record, _| record['id'] }
    raise ArgumentError, 'A screenshot id is used twice' unless ids.uniq.length == ids.length
    all = existing.reject { |shot| ids.include?(shot['id']) } + records.map(&:first)
    raise ArgumentError, "Seen in the app takes at most #{SHOWN} screenshots that are on no comment: choose the screens that say most, or post one again under its id to replace it" if all.count { |shot| !shot['comment_id'] } > SHOWN
    raise ArgumentError, "A comment takes at most #{PER_COMMENT} screenshots" if all.select { |shot| shot['comment_id'] }.group_by { |shot| shot['comment_id'] }.values.any? { |own| own.length > PER_COMMENT }
    folder = File.join(directory, FOLDER)
    FileUtils.mkdir_p(folder, mode: 0o700)
    records.each { |record, bytes| File.write(File.join(folder, record['file']), bytes, mode: 'wb', perm: 0o600) }
    # The image a screenshot posted again replaces is of no use to anyone.
    records.each { |record, _| (Dir[File.join(folder, "#{record['id']}-#{'[0-9a-f]' * 12}.*")] - [File.join(folder, record['file'])]).each { |old| File.unlink(old) } }
    records.map(&:first)
  end

  def image(path)
    raise ArgumentError, "No screenshot at #{path}" unless File.file?(path) && !File.symlink?(path)
    raise ArgumentError, 'A screenshot is limited to 4 MiB; capture the part that matters, or save it as JPEG' if File.size(path) > LIMIT
    bytes = File.binread(path)
    raise ArgumentError, 'A screenshot is a PNG, JPEG or WebP image' unless TYPES.key?(ReviewQA.media_type(bytes))
    bytes
  end

  def text(value, label, limit)
    raise ArgumentError, "#{label} is text of at most #{limit} characters" unless value.is_a?(String) && !value.strip.empty? && value.length <= limit
    value.strip
  end

  # A posted screenshot's image as a data URI, or nil when its file is gone.
  def data_uri(directory, record)
    path = File.join(directory, FOLDER, File.basename(record['file'].to_s))
    return unless File.file?(path) && !File.symlink?(path)
    bytes = File.binread(path)
    "data:#{ReviewQA.media_type(bytes)};base64,#{Base64.strict_encode64(bytes)}"
  end

  # Posted records as a saved review holds them: the image inside, no file.
  def embedded(directory, records)
    records.filter_map { |record| data_uri(directory, record)&.then { |uri| record.except('file', 'posted_at').merge('data_uri' => uri) } }
  end

  def validate(shots, snapshot, review)
    return if shots.nil?
    raise ArgumentError, 'Screenshots must be an array' unless shots.is_a?(Array) && shots.all?(Hash)
    paths = snapshot.fetch('files').map { |file| file['path'] }
    total = 0
    shots.each do |shot|
      raise ArgumentError, 'A screenshot needs a short URL-safe id' unless shot['id'].is_a?(String) && shot['id'].match?(ID)
      raise ArgumentError, 'A screenshot needs a title' if shot['title'].to_s.strip.empty?
      raise ArgumentError, 'A screenshot names the changed files it shows' unless shot['paths'].is_a?(Array) && shot['paths'].any? && (shot['paths'] - paths).empty?
      if shot['comment_id'] && !Array(review['comments']).any? { |comment| comment['id'] == shot['comment_id'] }
        raise ArgumentError, 'A screenshot refers to an unknown review comment'
      end
      match = shot['data_uri'].to_s.match(%r{\Adata:(image/png|image/jpeg|image/webp);base64,([A-Za-z0-9+/=]+)\z})
      raise ArgumentError, 'Post screenshots with `dcr screenshot`; paths and URLs are not embedded' unless match
      bytes = Base64.strict_decode64(match[2])
      raise ArgumentError, 'A screenshot type does not match its bytes' unless ReviewQA.media_type(bytes) == match[1]
      total += bytes.bytesize
      raise ArgumentError, 'Screenshots exceed 24 MiB' if total > TOTAL
    end
    raise ArgumentError, 'A screenshot id is used twice' unless shots.map { |shot| shot['id'] }.uniq.length == shots.length
  end
end
