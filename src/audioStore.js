const fs = require('fs');
const path = require('path');
const db = require('./db/database');

// Los WAV van en disco y la BD solo guarda sus metadatos
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

/** Ruta absoluta de una grabación; basename impide salir del directorio. */
function recordingPath(filename) {
  return path.join(RECORDINGS_DIR, path.basename(filename));
}

/**
 * Cabecera WAV (RIFF) para PCM mono de 16 bits.
 * El ESP32 envía PCM crudo: la cabecera se añade aquí para no gastar RAM allí.
 */
function buildWavHeader(pcmBytes, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // Tamaño del bloque fmt
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);         // Bytes por muestra
  header.writeUInt16LE(16, 34);        // Bits por muestra
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);

  return header;
}

/** Nivel RMS y pico en dBFS de un buffer PCM de 16 bits little-endian. */
function analyzePcm(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { rms_dbfs: null, peak_dbfs: null };

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSquares += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }

  const toDb = v => (v > 0 ? Math.round(20 * Math.log10(v / 32768) * 10) / 10 : -96);

  return {
    rms_dbfs: toDb(Math.sqrt(sumSquares / samples)),
    peak_dbfs: toDb(peak)
  };
}

function removeRecordingFile(filename) {
  try {
    fs.unlinkSync(recordingPath(filename));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Error borrando ${filename}:`, err.message);
  }
}

/** Borra fila y archivo de cada grabación. */
function removeRecordings(recordings) {
  for (const rec of recordings) {
    removeRecordingFile(rec.filename);
    db.deleteAudioRecording(rec.id);
  }
  return recordings.length;
}

/** Deja solo las `keep` grabaciones más recientes del dispositivo. */
function enforceRecordingLimit(deviceId, keep) {
  if (!Number.isInteger(keep) || keep <= 0) return 0;
  return removeRecordings(db.getExcessAudioRecordings(deviceId, keep));
}

/** Purga por antigüedad, con el mismo DATA_RETENTION_DAYS que el historial. */
function purgeOldRecordings(days) {
  return removeRecordings(db.getOldAudioRecordings(days));
}

/**
 * Borra los WAV de un dispositivo. Hay que llamarlo ANTES de borrar el
 * dispositivo: el ON DELETE CASCADE elimina las filas pero no los archivos.
 */
function removeDeviceRecordingFiles(deviceId) {
  for (const filename of db.getAudioRecordingFilenames(deviceId)) {
    removeRecordingFile(filename);
  }
}

module.exports = {
  RECORDINGS_DIR,
  ensureRecordingsDir,
  recordingPath,
  buildWavHeader,
  analyzePcm,
  removeRecordings,
  enforceRecordingLimit,
  purgeOldRecordings,
  removeDeviceRecordingFiles
};
