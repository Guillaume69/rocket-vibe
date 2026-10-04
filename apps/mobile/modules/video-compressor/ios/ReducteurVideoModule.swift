import AVFoundation
import ExpoModulesCore

/**
 * Pendant iOS du module Kotlin (Media3 Transformer) : MP4 H.264 au bitrate
 * demandé, côté court plafonné (l'aspect est préservé), audio copié tel quel
 * quand c'est de l'AAC, réencodé en AAC sinon. Écrit dans le cache de l'app,
 * celui que `supprimerSiTemporaire` (ui/temporaryFiles.ts) nettoie.
 *
 * La rotation n'est pas appliquée aux pixels : la piste garde la transformation
 * de la source, que tous les lecteurs respectent. Le plafond se compare donc
 * aux dimensions DROITES, comme côté Android.
 */
public class ReducteurVideoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ReducteurVideo")

    AsyncFunction("reduire") { (uri: String, coteCourtMax: Int, bitrateVideo: Int) async throws -> [String: Any] in
      guard let source = URL(string: uri), let cache = self.appContext?.config.cacheDirectory else {
        throw ErreurReduction("URI ou cache indisponible.")
      }
      let sortie = cache.appendingPathComponent("video-reduite-\(UUID().uuidString).mp4")
      do {
        try await transcoder(source: source, sortie: sortie, coteCourtMax: coteCourtMax, bitrate: bitrateVideo)
      } catch {
        try? FileManager.default.removeItem(at: sortie)
        throw error
      }
      let attributs = try FileManager.default.attributesOfItem(atPath: sortie.path)
      let taille = (attributs[.size] as? NSNumber)?.doubleValue ?? 0
      return ["uri": sortie.absoluteString, "taille": taille]
    }
  }
}

final class ErreurReduction: GenericException<String> {
  override var reason: String { param }
}

private func transcoder(source: URL, sortie: URL, coteCourtMax: Int, bitrate: Int) async throws {
  let asset = AVURLAsset(url: source)
  guard let pisteVideo = try await asset.loadTracks(withMediaType: .video).first else {
    throw ErreurReduction("Aucune piste vidéo.")
  }
  let pisteAudio = try await asset.loadTracks(withMediaType: .audio).first
  let (taille, transformation) = try await pisteVideo.load(.naturalSize, .preferredTransform)

  let droite = taille.applying(transformation)
  let coteCourt = min(abs(droite.width), abs(droite.height))
  let echelle = coteCourt > CGFloat(coteCourtMax) ? CGFloat(coteCourtMax) / coteCourt : 1
  // Dimensions paires : contrainte de l'encodeur H.264.
  let largeur = Int(taille.width * echelle) / 2 * 2
  let hauteur = Int(taille.height * echelle) / 2 * 2

  let lecteur = try AVAssetReader(asset: asset)
  let redacteur = try AVAssetWriter(outputURL: sortie, fileType: .mp4)
  redacteur.shouldOptimizeForNetworkUse = true

  let lectureVideo = AVAssetReaderTrackOutput(
    track: pisteVideo,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
  )
  lectureVideo.alwaysCopiesSampleData = false
  let ecritureVideo = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: largeur,
      AVVideoHeightKey: hauteur,
      AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ],
    ]
  )
  ecritureVideo.transform = transformation
  ecritureVideo.expectsMediaDataInRealTime = false
  lecteur.add(lectureVideo)
  redacteur.add(ecritureVideo)
  var paires: [(AVAssetReaderOutput, AVAssetWriterInput)] = [(lectureVideo, ecritureVideo)]

  if let pisteAudio {
    let formats = try await pisteAudio.load(.formatDescriptions)
    let format = formats.first
    let estAac = format.map { CMFormatDescriptionGetMediaSubType($0) == kAudioFormatMPEG4AAC } ?? false
    let lectureAudio: AVAssetReaderTrackOutput
    let ecritureAudio: AVAssetWriterInput
    if estAac {
      lectureAudio = AVAssetReaderTrackOutput(track: pisteAudio, outputSettings: nil)
      ecritureAudio = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format)
    } else {
      lectureAudio = AVAssetReaderTrackOutput(track: pisteAudio, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
      ecritureAudio = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVNumberOfChannelsKey: 2,
          AVSampleRateKey: 44_100,
          AVEncoderBitRateKey: 128_000,
        ]
      )
    }
    ecritureAudio.expectsMediaDataInRealTime = false
    if lecteur.canAdd(lectureAudio), redacteur.canAdd(ecritureAudio) {
      lecteur.add(lectureAudio)
      redacteur.add(ecritureAudio)
      paires.append((lectureAudio, ecritureAudio))
    }
  }

  guard lecteur.startReading() else {
    throw lecteur.error ?? ErreurReduction("Lecture de la vidéo impossible.")
  }
  guard redacteur.startWriting() else {
    lecteur.cancelReading()
    throw redacteur.error ?? ErreurReduction("Écriture de la vidéo impossible.")
  }
  redacteur.startSession(atSourceTime: .zero)

  await copier(paires)

  if lecteur.status == .failed {
    redacteur.cancelWriting()
    throw lecteur.error ?? ErreurReduction("Lecture interrompue.")
  }
  await redacteur.finishWriting()
  guard redacteur.status == .completed else {
    throw redacteur.error ?? ErreurReduction("Transcodage impossible.")
  }
}

/// Pompe chaque piste de la lecture vers l'écriture, au rythme où l'encodeur
/// accepte les échantillons. Les pistes avancent EN MÊME TEMPS : AVAssetWriter
/// attend des données entrelacées et cesse d'accepter la vidéo tant que l'audio
/// ne suit pas ; les copier l'une après l'autre bloquerait.
private func copier(_ paires: [(AVAssetReaderOutput, AVAssetWriterInput)]) async {
  await withCheckedContinuation { (fin: CheckedContinuation<Void, Never>) in
    let groupe = DispatchGroup()
    for (index, (lecture, ecriture)) in paires.enumerated() {
      groupe.enter()
      var termine = false
      ecriture.requestMediaDataWhenReady(on: DispatchQueue(label: "reducteur-video.\(index)")) {
        guard !termine else { return }
        while ecriture.isReadyForMoreMediaData {
          guard let echantillon = lecture.copyNextSampleBuffer(), ecriture.append(echantillon) else {
            ecriture.markAsFinished()
            termine = true
            groupe.leave()
            return
          }
        }
      }
    }
    groupe.notify(queue: .global()) { fin.resume() }
  }
}
