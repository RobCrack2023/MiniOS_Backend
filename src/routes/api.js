const db = require('../db/database');
const { sendCommandToDevice, sendOrQueueCommand, broadcastToDashboards } = require('../websocket');
const { removeDeviceRecordingFiles } = require('../audioStore');

// ============================================
// ESQUEMAS DE VALIDACION
// Fastify valida y convierte los tipos antes del handler; sin esto un ?limit=abc
// llegaba como NaN a SQLite (500) y cualquier pin o modo se reenviaba tal cual
// al ESP32.
// ============================================

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } }
};

const idPinParams = {
  type: 'object',
  required: ['id', 'pin'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    pin: { type: 'integer', minimum: 0, maximum: 48 }
  }
};

const gpioBody = {
  type: 'object',
  required: ['pin', 'mode'],
  properties: {
    pin: { type: 'integer', minimum: 0, maximum: 48 },
    mode: { type: 'string', enum: ['OUTPUT', 'INPUT', 'INPUT_PULLUP', 'PWM'] },
    name: { type: 'string', maxLength: 64 },
    value: { type: 'integer', minimum: 0, maximum: 4095 },
    pwm_frequency: { type: 'integer', minimum: 1, maximum: 40000000 },
    loop_enabled: { type: 'boolean' },
    loop_interval: { type: 'integer', minimum: 50, maximum: 3600000 },
    formula_enabled: { type: 'boolean' },
    formula_type: { type: ['string', 'null'], maxLength: 32 },
    formula_min: { type: 'number' },
    formula_max: { type: 'number' },
    unit: { type: 'string', maxLength: 16 },
    active: { type: 'boolean' }
  }
};

const dhtBody = {
  type: 'object',
  required: ['pin'],
  properties: {
    pin: { type: 'integer', minimum: 0, maximum: 48 },
    name: { type: 'string', maxLength: 64 },
    sensor_type: { type: 'string', enum: ['DHT11', 'DHT22'] },
    read_interval: { type: 'integer', minimum: 1000, maximum: 3600000 },
    active: { type: 'boolean' }
  }
};

const i2cBody = {
  type: 'object',
  required: ['sensor_type', 'i2c_address'],
  properties: {
    sensor_type: { type: 'string', maxLength: 32 },
    i2c_address: { type: 'integer', minimum: 1, maximum: 127 },
    name: { type: 'string', maxLength: 64 },
    read_interval: { type: 'integer', minimum: 1000, maximum: 3600000 },
    active: { type: 'boolean' }
  }
};

const ultrasonicBody = {
  type: 'object',
  required: ['trig_pin', 'echo_pin'],
  properties: {
    trig_pin: { type: 'integer', minimum: 0, maximum: 48 },
    echo_pin: { type: 'integer', minimum: 0, maximum: 48 },
    name: { type: 'string', maxLength: 64 },
    max_distance: { type: 'integer', minimum: 1, maximum: 1000 },
    read_interval: { type: 'integer', minimum: 50, maximum: 3600000 },
    detection_enabled: { type: 'boolean' },
    trigger_distance: { type: 'integer', minimum: 1, maximum: 1000 },
    trigger_gpio_pin: { type: ['integer', 'null'], minimum: 0, maximum: 48 },
    trigger_gpio_value: { type: 'integer', minimum: 0, maximum: 1 },
    trigger_duration: { type: 'integer', minimum: 0, maximum: 3600000 },
    active: { type: 'boolean' }
  }
};

const dataQuery = {
  type: 'object',
  properties: {
    type: { type: 'string', maxLength: 32 },
    limit: { type: 'integer', minimum: 1, maximum: 50000, default: 100 },
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 }
  }
};

