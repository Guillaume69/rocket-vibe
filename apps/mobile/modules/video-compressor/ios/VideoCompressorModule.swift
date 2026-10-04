import AVFoundation
import ExpoModulesCore

/**
 * Pendant iOS du module Kotlin (Media3 Transformer) : MP4 H.264 au bitrate
 * demandé, côté court plafonné (l'aspect est préservé), audio copié tel quel
 * quand c'est de l'AAC, réencodé en AAC sinon. Écrit dans le cache de l'app,
 * celui que `deleteIfTemporary` (ui/temporaryFiles.ts) nettoie.
 *
 * La rotation n'est pas appliquée aux pixels : la piste garde la transformation
 * de la source, que tous les lecteurs respectent. Le plafond se compare donc
 * aux dimensions DROITES, comme côté Android.
 */
public class VideoCompressorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoCompressor")

    AsyncFunction("compress") { (uri: String, maxShortSide: Int, videoBitrate: Int) async throws -> [String: Any] in
      guard let source = URL(string: uri), let cache = self.appContext?.config.cacheDirectory else {
        throw CompressionError("URI ou cache indisponible.")
      }
      let output = cache.appendingPathComponent("compressed-video-\(UUID().uuidString).mp4")
      do {
        try await transcode(source: source, output: output, maxShortSide: maxShortSide, bitrate: videoBitrate)
      } catch {
        try? FileManager.default.removeItem(at: output)
        throw error
      }
      let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
      let size = (attributes[.size] as? NSNumber)?.doubleValue ?? 0
      return ["uri": output.absoluteString, "size": size]
    }
  }
}

final class CompressionError: GenericException<String> {
  override var reason: String { param }
}

private func transcode(source: URL, output: URL, maxShortSide: Int, bitrate: Int) async throws {
  let asset = AVURLAsset(url: source)
  guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
    throw CompressionError("Aucune piste vidéo.")
  }
  let audioTrack = try await asset.loadTracks(withMediaType: .audio).first
  let (size, transformation) = try await videoTrack.load(.naturalSize, .preferredTransform)

  let upright = size.applying(transformation)
  let shortSide = min(abs(upright.width), abs(upright.height))
  let scale = shortSide > CGFloat(maxShortSide) ? CGFloat(maxShortSide) / shortSide : 1
  // Dimensions paires : contrainte de l'encodeur H.264.
  let width = Int(size.width * scale) / 2 * 2
  let height = Int(size.height * scale) / 2 * 2

  let reader = try AVAssetReader(asset: asset)
  let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
  writer.shouldOptimizeForNetworkUse = true

  let videoOutput = AVAssetReaderTrackOutput(
    track: videoTrack,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
  )
  videoOutput.alwaysCopiesSampleData = false
  let videoInput = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ],
    ]
  )
  videoInput.transform = transformation
  videoInput.expectsMediaDataInRealTime = false
  reader.add(videoOutput)
  writer.add(videoInput)
  var pairs: [(AVAssetReaderOutput, AVAssetWriterInput)] = [(videoOutput, videoInput)]

  if let audioTrack {
    let formats = try await audioTrack.load(.formatDescriptions)
    let format = formats.first
    let isAac = format.map { CMFormatDescriptionGetMediaSubType($0) == kAudioFormatMPEG4AAC } ?? false
    let audioOutput: AVAssetReaderTrackOutput
    let audioInput: AVAssetWriterInput
    if isAac {
      audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
      audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format)
    } else {
      audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
      audioInput = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVNumberOfChannelsKey: 2,
          AVSampleRateKey: 44_100,
          AVEncoderBitRateKey: 128_000,
        ]
      )
    }
    audioInput.expectsMediaDataInRealTime = false
    if reader.canAdd(audioOutput), writer.canAdd(audioInput) {
      reader.add(audioOutput)
      writer.add(audioInput)
      pairs.append((audioOutput, audioInput))
    }
  }

  guard reader.startReading() else {
    throw reader.error ?? CompressionError("Lecture de la vidéo impossible.")
  }
  guard writer.startWriting() else {
    reader.cancelReading()
    throw writer.error ?? CompressionError("Écriture de la vidéo impossible.")
  }
  writer.startSession(atSourceTime: .zero)

  await copySamples(pairs)

  if reader.status == .failed {
    writer.cancelWriting()
    throw reader.error ?? CompressionError("Lecture interrompue.")
  }
  await writer.finishWriting()
  guard writer.status == .completed else {
    throw writer.error ?? CompressionError("Transcodage impossible.")
  }
}

/// Pompe chaque piste de la lecture vers l'écriture, au rythme où l'encodeur
/// accepte les échantillons. Les pistes avancent EN MÊME TEMPS : AVAssetWriter
/// attend des données entrelacées et cesse d'accepter la vidéo tant que l'audio
/// ne suit pas ; les copier l'une après l'autre bloquerait.
private func copySamples(_ pairs: [(AVAssetReaderOutput, AVAssetWriterInput)]) async {
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    let group = DispatchGroup()
    for (index, (readerOutput, writerInput)) in pairs.enumerated() {
      group.enter()
      var finished = false
      writerInput.requestMediaDataWhenReady(on: DispatchQueue(label: "video-compressor.\(index)")) {
        guard !finished else { return }
        while writerInput.isReadyForMoreMediaData {
          guard let sample = readerOutput.copyNextSampleBuffer(), writerInput.append(sample) else {
            writerInput.markAsFinished()
            finished = true
            group.leave()
            return
          }
        }
      }
    }
    group.notify(queue: .global()) { done.resume() }
  }
}
