const db = require('../db/database');
const { sendCommandToDevice, broadcastToDashboards } = require('../websocket');

async function apiRoutes(fastify, options) {

  // Middleware de autenticación para todas las rutas
  fastify.addHook('preHandler', fastify.authenticate);

  // ============================================
  // DISPOSITIVOS
  // ============================================

  // Listar todos los dispositivos
  fastify.get('/devices', async (request, reply) => {
    const devices = db.getDevices();
    return { devices };
  });

  // Obtener dispositivo por ID
  fastify.get('/devices/:id', async (request, reply) => {
    const device = db.getDeviceById(request.params.id);
    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    // Incluir configuraciones
    const gpioConfigs = db.getGpioConfigs(device.id);
    const dhtConfigs = db.getDhtConfigs(device.id);
    const ultrasonicConfigs = db.getUltrasonicConfigs(device.id);

    return {
      device,
      gpio: gpioConfigs,
      dht: dhtConfigs,
      ultrasonic: ultrasonicConfigs
    };
  });

  // Actualizar dispositivo
  fastify.put('/devices/:id', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const updated = db.updateDevice(id, request.body);
    return { device: updated };
  });

  // Eliminar dispositivo
  fastify.delete('/devices/:id', async (request, reply) => {
    const { id } = request.params;
    db.deleteDevice(id);
    return { success: true };
  });

  // ============================================
  // GPIO
  // ============================================

  // Obtener configuración GPIO de un dispositivo
  fastify.get('/devices/:id/gpio', async (request, reply) => {
    const configs = db.getGpioConfigs(request.params.id);
    return { gpio: configs };
  });

  // Configurar GPIO
  fastify.post('/devices/:id/gpio', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.setGpioConfig(id, request.body);

    // Enviar configuración al dispositivo
    const configs = db.getGpioConfigs(id);
    sendCommandToDevice(device.mac_address, {
      action: 'update_gpio',
      gpio: configs
    });

    return { success: true, gpio: configs };
  });

  // Eliminar configuración GPIO
  fastify.delete('/devices/:id/gpio/:pin', async (request, reply) => {
    const { id, pin } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.deleteGpioConfig(id, parseInt(pin));

    // Notificar al dispositivo
    sendCommandToDevice(device.mac_address, {
      action: 'remove_gpio',
      pin: parseInt(pin)
    });

    return { success: true };
  });

  // Comando directo a GPIO (set value)
  fastify.post('/devices/:id/gpio/:pin/set', async (request, reply) => {
    const { id, pin } = request.params;
    const { value } = request.body;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const sent = sendCommandToDevice(device.mac_address, {
      action: 'set_gpio',
      pin: parseInt(pin),
      value
    });

    if (!sent) {
      return reply.status(503).send({ error: 'Dispositivo no conectado' });
    }

    return { success: true };
  });

  // ============================================
  // DHT
  // ============================================

  // Obtener configuración DHT
  fastify.get('/devices/:id/dht', async (request, reply) => {
    const configs = db.getDhtConfigs(request.params.id);
    return { dht: configs };
  });

  // Configurar DHT
  fastify.post('/devices/:id/dht', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.setDhtConfig(id, request.body);

    // Enviar configuración al dispositivo
    const configs = db.getDhtConfigs(id);
    sendCommandToDevice(device.mac_address, {
      action: 'update_dht',
      dht: configs
    });

    return { success: true, dht: configs };
  });

  // Eliminar sensor DHT
  fastify.delete('/devices/:id/dht/:pin', async (request, reply) => {
    const { id, pin } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.deleteDhtConfig(id, parseInt(pin));

    sendCommandToDevice(device.mac_address, {
      action: 'remove_dht',
      pin: parseInt(pin)
    });

    return { success: true };
  });

  // ============================================
  // I2C SENSORS (AHT20, BMP280, etc.)
  // ============================================

  // Obtener configuración de sensores I2C
  fastify.get('/devices/:id/i2c', async (request, reply) => {
    const configs = db.getI2cConfigs(request.params.id);
    return { i2c: configs };
  });

  // Configurar sensor I2C
  fastify.post('/devices/:id/i2c', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.setI2cConfig(id, request.body);

    // Enviar configuración al dispositivo
    const configs = db.getI2cConfigs(id);
    sendCommandToDevice(device.mac_address, {
      action: 'update_i2c',
      i2c: configs
    });

    return { success: true, i2c: configs };
  });

  // Eliminar sensor I2C
  fastify.delete('/devices/:id/i2c/:address', async (request, reply) => {
    const { id, address } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.deleteI2cConfig(id, parseInt(address));

    sendCommandToDevice(device.mac_address, {
      action: 'remove_i2c',
      i2c_address: parseInt(address)
    });

    return { success: true };
  });

  // Solicitar escaneo del bus I2C
  fastify.post('/devices/:id/i2c/scan', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    // Enviar comando al ESP32 para escanear el bus I2C
    sendCommandToDevice(device.mac_address, {
      type: 'scan_i2c'
    });

    return { success: true, message: 'Escaneo I2C solicitado' };
  });

  // ============================================
  // ULTRASONIC (HC-SR04)
  // ============================================

  // Obtener configuración de sensores ultrasónicos
  fastify.get('/devices/:id/ultrasonic', async (request, reply) => {
    const configs = db.getUltrasonicConfigs(request.params.id);
    return { ultrasonic: configs };
  });

  // Configurar sensor ultrasónico
  fastify.post('/devices/:id/ultrasonic', async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    // Validar pines requeridos
    if (!request.body.trig_pin || !request.body.echo_pin) {
      return reply.status(400).send({ error: 'Se requieren trig_pin y echo_pin' });
    }

    db.setUltrasonicConfig(id, request.body);

    // Enviar configuración al dispositivo
    const configs = db.getUltrasonicConfigs(id);
    sendCommandToDevice(device.mac_address, {
      action: 'update_ultrasonic',
      ultrasonic: configs
    });

    return { success: true, ultrasonic: configs };
  });

  // Eliminar sensor ultrasónico
  fastify.delete('/devices/:id/ultrasonic/:ultrasonicId', async (request, reply) => {
    const { id, ultrasonicId } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    db.deleteUltrasonicConfig(id, parseInt(ultrasonicId));

    // Enviar configuración actualizada al dispositivo
    const configs = db.getUltrasonicConfigs(id);
    sendCommandToDevice(device.mac_address, {
      action: 'update_ultrasonic',
      ultrasonic: configs
    });

    return { success: true };
  });

  // ============================================
  // SENSOR DATA
  // ============================================

  // Obtener datos históricos
  fastify.get('/devices/:id/data', async (request, reply) => {
    const { id } = request.params;
    const { type, limit = 100 } = request.query;

    const data = db.getSensorData(id, type || null, parseInt(limit));
    return { data };
  });

  // Obtener resumen de datos (última lectura de cada tipo)
  fastify.get('/devices/:id/summary', async (request, reply) => {
    const { id } = request.params;

    const temperature = db.getSensorData(id, 'temperature', 1)[0];
    const humidity = db.getSensorData(id, 'humidity', 1)[0];
    const gpio = db.getSensorData(id, 'gpio', 20);

    return {
      temperature: temperature?.value,
      humidity: humidity?.value,
      gpio,
      timestamp: temperature?.recorded_at || humidity?.recorded_at
    };
  });

  // ============================================
  // COMANDOS GENERALES
  // ============================================

  // Reiniciar dispositivo
  fastify.post('/devices/:id/reboot', async (request, reply) => {
    const device = db.getDeviceById(request.params.id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const sent = sendCommandToDevice(device.mac_address, {
      action: 'reboot'
    });

    if (!sent) {
      return reply.status(503).send({ error: 'Dispositivo no conectado' });
    }

    return { success: true, message: 'Comando de reinicio enviado' };
  });

  // Obtener información del sistema
  fastify.get('/system/stats', async (request, reply) => {
    const devices = db.getDevices();
    const online = devices.filter(d => d.is_online).length;
    const firmware = db.getFirmwareList();

    return {
      total_devices: devices.length,
      online_devices: online,
      offline_devices: devices.length - online,
      firmware_versions: firmware.length
    };
  });
}

module.exports = apiRoutes;