const exportQuery = {
  type: 'object',
  properties: {
    type: { type: 'string', maxLength: 32 },
    limit: { type: 'integer', minimum: 1, maximum: 50000, default: 10000 },
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 }
  }
};

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
  fastify.get('/devices/:id', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const device = db.getDeviceById(request.params.id);
    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    // Incluir configuraciones
    const gpioConfigs = db.getGpioConfigs(device.id);
    const dhtConfigs = db.getDhtConfigs(device.id);
    const i2cConfigs = db.getI2cConfigs(device.id);
    const ultrasonicConfigs = db.getUltrasonicConfigs(device.id);

    return {
      device,
      gpio: gpioConfigs,
      dht: dhtConfigs,
      i2c: i2cConfigs,
      ultrasonic: ultrasonicConfigs
    };
  });

  // Actualizar dispositivo
  fastify.put('/devices/:id', {
    schema: {
      params: idParam,
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: 256 },
          sleep_interval: { type: 'integer', minimum: 0, maximum: 86400000 },
          board_model: { type: 'string', maxLength: 32 },
          board_family: { type: 'string', maxLength: 32 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const updated = db.updateDevice(id, request.body);

    // Si se actualizó el sleep_interval, enviar/encolar comando al dispositivo
    if (request.body.sleep_interval !== undefined) {
      sendOrQueueCommand(device.id, device.mac_address, {
        action: 'set_sleep_interval',
        sleep_interval: request.body.sleep_interval
      });
    }

    return { device: updated };
  });

  // Eliminar dispositivo
  fastify.delete('/devices/:id', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const { id } = request.params;
    // El CASCADE borra las filas de audio_recordings, pero no los WAV del disco
    removeDeviceRecordingFiles(id);
    db.deleteDevice(id);
    return { success: true };
  });

  // ============================================
  // GPIO
  // ============================================

  // Obtener configuración GPIO de un dispositivo
  fastify.get('/devices/:id/gpio', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const configs = db.getGpioConfigs(request.params.id);
    return { gpio: configs };
  });

  // Configurar GPIO
  fastify.post('/devices/:id/gpio', {
    schema: { params: idParam, body: gpioBody }
  }, async (request, reply) => {
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
  fastify.delete('/devices/:id/gpio/:pin', {
    schema: { params: idPinParams }
  }, async (request, reply) => {
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
  fastify.post('/devices/:id/gpio/:pin/set', {
    schema: {
      params: idPinParams,
      body: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'integer', minimum: 0, maximum: 4095 } }
      }
    }
  }, async (request, reply) => {
    const { id, pin } = request.params;
    const { value } = request.body;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const command = { action: 'set_gpio', pin: parseInt(pin), value };
    const sent = sendOrQueueCommand(device.id, device.mac_address, command);

    return { success: true, queued: !sent };
  });

  // ============================================
  // DHT
  // ============================================

  // Obtener configuración DHT
  fastify.get('/devices/:id/dht', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const configs = db.getDhtConfigs(request.params.id);
    return { dht: configs };
  });

  // Configurar DHT
  fastify.post('/devices/:id/dht', {
    schema: { params: idParam, body: dhtBody }
  }, async (request, reply) => {
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
  fastify.delete('/devices/:id/dht/:pin', {
    schema: { params: idPinParams }
  }, async (request, reply) => {
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
  fastify.get('/devices/:id/i2c', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const configs = db.getI2cConfigs(request.params.id);
    return { i2c: configs };
  });

  // Configurar sensor I2C
  fastify.post('/devices/:id/i2c', {
    schema: { params: idParam, body: i2cBody }
  }, async (request, reply) => {
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
  fastify.delete('/devices/:id/i2c/:address', {
    schema: {
      params: {
        type: 'object',
        required: ['id', 'address'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          address: { type: 'integer', minimum: 1, maximum: 127 }
        }
      }
    }
  }, async (request, reply) => {
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
  fastify.post('/devices/:id/i2c/scan', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const { id } = request.params;
    const device = db.getDeviceById(id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    // Enviar comando al ESP32 para escanear el bus I2C
    const sent = sendOrQueueCommand(device.id, device.mac_address, {
      action: 'scan_i2c'
    });

    return {
      success: true,
      queued: !sent,
      message: sent ? 'Escaneo I2C solicitado' : 'Dispositivo offline — escaneo encolado para próxima conexión'
    };
  });

  // ============================================
  // ULTRASONIC (HC-SR04)
  // ============================================

  // Obtener configuración de sensores ultrasónicos
  fastify.get('/devices/:id/ultrasonic', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const configs = db.getUltrasonicConfigs(request.params.id);
    return { ultrasonic: configs };
  });

  // Configurar sensor ultrasónico
  fastify.post('/devices/:id/ultrasonic', {
    schema: { params: idParam, body: ultrasonicBody }
  }, async (request, reply) => {
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
  fastify.delete('/devices/:id/ultrasonic/:ultrasonicId', {
    schema: {
      params: {
        type: 'object',
        required: ['id', 'ultrasonicId'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          ultrasonicId: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
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
  fastify.get('/devices/:id/data', {
    schema: { params: idParam, querystring: dataQuery }
  }, async (request, reply) => {
    const { id } = request.params;
    const { type, limit, from, to } = request.query;

    const data = db.getSensorData(id, type || null, limit, from || null, to || null);
    const total = db.countSensorData(id, type || null, from || null, to || null);

    // truncated avisa de que hay más lecturas de las devueltas: antes una consulta
    // con rango de fechas recortaba a 10.000 filas sin decirlo
    return { data, total, truncated: total > data.length };
  });

  // Exportar datos históricos como CSV
  fastify.get('/devices/:id/data/export', {
    schema: { params: idParam, querystring: exportQuery }
  }, async (request, reply) => {
    const { id } = request.params;
    const { type, limit, from, to } = request.query;
    const data = db.getSensorData(id, type || null, limit, from || null, to || null);

    // Prefijo defensivo contra la inyección de fórmulas al abrir el CSV en Excel
    const csvCell = value => {
      const text = value === null || value === undefined ? '' : String(value);
      return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    };

    const header = 'fecha,sensor,pin,valor\n';
    const rows = data.map(r =>
      [r.recorded_at, csvCell(r.sensor_type), r.sensor_pin ?? '', r.value].join(',')
    ).join('\n');

    const device = db.getDeviceById(id);
    const deviceName = (device?.name || `device_${id}`).replace(/[^a-z0-9]/gi, '_');
    const dateTag = new Date().toISOString().slice(0, 10);

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${deviceName}_${dateTag}.csv"`)
      .send(header + rows);
  });

  // Obtener resumen de datos (última lectura de cada tipo)
  fastify.get('/devices/:id/summary', {
    schema: { params: idParam }
  }, async (request, reply) => {
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
  fastify.post('/devices/:id/reboot', {
    schema: { params: idParam }
  }, async (request, reply) => {
    const device = db.getDeviceById(request.params.id);

    if (!device) {
      return reply.status(404).send({ error: 'Dispositivo no encontrado' });
    }

    const command = { action: 'reboot' };
    const sent = sendOrQueueCommand(device.id, device.mac_address, command);

    return {
      success: true,
      queued: !sent,
      message: sent ? 'Comando de reinicio enviado' : 'Dispositivo offline — reinicio encolado para próxima conexión'
    };
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

  // ============================================
  // CONFIGURACIÓN DEL SISTEMA
  // ============================================

  // Obtener configuración de timezone
  fastify.get('/settings/timezone', async (request, reply) => {
    const timezone = db.getSetting('timezone') || 'America/Santiago';
    return { timezone };
  });

  // Actualizar timezone
  fastify.put('/settings/timezone', {
    schema: {
      body: {
        type: 'object',
        required: ['timezone'],
        properties: { timezone: { type: 'string', minLength: 1, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const { timezone } = request.body;

    if (!timezone) {
      return reply.status(400).send({ error: 'Se requiere el campo timezone' });
    }

    // Validar que sea una timezone válida
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch (error) {
      return reply.status(400).send({ error: 'Timezone inválida' });
    }

    db.setSetting('timezone', timezone);

    return {
      success: true,
      timezone,
      message: 'Timezone actualizada. El dashboard mostrará los horarios en la zona seleccionada.'
    };
  });

  // Obtener todas las configuraciones
  fastify.get('/settings', async (request, reply) => {
    const settings = db.getAllSettings();
    const settingsObj = {};
    settings.forEach(s => {
      settingsObj[s.key] = s.value;
    });
    return { settings: settingsObj };
  });
}

module.exports = apiRoutes;
