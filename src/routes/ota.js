const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { sendCommandToDevice, broadcastToDevices, connections } = require('../websocket');

const FIRMWARE_DIR = path.join(__dirname, '..', '..', 'firmware');

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

    // Generar nombre único
    const timestamp = Date.now();
    const filename = `firmware_${version.value}_${timestamp}.bin`;
    const filepath = path.join(FIRMWARE_DIR, filename);

    // Asegurar que existe el directorio
    if (!fs.existsSync(FIRMWARE_DIR)) {
      fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
    }

    // Guardar archivo y calcular checksum
    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

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
      // Solo dispositivos online y con versión diferente
      if (device.firmware_version !== firmware.version) {
        const result = db.createOtaTask(device.id, firmware_id);
        tasks.push({
          device_id: device.id,
          mac_address: device.mac_address,
          ota_id: result.lastInsertRowid
        });

        // Enviar comando al dispositivo
        sendCommandToDevice(device.mac_address, {
          action: 'ota_update',
          ota_id: result.lastInsertRowid,
          version: firmware.version,
          filename: firmware.filename,
          checksum: firmware.checksum,
          filesize: firmware.filesize
        });
      }
    }

    return {
      success: true,
      tasks_created: tasks.length,
      tasks
    };
  });

  // ============================================
  // DESCARGA DE FIRMWARE (para ESP32)
  // ============================================

  // Endpoint para que el ESP32 descargue el firmware
  fastify.get('/download/:filename', async (request, reply) => {
    const { filename } = request.params;
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
  fastify.get('/check/:mac', async (request, reply) => {
    const { mac } = request.params;

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
  fastify.post('/status', async (request, reply) => {
    const { ota_id, status, error } = request.body;

    db.updateOtaTask(ota_id, status, error);

    return { success: true };
  });
}

module.exports = otaRoutes;
