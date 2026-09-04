const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { sendCommandToDevice, sendOrQueueCommand } = require('../websocket');
const { checkDeviceToken, extractDeviceToken } = require('../config');

// Hook para los endpoints que consumen los ESP32 (no tienen JWT).
// Solo exige token si DEVICE_TOKEN está configurado.
async function authenticateDevice(request, reply) {
  if (!checkDeviceToken(extractDeviceToken(request))) {
    return reply.status(401).send({ error: 'Token de dispositivo inválido' });
  }
}

const FIRMWARE_DIR = path.join(__dirname, '..', '..', 'firmware');
const MAX_FIRMWARE_BYTES = Number(process.env.MAX_FIRMWARE_MB || 8) * 1024 * 1024;

async function otaRoutes(fastify, options) {

  // ============================================
  // GESTIÓN DE FIRMWARE
  // ============================================

  // Listar firmware disponible
  fastify.get('/firmware', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const firmware = db.getFirmwareList();
    return { firmware };
  });

  // Subir nuevo firmware
  fastify.post('/firmware/upload', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'No se recibió archivo' });
    }

    const { version, description } = data.fields;

    if (!version || !version.value) {
      return reply.status(400).send({ error: 'Versión requerida' });
    }

    // La versión acaba dentro del nombre del archivo, así que se rechaza cualquier
    // carácter que pudiera sacar la escritura del directorio de firmware.
    // Se rechaza en vez de sanear: mutilar "../../evil" a "....evil" y guardarlo
    // como si nada deja al usuario con una versión que no es la que escribió.
    const rawVersion = String(version.value).trim();

    if (!/^[A-Za-z0-9._-]{1,32}$/.test(rawVersion) || /^\.+$/.test(rawVersion)) {
      return reply.status(400).send({
        error: 'Versión inválida: solo letras, números, punto, guion y guion bajo (máx. 32)'
      });
    }

    const safeVersion = rawVersion;

    // Generar nombre único
    const timestamp = Date.now();
    const filename = path.basename(`firmware_${safeVersion}_${timestamp}.bin`);
    const filepath = path.join(FIRMWARE_DIR, filename);

    // Asegurar que existe el directorio
    if (!fs.existsSync(FIRMWARE_DIR)) {
      fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
    }

    // Leer el archivo completo en memoria (el límite de multipart lo acota)
    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Si el archivo superó el límite se recibe truncado: guardarlo significaría
    // repartir por OTA un binario incompleto y dejar los dispositivos inservibles.
    if (data.file.truncated) {
      return reply.status(413).send({
        error: `El firmware supera el límite de ${Math.round(MAX_FIRMWARE_BYTES / (1024 * 1024))} MB`
      });
    }

    if (buffer.length === 0) {
      return reply.status(400).send({ error: 'El archivo está vacío' });
    }

    // Los binarios de ESP32 empiezan por el magic byte 0xE9
    if (buffer[0] !== 0xE9) {
      return reply.status(400).send({
        error: 'El archivo no parece un firmware de ESP32 (falta el magic byte 0xE9)'
      });
    }

    fs.writeFileSync(filepath, buffer);

    const checksum = crypto.createHash('md5').update(buffer).digest('hex');
    const filesize = buffer.length;

    // Guardar en base de datos
    const firmware = db.addFirmware(
      version.value,
      filename,
      filesize,
      checksum,
      description?.value || ''
    );

    return {
      success: true,
      firmware
    };
  });

  // Establecer firmware activo (para OTA)
  fastify.post('/firmware/:id/activate', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { id } = request.params;

    const firmware = db.getFirmwareById(id);
    if (!firmware) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    db.setActiveFirmware(id);

    return {
      success: true,
      firmware: db.getFirmwareById(id)
    };
  });

  // Eliminar firmware
  fastify.delete('/firmware/:id', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { id } = request.params;

    const firmware = db.getFirmwareById(id);
    if (!firmware) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    // Eliminar archivo
    const filepath = path.join(FIRMWARE_DIR, firmware.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }

    db.deleteFirmware(id);

    return { success: true };
  });

  // ============================================
  // ACTUALIZACIÓN OTA
  // ============================================

  // Iniciar OTA para un dispositivo específico
  fastify.post('/update/:deviceId', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const { firmware_id } = request.body;

    const device = db.getDeviceById(deviceId);
    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const firmware = db.getFirmwareById(firmware_id);
    if (!firmware) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    // Crear tarea OTA
    const result = db.createOtaTask(deviceId, firmware_id);

    // Notificar al dispositivo si está conectado
    const sent = sendCommandToDevice(device.mac_address, {
      action: 'ota_update',
      ota_id: result.lastInsertRowid,
      version: firmware.version,
      filename: firmware.filename,
      checksum: firmware.checksum,
      filesize: firmware.filesize
    });

    return {
      success: true,
      ota_id: result.lastInsertRowid,
      device_online: sent
    };
  });

  // Iniciar OTA para todos los dispositivos
  fastify.post('/update-all', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { firmware_id } = request.body;

    const firmware = db.getFirmwareById(firmware_id);
    if (!firmware) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    const devices = db.getDevices();
    const tasks = [];

    for (const device of devices) {
      // Solo los que no tengan ya esta versión
      if (device.firmware_version !== firmware.version) {
        const result = db.createOtaTask(device.id, firmware_id);

        // Encolar si está dormido: antes se usaba sendCommandToDevice y los
        // dispositivos offline se quedaban sin aviso pese a contarse como tarea
        const sent = sendOrQueueCommand(device.id, device.mac_address, {
          action: 'ota_update',
          ota_id: result.lastInsertRowid,
          version: firmware.version,
          filename: firmware.filename,
          checksum: firmware.checksum,
          filesize: firmware.filesize
        });

        tasks.push({
          device_id: device.id,
          mac_address: device.mac_address,
          ota_id: result.lastInsertRowid,
          sent,
          queued: !sent
        });
      }
    }

    return {
      success: true,
      tasks_created: tasks.length,
      sent_now: tasks.filter(t => t.sent).length,
      queued: tasks.filter(t => t.queued).length,
      tasks
    };
  });

  // ============================================
  // DESCARGA DE FIRMWARE (para ESP32)
  // ============================================

  // Endpoint para que el ESP32 descargue el firmware
  fastify.get('/download/:filename', {
    preHandler: [authenticateDevice]
  }, async (request, reply) => {
    // path.basename descarta cualquier '../' (Fastify decodifica %2f en los params),
    // y además el nombre debe existir en la tabla firmware: nunca se sirve un
    // archivo arbitrario del disco.
    const filename = path.basename(request.params.filename || '');

    if (!filename || !db.getFirmwareByFilename(filename)) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    const filepath = path.join(FIRMWARE_DIR, filename);

    if (!fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'Firmware no encontrado' });
    }

    const stat = fs.statSync(filepath);

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });

  // Verificar si hay actualización disponible
  fastify.get('/check/:mac', {
    preHandler: [authenticateDevice]
  }, async (request, reply) => {
    const mac = (request.params.mac || '').toUpperCase().trim();

    const device = db.getDeviceByMac(mac);
    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const pendingTasks = db.getPendingOtaTasks(device.id);

    if (pendingTasks.length > 0) {
      const task = pendingTasks[0];
      return {
        update_available: true,
        ota_id: task.id,
        version: task.version,
        filename: task.filename,
        checksum: task.checksum,
        filesize: task.filesize
      };
    }

    return { update_available: false };
  });

  // Reportar estado de OTA desde ESP32
  fastify.post('/status', {
    preHandler: [authenticateDevice]
  }, async (request, reply) => {
    const { ota_id, status, error } = request.body || {};

    if (!db.isValidOtaStatus(status)) {
      return reply.status(400).send({ error: 'Estado OTA inválido' });
    }

    const result = db.updateOtaTask(ota_id, status, error);

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Tarea OTA no encontrada' });
    }

    return { success: true };
  });
}

module.exports = otaRoutes;
