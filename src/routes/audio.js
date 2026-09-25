const fs = require('fs');
const db = require('../db/database');
const { sendCommandToDevice, sendOrQueueCommand, broadcastToDashboards } = require('../websocket');
const { checkDeviceToken, extractDeviceToken, getAudioMaxPerDevice } = require('../config');
const store = require('../audioStore');

const SAMPLE_RATES = [8000, 16000];
const MAX_DURATION_SEC = 30;

// 30 s a 16 kHz y 16 bits son 960 KB: por debajo del client_max_body_size de
// 1 MB que nginx trae por defecto, así que no hace falta tocar el proxy.
const MAX_UPLOAD_BYTES = MAX_DURATION_SEC * 16000 * 2;

async function authenticateDevice(request, reply) {
  if (!checkDeviceToken(extractDeviceToken(request))) {
    return reply.status(401).send({ error: 'Token de dispositivo inválido' });
  }
}

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } }
};

const audioConfigBody = {
  type: 'object',
  required: ['sck_pin', 'ws_pin', 'sd_pin'],
  properties: {
    enabled: { type: 'boolean' },
    sck_pin: { type: 'integer', minimum: 0, maximum: 48 },
    ws_pin: { type: 'integer', minimum: 0, maximum: 48 },
    sd_pin: { type: 'integer', minimum: 0, maximum: 48 },
    channel: { type: 'integer', enum: [0, 1] },
    sample_rate: { type: 'integer', enum: SAMPLE_RATES },
    duration_sec: { type: 'integer', minimum: 1, maximum: MAX_DURATION_SEC },
    capture_interval_sec: { type: 'integer', minimum: 0, maximum: 86400 },
    gain: { type: 'integer', minimum: 1, maximum: 64 }
  }
};

async function audioRoutes(fastify, options) {

  store.ensureRecordingsDir();

  // El ESP32 envía el PCM crudo como application/octet-stream. El parser queda
  // encapsulado en este plugin: el resto de la API sigue sin aceptar binarios.
  fastify.addContentTypeParser('application/octet-stream', {
    parseAs: 'buffer',
    bodyLimit: MAX_UPLOAD_BYTES
  }, (request, body, done) => done(null, body));

  // ============================================
  // SUBIDA DESDE EL ESP32
  // ============================================

  fastify.post('/audio/upload', {
    preHandler: [authenticateDevice]
  }, async (request, reply) => {
    const mac = String(request.headers['x-device-mac'] || '').toUpperCase().trim();
    const sampleRate = Number.parseInt(request.headers['x-sample-rate'], 10);
    const pcm = request.body;

    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
      return reply.status(400).send({ error: 'Cabecera x-device-mac inválida' });
    }

    const device = db.getDeviceByMac(mac);
    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    if (!SAMPLE_RATES.includes(sampleRate)) {
      return reply.status(400).send({ error: `x-sample-rate debe ser ${SAMPLE_RATES.join(' o ')}` });
    }

    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
      return reply.status(400).send({ error: 'Se esperaba PCM de 16 bits (application/octet-stream)' });
    }

    const filename = `audio_${device.id}_${Date.now()}.wav`;
    fs.writeFileSync(store.recordingPath(filename), Buffer.concat([store.buildWavHeader(pcm.length, sampleRate), pcm]));

    const recording = db.addAudioRecording(device.id, {
      filename,
      sample_rate: sampleRate,
      duration_ms: Math.round(pcm.length / 2 / sampleRate * 1000),
      size_bytes: pcm.length + 44,
      ...store.analyzePcm(pcm)
    });

    store.enforceRecordingLimit(device.id, getAudioMaxPerDevice());

    console.log(`🎙️  Grabación de ${mac}: ${recording.duration_ms} ms, ${recording.rms_dbfs} dBFS`);

    broadcastToDashboards({
      type: 'audio_recording',
      device_id: device.id,
      mac_address: mac,
      recording
    });

    return reply.status(201).send({ success: true, id: recording.id });
  });

  // ============================================
  // DASHBOARD (JWT)
  // ============================================

  // Configuración del micrófono y últimas grabaciones
  fastify.get('/devices/:id/audio', {
    preHandler: [fastify.authenticate],
    schema: {
      params: idParam,
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;

    if (!db.getDeviceById(id)) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    return {
      config: db.getAudioConfig(id),
      recordings: db.getAudioRecordings(id, request.query.limit),
      total: db.countAudioRecordings(id)
    };
  });

  // Guardar configuración del micrófono
  fastify.put('/devices/:id/audio/config', {
    preHandler: [fastify.authenticate],
    schema: { params: idParam, body: audioConfigBody }
  }, async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const { sck_pin, ws_pin, sd_pin } = request.body;
    if (new Set([sck_pin, ws_pin, sd_pin]).size !== 3) {
      return reply.status(400).send({ error: 'SCK, WS y SD deben ser pines distintos' });
    }

    const config = db.setAudioConfig(id, request.body);

    // No se encola: si está dormido la recibe igualmente al registrarse
    sendCommandToDevice(device.mac_address, { action: 'update_audio', audio: config });

    return { success: true, config };
  });

  // Pedir una grabación inmediata (se encola si el dispositivo duerme)
  fastify.post('/devices/:id/audio/capture', {
    preHandler: [fastify.authenticate],
    schema: { params: idParam }
  }, async (request, reply) => {
    const device = db.getDeviceById(request.params.id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const config = db.getAudioConfig(device.id);
    if (!config || !config.enabled) {
      return reply.status(409).send({ error: 'El micrófono no está configurado o está desactivado' });
    }

    const sent = sendOrQueueCommand(device.id, device.mac_address, { action: 'capture_audio' });

    return {
      success: true,
      queued: !sent,
      message: sent ? 'Grabación solicitada' : 'Dispositivo dormido: grabará al despertar'
    };
  });

  // Servir el WAV. Va con JWT en la cabecera, así que el dashboard lo descarga
  // con fetch y lo reproduce desde un blob: nunca pone el token en una URL.
  fastify.get('/audio/:id/file', {
    preHandler: [fastify.authenticate],
    schema: { params: idParam }
  }, async (request, reply) => {
    const recording = db.getAudioRecordingById(request.params.id);
    const filepath = recording && store.recordingPath(recording.filename);

    if (!recording || !fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'Grabación no encontrada' });
    }

    reply.header('Content-Type', 'audio/wav');
    reply.header('Content-Length', fs.statSync(filepath).size);
    reply.header('Content-Disposition', `inline; filename="${recording.filename}"`);

    return reply.send(fs.createReadStream(filepath));
  });

  // Borrar una grabación
  fastify.delete('/audio/:id', {
    preHandler: [fastify.authenticate],
    schema: { params: idParam }
  }, async (request, reply) => {
    const recording = db.getAudioRecordingById(request.params.id);

    if (!recording) {
      return reply.status(404).send({ error: 'Grabación no encontrada' });
    }

    store.removeRecordings([recording]);
    return { success: true };
  });
}

module.exports = audioRoutes;
